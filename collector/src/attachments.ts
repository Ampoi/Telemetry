import { mkdirSync, realpathSync, lstatSync, existsSync, rmSync, renameSync, openSync, writeSync, closeSync, fsyncSync, statfsSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import { safeError, type Attachment } from './model.ts';

export function cdnUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname) && !u.username && !u.password && (!u.port || u.port === '443'); } catch { return false; }
}
export function media(a: Attachment): boolean { return /^(image|video)\//i.test(a.content_type ?? '') || /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|mp4|webm|mov|m4v|avi|mkv)$/i.test(a.filename); }
export function safePath(root: string, path: string): string {
  const base = realpathSync(root), target = resolve(base, path), rel = relative(base, target);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new Error('unsafe_path');
  let current = base;
  for (const component of rel.split(sep)) { current = resolve(current, component); try { if (lstatSync(current).isSymbolicLink()) throw new Error('unsafe_path'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  return target;
}
class DownloadError extends Error { constructor(readonly reason: string, readonly retry = false, readonly refresh = false, readonly wait = 0) { super(reason); } }
export class Attachments {
  private running = new Map<string, Promise<void>>();
  private stopping = false;
  private abort = new AbortController();
  constructor(readonly config: Config, readonly store: Store, readonly refresh: (message: string) => Promise<void>, readonly request: typeof fetch = fetch) {
    mkdirSync(config.attachments, { recursive: true });
    // Only this collector's UUID partial files; no recursion through arbitrary directories.
    for (const directory of readdirSync(config.attachments, { withFileTypes: true })) if (directory.isDirectory() && /^\d{1,20}$/.test(directory.name)) {
      const path = safePath(config.attachments, directory.name);
      for (const file of readdirSync(path)) if (/^\d{1,20}\.[a-f0-9-]{36}\.part$/.test(file)) store.queueCleanup(`${directory.name}/${file}`);
    }
  }
  cleanup() {
    for (const path of this.store.cleanupPaths()) {
      try { rmSync(safePath(this.config.attachments, path), { force: true }); this.store.finishCleanup(path); }
      catch { /* Durable queue: retry on the next pump without leaking paths or content. */ }
    }
  }
  pump() {
    if (this.stopping) return;
    this.cleanup();
    for (const a of this.store.pending()) {
      if (this.running.size >= this.config.concurrency) break;
      if (this.running.has(a.attachment_id)) continue;
      const task = this.download(a.attachment_id).catch(() => { this.store.updateAttachment(a.attachment_id, { status: 'failed', reason: 'internal_error' }); }).finally(() => { this.running.delete(a.attachment_id); this.pump(); });
      this.running.set(a.attachment_id, task);
    }
  }
  async idle() { while (this.running.size) await Promise.all(this.running.values()); }
  async close() { this.stopping = true; this.abort.abort(); await this.idle(); this.cleanup(); }
  private async download(key: string) {
    let last = 'download_failed';
    for (let attempt = 0; attempt <= this.config.retries && !this.stopping; attempt++) {
      const a = this.store.attachment(key); if (!a) return;
      if (!media(a)) { this.store.updateAttachment(key, { status: 'not_media', reason: 'unsupported_media_type' }); return; }
      if (a.size > this.config.maxBytes) { this.store.updateAttachment(key, { status: 'too_large', reason: 'declared_size_limit' }); return; }
      if (!cdnUrl(a.url)) { this.store.updateAttachment(key, { status: 'failed', reason: 'untrusted_url' }); return; }
      this.store.updateAttachment(key, { status: 'downloading', attempts: (a.attempts ?? 0) + 1 });
      let part: string | undefined, fd: number | undefined;
      try {
        const rel = `${a.message_id}/${a.attachment_id}`, target = safePath(this.config.attachments, rel);
        mkdirSync(dirname(target), { recursive: true });
        safePath(this.config.attachments, rel);
        const space = statfsSync(dirname(target));
        if (space.bavail * space.bsize - a.size < this.config.minFree) throw new DownloadError('disk_space');
        const response = await this.request(a.url, { redirect: 'manual', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.config.timeout)]) });
        if (!response.ok) {
          await response.body?.cancel();
          const retry = response.status === 408 || response.status === 429 || response.status >= 500 || [403, 404].includes(response.status);
          throw new DownloadError(`http_${response.status}`, retry, [403, 404].includes(response.status), Math.min(30, Math.max(0, Number(response.headers.get('retry-after')) || 0)) * 1000);
        }
        const length = Number(response.headers.get('content-length'));
        if (length > this.config.maxBytes) { await response.body?.cancel(); throw new DownloadError('too_large'); }
        part = target + '.' + randomUUID() + '.part'; fd = openSync(part, 'wx', 0o600);
        if (!response.body) throw new DownloadError('empty_body', true);
        let received = 0;
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > this.config.maxBytes) throw new DownloadError('too_large');
          const available = statfsSync(dirname(target));
          if (available.bavail * available.bsize - chunk.length < this.config.minFree) throw new DownloadError('disk_space');
          writeSync(fd, chunk);
        }
        fsyncSync(fd); closeSync(fd); fd = undefined;
        // No await from final recheck through rename and DB update: a deletion cannot interleave.
        const current = this.store.attachment(key);
        if (!current || current.message_id !== a.message_id) return;
        safePath(this.config.attachments, rel);
        renameSync(part, target); part = undefined;
        this.store.updateAttachment(key, { status: 'saved', path: target, reason: null }); return;
      } catch (error) {
        last = error instanceof DownloadError ? error.reason : (error as NodeJS.ErrnoException).code === 'ENOSPC' ? 'disk_space' : safeError(error);
        if (this.stopping) { this.store.updateAttachment(key, { status: 'pending', reason: 'interrupted' }); return; }
        if (error instanceof DownloadError && !error.retry) break;
        if (attempt >= this.config.retries) break;
        if (error instanceof DownloadError && error.refresh) await this.refresh(a.message_id!).catch(() => {});
        await delay(error instanceof DownloadError && error.wait ? error.wait : Math.min(5000, 250 * 2 ** attempt), undefined, { signal: this.abort.signal }).catch(() => {});
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (part) { try { rmSync(part, { force: true }); } catch { this.store.queueCleanup(relative(this.config.attachments, part)); } }
      }
    }
    this.store.updateAttachment(key, { status: this.stopping ? 'pending' : last === 'too_large' ? 'too_large' : last === 'disk_space' ? 'disk_full' : 'failed', reason: this.stopping ? 'interrupted' : last });
  }
}
