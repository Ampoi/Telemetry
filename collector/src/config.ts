import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';

export interface Config {
  guild: string; token: string; channels: Map<string, string | null>;
  database: string; attachments: string; exports: string;
  maxBytes: number; concurrency: number; timeout: number; retries: number; minFree: number;
  includeBots: boolean; includeWebhooks: boolean; recoverySeconds: number;
  controlMode: 'worker' | 'gateway'; origin: string; apiKey: string;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value) || BigInt(value) <= 0n || BigInt(value) >= 2n ** 64n) throw new Error('Discord IDは引用符で囲んだ数値文字列にしてください');
  return BigInt(value).toString();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('設定はマッピングにしてください');
  return value as Record<string, unknown>;
}
export function loadConfig(path: string, envFile: string, requireToken = false): Config {
  let local: Record<string, string | undefined> = {};
  try { local = parseEnv(readFileSync(envFile, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('環境設定ファイルを読めません'); }
  const env = { ...local, ...process.env };
  let data: Record<string, unknown>;
  try { data = object(parse(readFileSync(path, 'utf8'))); } catch { throw new Error('YAML設定を読めません。config.example.yamlを確認してください'); }
  if (!Array.isArray(data.channels) || !data.channels.length) throw new Error('channelsを指定してください');
  const channels = new Map<string, string | null>();
  for (const value of data.channels) {
    const item = object(value), key = id(item.id);
    if (channels.has(key)) throw new Error('channels.idが重複しています');
    if (item.department != null && typeof item.department !== 'string') throw new Error('departmentは文字列です');
    channels.set(key, item.department as string | null ?? null);
  }
  const storage = object(data.storage ?? {}), attachment = object(data.attachments ?? {}), collection = object(data.collection ?? {}), control = object(data.control ?? {});
  const number = (section: Record<string, unknown>, key: string, fallback: number, min: number, max: number, integer = false) => {
    const v = section[key] ?? fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new Error(`${key}が範囲外です`);
    return v;
  };
  const flag = (key: string) => { const v = collection[key] ?? false; if (typeof v !== 'boolean') throw new Error(`${key}はtrue/falseです`); return v; };
  const localPath = (key: string, fallback: string) => { const v = storage[key] ?? fallback; if (typeof v !== 'string' || !v.trim()) throw new Error(`storage.${key}はパスです`); return resolve(dirname(path), v); };
  const mode = control.mode ?? 'worker';
  if (mode !== 'worker' && mode !== 'gateway') throw new Error('control.modeはworker/gatewayです');
  const token = env.DISCORD_BOT_TOKEN?.trim() ?? '';
  if (requireToken && !token) throw new Error('DISCORD_BOT_TOKENが未設定です');
  const origin = env.APP_ORIGIN ?? 'http://localhost:8787';
  let url: URL; try { url = new URL(origin); } catch { throw new Error('APP_ORIGINが不正です'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('APP_ORIGINはHTTPSまたはlocalhostのオリジンにしてください');
  if (requireToken && mode === 'worker' && (env.DEMO_API_KEY?.length ?? 0) < 32) throw new Error('workerモードにはDEMO_API_KEYが必要です');
  return { guild: id(env.DISCORD_GUILD_ID), token, channels,
    database: localPath('database', 'data/telemetry-ts.sqlite3'), attachments: localPath('attachments', 'data/attachments'), exports: localPath('exports', 'data/exports'),
    maxBytes: Math.floor(number(attachment, 'max_size_mib', 100, .001, 1048576) * 1024 ** 2),
    concurrency: number(attachment, 'concurrency', 2, 1, 16, true), timeout: number(attachment, 'timeout_seconds', 60, 1, 3600) * 1000,
    retries: number(attachment, 'retries', 3, 0, 10, true), minFree: Math.floor(number(attachment, 'min_free_mib', 256, 0, 1048576) * 1024 ** 2),
    includeBots: flag('include_bots'), includeWebhooks: flag('include_webhooks'), recoverySeconds: number(collection, 'reconnect_interval_seconds', 300, 30, 86400, true),
    controlMode: mode, origin: url.origin, apiKey: env.DEMO_API_KEY ?? '' };
}
