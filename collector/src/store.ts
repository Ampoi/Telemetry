import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { id } from './config.ts';
import { iso, type Attachment, type RecordData } from './model.ts';

type Row = { data: string; deleted: number; observed: string };
export class RunLock {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path + '.run-lock');
    try { this.db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lock (id INTEGER); BEGIN EXCLUSIVE;'); }
    catch { this.db.close(); throw new Error('同じDBの収集プロセスが既に実行中です'); }
  }
  close() { this.db.close(); }
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, readonly guild: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Refuse Python's schema rather than accidentally migrating a production database.
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE name='messages'").get() && !this.db.prepare("SELECT name FROM sqlite_master WHERE name='ts_schema'").get()) { this.db.close(); throw new Error('TS版には新しいDBパスを指定してください。Python版はJSONLで参照できます'); }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS ts_schema(version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel TEXT NOT NULL,created TEXT NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,observed TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS messages_created ON messages(created,id);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,message TEXT NOT NULL REFERENCES messages(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup(path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS cursors(kind TEXT NOT NULL,channel TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,channel));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,started TEXT NOT NULL,finished TEXT,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_channels(job TEXT NOT NULL,channel TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,state TEXT NOT NULL,error TEXT,PRIMARY KEY(job,channel));
      CREATE TABLE IF NOT EXISTS controls(id TEXT PRIMARY KEY,result TEXT NOT NULL);
    `);
    try {
      this.transaction(() => {
        const stored = this.meta('guild');
        if (stored && stored !== guild) throw new Error('このDBは別のサーバー専用です');
        this.setMeta('guild', id(guild));
        this.db.prepare('INSERT INTO ts_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ts_schema)').run();
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  meta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value; }
  setMeta(key: string, value: string) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  get(key: string): RecordData | undefined {
    const row = this.db.prepare('SELECT data,deleted FROM messages WHERE id=?').get(key) as Row | undefined;
    if (!row) return;
    return { deleted_at: null, ...JSON.parse(row.data), deleted: !!row.deleted, attachments: this.attachments(key) };
  }
  attachments(message: string): Attachment[] { return (this.db.prepare('SELECT data FROM attachments WHERE message=? ORDER BY length(id),id').all(message) as { data: string }[]).map(r => JSON.parse(r.data)); }
  attachment(key: string): Attachment | undefined { const row = this.db.prepare('SELECT data FROM attachments WHERE id=?').get(key) as { data: string } | undefined; return row ? JSON.parse(row.data) : undefined; }
  private validate(record: RecordData) {
    id(record.message_id); id(record.channel_id);
    if (record.guild_id !== this.guild) throw new Error('Guild mismatch');
    record.created_at = iso(record.created_at);
    if (record.edited_at) record.edited_at = iso(record.edited_at);
    const seen = new Set<string>();
    for (const a of record.attachments ?? []) {
      id(a.attachment_id);
      if (seen.has(a.attachment_id) || !Number.isSafeInteger(a.size) || a.size < 0 || typeof a.filename !== 'string' || typeof a.url !== 'string') throw new Error('Invalid attachment');
      seen.add(a.attachment_id);
      const previous = this.attachment(a.attachment_id);
      if (previous && previous.message_id !== record.message_id) throw new Error('Attachment owner mismatch');
    }
  }
  private setAttachments(message: string, next: Attachment[]) {
    const keep = new Set(next.map(a => a.attachment_id));
    for (const old of this.attachments(message)) if (!keep.has(old.attachment_id)) {
      this.queueCleanup(old.path ?? `${message}/${old.attachment_id}`);
      this.db.prepare('DELETE FROM attachments WHERE id=?').run(old.attachment_id);
    }
    for (const a of next) {
      const old = this.attachment(a.attachment_id);
      const updated = { ...a, message_id: message, status: old?.status ?? 'pending', path: old?.path ?? null, reason: old?.reason ?? null, attempts: old?.attempts ?? 0 };
      this.db.prepare('INSERT INTO attachments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(a.attachment_id, message, JSON.stringify(updated));
    }
  }
  upsert(input: RecordData, observed = iso(), live = false): boolean {
    const record = structuredClone(input); this.validate(record); observed = iso(observed);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data,deleted,observed FROM messages WHERE id=?').get(record.message_id) as Row | undefined;
      if (row?.deleted || (row && observed <= row.observed)) return false;
      const previous: RecordData | undefined = row ? JSON.parse(row.data) : undefined;
      if (previous && (previous.channel_id !== record.channel_id || previous.created_at !== record.created_at)) throw new Error('Message identity cannot change');
      if (previous && (record.edited_at ?? record.created_at) < (previous.edited_at ?? previous.created_at)) return false;
      const { attachments = [], ...data } = record;
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,observed=excluded.observed')
        .run(record.message_id, record.channel_id, record.created_at, JSON.stringify(data), live ? observed : row?.observed ?? '');
      this.setAttachments(record.message_id, attachments);
      return true;
    });
  }
  patch(key: string, patch: Partial<RecordData>, observed = iso()): boolean {
    const old = this.get(key);
    if (!old || old.deleted) return false;
    // Sparse edits cannot change identity or revive tombstones.
    const allowed: Partial<RecordData> = {};
    if ('content' in patch) allowed.content = patch.content;
    if (patch.edited_at) allowed.edited_at = patch.edited_at;
    if ('attachments' in patch) allowed.attachments = patch.attachments;
    return this.upsert({ ...old, ...allowed }, observed, true);
  }
  delete(key: string, channel: string, at = iso()): void {
    id(key); id(channel);
    this.transaction(() => {
      const old = this.get(key);
      if (old?.deleted) return;
      for (const a of old?.attachments ?? []) this.queueCleanup(a.path ?? `${key}/${a.attachment_id}`);
      this.db.prepare('DELETE FROM attachments WHERE message=?').run(key);
      const created = old?.created_at ?? iso(Number((BigInt(key) >> 22n) + 1420070400000n));
      const data: RecordData = { guild_id: this.guild, channel_id: old?.channel_id ?? channel, message_id: key, created_at: created, collected_at: iso(at), deleted: true, deleted_at: iso(at), jump_url: `https://discord.com/channels/${this.guild}/${old?.channel_id ?? channel}/${key}` };
      this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,deleted=1,observed=excluded.observed').run(key, data.channel_id, created, JSON.stringify(data), iso(at));
    });
  }
  queueCleanup(path: string) { this.db.prepare('INSERT OR IGNORE INTO cleanup VALUES(?)').run(path); }
  cleanupPaths(): string[] { return (this.db.prepare('SELECT path FROM cleanup').all() as { path: string }[]).map(r => r.path); }
  finishCleanup(path: string) { this.db.prepare('DELETE FROM cleanup WHERE path=?').run(path); }
  updateAttachment(key: string, patch: Partial<Attachment>): boolean {
    const a = this.attachment(key); if (!a) return false;
    this.db.prepare('UPDATE attachments SET data=? WHERE id=?').run(JSON.stringify({ ...a, ...patch, attachment_id: a.attachment_id, message_id: a.message_id }), key); return true;
  }
  pending(): Attachment[] { return (this.db.prepare("SELECT data FROM attachments WHERE json_extract(data,'$.status')='pending' LIMIT 128").all() as { data: string }[]).map(r => JSON.parse(r.data)); }
  recover() {
    this.db.exec("UPDATE attachments SET data=json_set(data,'$.status','pending') WHERE json_extract(data,'$.status')='downloading'; UPDATE jobs SET state='interrupted',finished=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state='running'; UPDATE job_channels SET state='interrupted' WHERE state='running';");
  }
  retryAttachments() { this.db.exec("UPDATE attachments SET data=json_set(data,'$.status','pending','$.reason',NULL) WHERE json_extract(data,'$.status') IN ('failed','too_large','disk_full')"); }
  cursor(kind: string, channel: string): string | undefined { return (this.db.prepare('SELECT id FROM cursors WHERE kind=? AND channel=?').get(kind, channel) as { id: string } | undefined)?.id; }
  advance(kind: string, channel: string, value: string) {
    const old = this.cursor(kind, channel); if (old && BigInt(old) >= BigInt(value)) return;
    this.db.prepare('INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(kind,channel) DO UPDATE SET id=excluded.id').run(kind, channel, value);
  }
  channels(): string[] { return (this.db.prepare('SELECT DISTINCT channel FROM messages UNION SELECT channel FROM cursors').all() as { channel: string }[]).map(r => r.channel); }
  startJob(job: string, kind: string) { this.db.prepare("INSERT INTO jobs VALUES(?,?,?,NULL,'running')").run(job, kind, iso()); }
  finishJob(job: string, failed: boolean) { this.db.prepare('UPDATE jobs SET state=?,finished=? WHERE id=?').run(failed ? 'partial' : 'complete', iso(), job); }
  jobChannel(job: string, channel: string, start: string, end: string, state: string, error: string | null = null) {
    this.db.prepare('INSERT INTO job_channels VALUES(?,?,?,?,?,?) ON CONFLICT(job,channel) DO UPDATE SET state=excluded.state,error=excluded.error').run(job, channel, start, end, state, error);
  }
  control(key: string): string | undefined { return (this.db.prepare('SELECT result FROM controls WHERE id=?').get(key) as { result: string } | undefined)?.result; }
  saveControl(key: string, value: string) { this.db.prepare('INSERT INTO controls VALUES(?,?) ON CONFLICT(id) DO UPDATE SET result=excluded.result').run(key, value); }
  status() {
    return { messages: this.db.prepare('SELECT deleted,COUNT(*) AS count FROM messages GROUP BY deleted').all(), attachments: this.db.prepare("SELECT json_extract(data,'$.status') AS status,COUNT(*) AS count FROM attachments GROUP BY status").all(),
      cleanup_pending: this.cleanupPaths().length, last_collected: this.db.prepare("SELECT MAX(json_extract(data,'$.collected_at')) AS value FROM messages").get(),
      jobs: this.db.prepare('SELECT * FROM jobs ORDER BY started DESC LIMIT 10').all(), errors: this.db.prepare("SELECT * FROM job_channels WHERE error IS NOT NULL ORDER BY rowid DESC LIMIT 50").all() };
  }
  exportRecords(start: string, end: string, emit: (record: RecordData) => void) {
    // No await: one consistent snapshot including attachment states, bounded memory.
    this.db.exec('BEGIN');
    try { for (const row of this.db.prepare('SELECT id FROM messages WHERE created>=? AND created<? ORDER BY created,length(id),id').iterate(start, end)) emit(this.get(row.id as string)!); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
