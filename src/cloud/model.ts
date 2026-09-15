import { AppError } from '../errors';

export interface CloudConfig {
  channels: { id: string; department?: string }[];
  include_bots: boolean;
  include_webhooks: boolean;
  overlap_hours: number;
  verify_days: number;
  verify_interval_minutes: number;
  max_attachment_mib: number;
}
export interface Guild { guild: string; bot_id: string; config: string; started: number }
export interface Channel { guild: string; channel: string; parent: string | null; name: string; kind: number; department: string | null; scanned_until: number }
export interface Task { id: string; guild: string; channel: string | null; kind: 'scan' | 'discover' | 'verify' | 'attachment' | 'export'; payload: string; generation: number; lease_until: number; attempts: number; failures: number }
export interface QueueJob { kind: 'collection'; id: string }
export interface RemoteChannel { id: string; guild_id?: string; parent_id?: string; name: string; type: number; thread_metadata?: { archive_timestamp: string } }
export interface RemoteAttachment { id: string; filename: string; content_type?: string; size: number; url: string }
export interface RemoteMessage {
  id: string; channel_id: string; content: string; timestamp: string; edited_timestamp: string | null;
  author: { id: string; username: string; global_name?: string; bot?: boolean };
  member?: { nick?: string }; webhook_id?: string;
  message_reference?: { message_id?: string; channel_id?: string }; attachments: RemoteAttachment[];
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{17,20}$/.test(value) || BigInt(value) >= 2n ** 64n) throw new AppError(400, 'Discord IDは17〜20桁の文字列です。');
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'JSONオブジェクトを指定してください。');
  return value as Record<string, unknown>;
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new AppError(415, 'application/jsonが必要です。');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, '本文が必要です。');
  let text = '', size = 0; const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 32_000) { await reader.cancel(); throw new AppError(413, '本文が大きすぎます。'); }
    text += decoder.decode(value, { stream: true });
  }
  try { return object(JSON.parse(text + decoder.decode())); } catch { throw new AppError(400, 'JSONオブジェクトを指定してください。'); }
}
export function config(value: unknown): CloudConfig {
  const data = object(value);
  if (!Array.isArray(data.channels) || !data.channels.length || data.channels.length > 50) throw new AppError(400, 'channelsは1〜50件です。');
  const channels = data.channels.map(v => { const c = object(v); if (c.department !== undefined && (typeof c.department !== 'string' || c.department.length > 100)) throw new AppError(400, 'departmentは100文字以内です。'); return { id: id(c.id), ...(c.department === undefined ? {} : { department: c.department as string }) }; });
  if (new Set(channels.map(c => c.id)).size !== channels.length) throw new AppError(400, 'チャンネルが重複しています。');
  const num = (key: string, fallback: number, min: number, max: number) => { const v = data[key] ?? fallback; if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new AppError(400, `${key}は${min}〜${max}の整数です。`); return v; };
  const flag = (key: string) => { const v = data[key] ?? false; if (typeof v !== 'boolean') throw new AppError(400, `${key}はbooleanです。`); return v; };
  return { channels, include_bots: flag('include_bots'), include_webhooks: flag('include_webhooks'), overlap_hours: num('overlap_hours',24,1,720), verify_days: num('verify_days',7,1,3650), verify_interval_minutes: num('verify_interval_minutes',60,5,10080), max_attachment_mib: num('max_attachment_mib',100,1,100) };
}
export function iso(value: string | number): string {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new AppError(400, '日時が不正です。');
  const micro = typeof value === 'string' ? value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] : undefined;
  return date.toISOString().replace(/\.(\d{3})Z$/, (_, ms: string) => `.${micro ? micro.padEnd(6,'0').slice(0,6) : ms + '000'}+00:00`);
}
export function bounds(from: unknown, to: unknown): [string,string] {
  const date = (v: unknown) => { if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AppError(400, '日付はYYYY-MM-DDです。'); const d = new Date(v+'T00:00:00Z'); if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== v) throw new AppError(400,'存在しない日付です。'); return iso(d.getTime()-9*3600_000); };
  const start = date(from), end = date(to); if (start >= end) throw new AppError(400, '終了日は開始日より後です（終了日を含みません）。'); return [start,end];
}
export function snowflake(time: number): string { return ((BigInt(Math.max(time,1420070400001))-1420070400000n)<<22n).toString(); }
export function included(message: RemoteMessage, guild: Guild, cfg: CloudConfig): boolean {
  return message.author.id !== guild.bot_id && (message.webhook_id ? cfg.include_webhooks : !message.author.bot || cfg.include_bots);
}
