import { AppError } from './errors';
import { guildOwner } from './discord-guild';
import { accessToken, googleDocs } from './google';
import { minutesText, type MinutesDocument } from './meeting-minutes';
import type { MeetingState } from './meeting-model';

export interface PreviousMinutes { id: string; text: string; url: string }

/** Resolve only this guild's saved agenda tab; never guess from a tab title. */
export async function previousMeetingMinutes(env: Env, state: MeetingState): Promise<PreviousMinutes | null> {
  if (state.previousMeetingId === 'none') return null;
  const explicit = state.previousMeetingId;
  const before = Math.min(state.runAt, Date.now());
  for (let offset = 0; ; offset += 25) {
    const rows = (await env.DB.prepare(`SELECT id,document FROM meeting_reservations
      WHERE guild=? AND document=? AND id<>? ${explicit ? 'AND id=?' : 'AND meeting_at IS NOT NULL AND meeting_at<?'}
      ORDER BY COALESCE(meeting_at,run_at) DESC,id DESC LIMIT 25 OFFSET ?`)
      .bind(state.guild, state.document, state.id, explicit ?? before, offset).all<{ id: string; document: string }>()).results;
    for (const row of rows) {
      const source = await env.MEETINGS.getByName(`${state.guild}:${row.id}`).summary();
      if (!source?.url || !['complete', 'notification_failed', 'notification_review'].includes(source.status)) {
        if (explicit) throw new AppError(400, '前回のアジェンダが完成していません。/mtg status で確認してください。');
        continue;
      }
      if (!explicit && (!source.mode || source.mode === 'debug-agenda' || source.debug || source.sourceArchive !== state.sourceArchive)) continue;
      if ((source.meetingAt ?? source.runAt) > before) {
        if (explicit) throw new AppError(400, '開始前のMTGは前回議事録に指定できません。');
        continue;
      }
      const url = new URL(source.url), tab = url.searchParams.get('tab');
      if (url.origin !== 'https://docs.google.com' || url.pathname !== `/document/d/${row.document}/edit` || !tab) throw new AppError(400, '前回議事録のタブを確認できません。/mtg status で確認してください。');
      const token = await accessToken(env, guildOwner(state.guild));
      const document = await googleDocs<MinutesDocument>(token, `${row.document}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`);
      return { id: row.id, text: minutesText(document, tab), url: source.url };
    }
    if (rows.length < 25) break;
  }
  if (explicit) throw new AppError(400, '同じサーバー・保存先の前回予約IDを指定してください。');
  return null;
}
