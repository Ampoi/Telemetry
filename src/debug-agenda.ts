import { generateAgenda, renderMarkdown, type Message } from './agenda/index';
import { agendaLayout } from './agenda/layout';
import { citationFormatter, citationPattern } from './agenda/citations';
import { AppError } from './errors';
import { mediaUrl } from './cloud/media';
import { docsText, jst, type ImagePart, type MeetingPost, type MeetingState } from './meeting-model';
import { compileMarkdown, contentRequests } from './template';
import { textRequests } from './meeting-model';
import type { PreviousMinutes } from './meeting-previous';

export const DEBUG_MODEL = 'gpt-5.6-luna';
export const DEBUG_EFFORT = 'medium';
export const DEBUG_WEEK = 7 * 86400_000;
export type DebugResult = Awaited<ReturnType<typeof generateAgenda>>;
export type AgendaPart = { kind: 'markdown' | 'image'; value: string };

export function debugWindow(at: number) { return { rangeFrom: at - DEBUG_WEEK, rangeTo: at }; }

export function agendaMessages(posts: MeetingPost[], guild: string): Message[] {
  return posts.map(p => ({ guild_id: guild, channel_id: p.channel_id, message_id: p.id,
    created_at: p.timestamp, edited_at: p.edited_timestamp, content: p.content,
    author_display_name: p.member?.nick ?? p.author.global_name ?? p.author.username,
    department: p.channel_name, reply_to_message_id: p.message_reference?.message_id,
    attachments: p.attachments.map(a => ({ attachment_id: a.id, filename: a.filename.length > 300 ? a.filename.slice(0, 299) + '…' : a.filename, content_type: a.content_type })),
  }));
}

