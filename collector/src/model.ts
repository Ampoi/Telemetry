export interface Attachment {
  attachment_id: string; filename: string; content_type: string | null; size: number; url: string;
  message_id?: string; status?: string; path?: string | null; reason?: string | null; attempts?: number;
}
export interface RecordData {
  guild_id: string; channel_id: string; channel_name?: string; thread_id?: string | null; thread_name?: string | null;
  parent_channel_id?: string | null; message_id: string; author_id?: string; author_display_name?: string;
  content?: string; created_at: string; edited_at?: string | null; collected_at?: string;
  reply_to_message_id?: string | null; reply_to_channel_id?: string | null; jump_url: string; department?: string | null;
  attachments?: Attachment[]; deleted?: boolean; deleted_at?: string | null;
}
let lastObservation = 0n;
export function iso(value?: string | number | Date): string {
  if (value === undefined) {
    const clock = BigInt(Date.now()) * 1000n;
    lastObservation = clock > lastObservation ? clock : lastObservation + 1n;
    return new Date(Number(lastObservation / 1000n)).toISOString().replace(/\.(\d{3})Z$/, (_, ms: string) => `.${ms}${String(lastObservation % 1000n).padStart(3, '0')}+00:00`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  const micro = typeof value === 'string' ? value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] : undefined;
  return date.toISOString().replace(/\.(\d{3})Z$/, (_, ms: string) => `.${micro ? micro.padEnd(6, '0').slice(0, 6) : ms + '000'}+00:00`);
}
export function snowflakeAt(time: number): string { return (((BigInt(Math.floor(time)) - 1420070400000n) << 22n) - 1n).toString(); }
export function safeError(error: unknown): string {
  const e = error as { status?: unknown; code?: unknown; name?: unknown };
  return [typeof e?.name === 'string' && /^[A-Za-z]+$/.test(e.name) ? e.name : 'Error', typeof e?.status === 'number' ? e.status : '', typeof e?.code === 'number' || (typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code)) ? e.code : ''].filter(x => x !== '').join(':');
}
