import { AppError } from './errors';
import { mediaUrl } from './cloud/media';
import type { RemoteMessage } from './cloud/model';

export interface MeetingInput { id: string; guild: string; user: string; runAt: number; title: string; document: string; meetingAt?: number; channel?: string }
export type MeetingStatus = 'scheduled' | 'collecting' | 'preparing' | 'adding' | 'writing' | 'summarizing' | 'notifying' | 'notification_failed' | 'notification_review' | 'complete' | 'failed' | 'needs_review' | 'cancelled';
export interface MeetingState extends MeetingInput {
  status: MeetingStatus; started?: number; finished?: number; error?: string;
  tabId?: string; url?: string; failures: number; skipped: number; imageFallbacks: number;
  cursorCreated: string; cursorId: string; part: number; textIndex: number;
  summaryPart?: number; agendaLines?: string[]; notificationAttempted?: boolean; notificationId?: string;
}
export interface MeetingPost extends RemoteMessage { channel_name: string; parent_id: string | null }
export interface ImagePart { channel: string; message: string; attachment: string }

export function jstTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(value)) throw new AppError(400, '日時は日本時間の YYYY-MM-DD HH:mm で指定してください。');
  const normalized = value.replace('T', ' ');
  const utc = Date.parse(normalized.replace(' ', 'T') + ':00+09:00');
  if (!Number.isFinite(utc) || jst(utc) !== normalized) throw new AppError(400, '存在しない日時です。');
  return utc;
}
export function jst(value: number | string): string {
  return new Date(new Date(value).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}
// Google removes these characters. Replacing them also keeps style indices stable.
export function docsText(value: string): string {
  return value.replaceAll('\r\n', '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ue000-\uf8ff]/gu, '\ufffd');
}
export function splitText(value: string, limit = 12_000): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + limit);
    if (end < value.length) {
      const newline = value.lastIndexOf('\n', end - 1);
      if (newline > offset) end = newline + 1;
    }
    if (end < value.length && /[\ud800-\udbff]/.test(value[end - 1])) end--;
    chunks.push(value.slice(offset, end)); offset = end;
  }
  return chunks;
}
export function postText(guild: string, m: MeetingPost): string {
  const name = m.member?.nick ?? m.author.global_name ?? m.author.username;
  const reply = m.message_reference?.message_id
    ? `返信先: https://discord.com/channels/${guild}/${m.message_reference.channel_id ?? m.channel_id}/${m.message_reference.message_id}\n` : '';
  const attachments = m.attachments.map(a => {
    let url: string; try { url = mediaUrl(a.url); } catch { return `${a.filename}（元投稿から開いてください）`; }
    return `${a.content_type?.startsWith('video/') ? '動画' : '添付'}: ${a.filename}\n${url}`;
  }).join('\n');
  return docsText(`\n[${jst(m.timestamp)} JST] #${m.channel_name} — ${name}\nhttps://discord.com/channels/${guild}/${m.channel_id}/${m.id}\n${reply}${m.content}\n${attachments}${attachments ? '\n' : ''}`);
}
export function embeddable(a: RemoteMessage['attachments'][number]): boolean {
  try { mediaUrl(a.url); } catch { return false; }
  return ['image/png', 'image/jpeg', 'image/gif'].includes(a.content_type ?? '') && a.size < 50_000_000 && a.url.length <= 2048;
}
export function textRequests(text: string, tabId: string, index: number): Record<string, unknown>[] {
  return [
    { insertText: { endOfSegmentLocation: { tabId }, text } },
    ...[...text.matchAll(/https:\/\/[^\s<>]+/gu)].map(match => ({ updateTextStyle: {
      range: { tabId, startIndex: index + match.index, endIndex: index + match.index + match[0].length },
      textStyle: { link: { url: match[0] } }, fields: 'link',
    } })),
  ];
}