// Bound actual response bytes as well as declared metadata. Credentials are never
// sent to CDN URLs, and redirects are never followed.
async function imageData(url: string): Promise<string> {
  const r = await fetch(mediaUrl(url), { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  const type = r.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (!r.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(type ?? '') || !r.body) {
    await r.body?.cancel(); throw new Error('ImageUnavailable');
  }
  const reader = r.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 3_000_000) { await reader.cancel(); throw new Error('ImageTooLarge'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${type};base64,${btoa(binary)}`;
}

export async function createDebugAgenda(posts: MeetingPost[], state: MeetingState, apiKey: string, previous?: PreviousMinutes): Promise<DebugResult> {
  if (!posts.length && !previous) throw new AppError(400, '対象期間に取得可能な投稿がありません。アジェンダは作成しませんでした。');
  const notes = [`対象期間: ${jst(state.rangeFrom!)} ～ ${jst(state.rangeTo!)} JST（終了時刻を含まない）${state.sourceArchive ? '。過去ログを今回の会議の参考資料として使用。過去の報告を今週の実績と解釈しないでください。' : ''}`];
  if (state.skipped) notes.push(`閲覧できずスキップした取得処理: ${state.skipped}件。収集時点で削除済みの投稿は含みません。`);
  const images: { attachmentId: string; dataUrl: string }[] = [];
  const candidates = posts.flatMap(p => p.attachments).filter(a => a.content_type?.startsWith('image/'));
  let bytes = 0, attempted = 0;
  for (const a of candidates) {
    if (attempted >= 20) break;
    if (a.size > 3_000_000 || !['image/png','image/jpeg','image/webp'].includes(a.content_type ?? '')) continue;
    attempted++;
    try {
      const dataUrl = await imageData(a.url);
      if (bytes + dataUrl.length > 16_000_000) continue;
      images.push({ attachmentId: a.id, dataUrl }); bytes += dataUrl.length;
    } catch { /* Report unavailable images without interpreting their contents. */ }
  }
  if (images.length < candidates.length) notes.push(`画像${candidates.length}件中${images.length}件をAIへ送信。取得不可・形式・サイズ・枚数上限による未確認画像は元投稿リンクで表示します。`);
  // generateAgenda accepts JST dates. The collector already applies the exact
  // rolling window; these enclosing dates cannot admit additional posts.
  const sourceGuild = state.sourceGuild ?? state.guild;
  const result = await generateAgenda({ project: state.projectName ?? 'プロジェクト名要確認', meetingAt: `${jst(state.meetingAt ?? state.runAt)} JST`,
    guildId: sourceGuild, from: jst(state.rangeFrom!).slice(0, 10), to: jst(state.rangeTo! - 1 + 86400_000).slice(0, 10),
    messages: agendaMessages(posts, sourceGuild), images, coverageNotes: notes, previousMinutes: previous?.text, previousMinutesUrl: previous?.url,
  }, { apiKey, model: DEBUG_MODEL, reasoningEffort: DEBUG_EFFORT, maxRequests: state.sourceArchive ? 30 : 12, chunkCharacters: state.sourceArchive ? 100000 : 30000 });
  result.title = state.title;
  return { ...result, markdown: renderMarkdown(result), metadata: { ...result.metadata, from: new Date(state.rangeFrom!).toISOString(), to: new Date(state.rangeTo!).toISOString() } };
}

// Render structured points so images sit next to the statements that cite them.
// Source text is data, not an executable template or arbitrary image URL.
export function agendaParts(result: DebugResult, posts: MeetingPost[]): AgendaPart[] {
  const parts: AgendaPart[] = [];
  const clean = (s: string) => docsText(s).replace(/[\r\n]+/g, ' ');
  const add = (s: string) => parts.push({ kind: 'markdown', value: s + '\n' });
  const media = new Map(posts.flatMap(p => p.attachments.map(a => [a.id, { channel: p.channel_id, message: p.id, attachment: a.id }] as const)));
  const seen = new Set<string>();
  const citations = citationFormatter(result.sources);
  add(`# ${clean(result.title)}`);
  for (const block of agendaLayout(result.agenda)) {
    if ('heading' in block) { add(`${'#'.repeat(block.level)} ${clean(block.heading)}`); continue; }
    add(`${block.bullet ? '- ' : ''}${block.entries.map(({ label, point }) => `${label ? label + '：' : ''}${clean(point.text)} ${citations.sourceIds(point.sourceIds)}`).join('／')}`);
    for (const { point: p } of block.entries) {
      for (const id of p.mediaIds) {
        const a = result.media[id], ref = media.get(id);
        if (!a || !ref || seen.has(id)) continue;
        seen.add(id);
        add(`添付：${clean(a.filename || id)}${a.imageReviewed ? '' : '（内容未確認）'} ${citations.url(a.sourceUrl)}`);
        if (a.imageReviewed && ['image/png','image/jpeg'].includes(a.content_type ?? '')) {
          parts.push({ kind: 'image', value: JSON.stringify(ref satisfies ImagePart) }); add('');
        }
      }
    }
  }
  return parts;
}

/** Keep citation markup intact when a long paragraph spans multiple Docs writes. */
export function splitAgendaText(value: string, limit = 12_000): string[] {
  const refs = [...value.matchAll(citationPattern())];
  const chunks: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + limit, value.length);
    if (end < value.length) {
      const newline = value.lastIndexOf('\n', end - 1);
      if (newline > start) end = newline + 1;
      const ref = refs.find(r => r.index! < end && r.index! + r[0].length > end);
      if (ref) end = ref.index!;
      if (end <= start) throw new Error('CitationTooLong');
      if (/[\ud800-\udbff]/.test(value[end - 1])) end--;
    }
    chunks.push(value.slice(start, end)); start = end;
  }
  return chunks;
}

export function agendaTextRequests(markdown: string, tabId: string, index: number): { text: string; requests: Record<string, unknown>[] } {
  const text = compileMarkdown(markdown).text;
  const styles = contentRequests(markdown, tabId).slice(1).map(r => {
    const op = Object.values(r)[0] as { range: { startIndex: number; endIndex: number } };
    op.range.startIndex += index - 1; op.range.endIndex += index - 1; return r;
  });
  const labels = /(^|／)(成果|注意点|会議の焦点|予定 → 現状|やったこと・結果|分かったこと・考察|課題|次の予定|今回決めたいこと|判断材料|不足情報|関係者|判断期限)：/gm;
  const emphasis = [...text.matchAll(labels)].map(m => ({ updateTextStyle: {
    range: { tabId, startIndex: index + m.index! + m[1].length, endIndex: index + m.index! + m[0].length },
    textStyle: { bold: true }, fields: 'bold',
  } }));
  return { text, requests: [...textRequests(text, tabId, index), ...styles, ...emphasis] };
}
