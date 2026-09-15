import { AppError } from './errors';
import { requireGuildManager } from './discord-guild';
import type { Interaction } from './discord';

export interface MeetingSettings { center_days: number; radius_days: number; channel_id: string | null }
export async function meetingSettings(env: Env, guild: string): Promise<MeetingSettings> {
  return await env.DB.prepare('SELECT center_days,radius_days,channel_id FROM guild_meeting_settings WHERE guild_id=?').bind(guild).first<MeetingSettings>()
    ?? { center_days: 7, radius_days: 2, channel_id: null };
}
export function validateRange(center: number, radius: number): void {
  if (!Number.isInteger(center) || !Number.isInteger(radius) || center < 1 || center > 365 || radius < 0 || radius > 14 || center - radius < 1 || center + radius > 365)
    throw new AppError(400, '中心日は1〜365日後、前後は0〜14日で、候補日が明日〜365日後に収まるよう入力してください。');
}
function panel(s: MeetingSettings, saved = false) {
  return { content: `${saved ? '設定を保存しました。\n\n' : ''}**このサーバーのMTG設定**\n候補日：${s.center_days}日後 ± ${s.radius_days}日（${s.center_days - s.radius_days}〜${s.center_days + s.radius_days}日後・日本時間）\n通知先：${s.channel_id ? `<#${s.channel_id}>` : 'コマンドを実行したチャンネル'}\n変更は次に作成する日程調整から適用されます。募集・日時確定・Docs完成の通知先を共通で設定します。`,
    flags: 64, allowed_mentions: { parse: [] }, components: [
      { type: 1, components: [{ type: 2, style: 1, label: '候補日の範囲を変更', custom_id: 'settings:range' }] },
      { type: 1, components: [{ type: 8, custom_id: 'settings:channel', channel_types: [0, 5], placeholder: 'MTGの通知チャンネルを選択', min_values: 1, max_values: 1, ...(s.channel_id ? { default_values: [{ id: s.channel_id, type: 'channel' }] } : {}) }] },
      { type: 1, components: [{ type: 2, style: 2, label: '通知先を実行チャンネルに戻す', custom_id: 'settings:reset-channel' }] },
    ] };
}
export async function settingsInteraction(i: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const guild = requireGuildManager(i);
  const action = i.data?.custom_id;
  if (i.type === 2 || (i.type === 3 && action === 'settings:range')) {
    const s = await meetingSettings(env, guild);
    if (i.type === 2) return Response.json({ type: 4, data: panel(s) });
    return Response.json({ type: 9, data: { custom_id: 'settings:save-range', title: 'MTG候補日の範囲', components: [
      { type: 1, components: [{ type: 4, custom_id: 'center', label: '何日後を中心にするか（例：7）', style: 1, required: true, max_length: 3, value: String(s.center_days) }] },
      { type: 1, components: [{ type: 4, custom_id: 'radius', label: '前後何日を含めるか（例：3）', style: 1, required: true, max_length: 2, value: String(s.radius_days) }] },
    ] } });
  }
  let range: { center: number; radius: number } | undefined;
  let channel: string | null = null;
  if (i.type === 5 && action === 'settings:save-range') {
    const inputs = i.data?.components?.flatMap(row => row.components ?? []) ?? [];
    const value = (id: string) => { const v = inputs.find(c => c.custom_id === id)?.value; return typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN; };
    range = { center: value('center'), radius: value('radius') };
    validateRange(range.center, range.radius);
  } else if (i.type === 3 && action === 'settings:channel') {
    channel = i.data?.values?.[0] ?? null;
    const resolved = channel ? i.data?.resolved?.channels?.[channel] : undefined;
    if (!channel || !/^\d{17,20}$/.test(channel) || i.data?.values?.length !== 1 || !resolved || ![0, 5].includes(resolved.type)) throw new AppError(400, 'このサーバーのテキストチャンネルを選択してください。');
  } else if (!(i.type === 3 && action === 'settings:reset-channel')) throw new AppError(400, '/settings を開き直してください。');
  // Acknowledge before database writes; each action changes only its own fields.
  ctx.waitUntil((async () => {
    let data: unknown;
    try {
      if (range) await env.DB.prepare('INSERT INTO guild_meeting_settings(guild_id,center_days,radius_days,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET center_days=excluded.center_days,radius_days=excluded.radius_days,updated_by=excluded.updated_by,updated_at=excluded.updated_at')
        .bind(guild, range.center, range.radius, i.member!.user!.id, Date.now()).run();
      else await env.DB.prepare('INSERT INTO guild_meeting_settings(guild_id,channel_id,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,updated_by=excluded.updated_by,updated_at=excluded.updated_at')
        .bind(guild, channel, i.member!.user!.id, Date.now()).run();
      data = panel(await meetingSettings(env, guild), true);
    } catch { data = { content: '設定を保存できませんでした。/settings を開き直して確認してください。', components: [], allowed_mentions: { parse: [] } }; }
    try {
      const response = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${encodeURIComponent(i.token)}/messages/@original`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('ReplyFailed');
    } catch { console.error(JSON.stringify({ event: 'settings_reply_failed', id: i.id })); }
  })());
  return Response.json({ type: 6 });
}
