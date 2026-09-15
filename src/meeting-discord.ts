import { AppError } from './errors';
import { guildOwner, requireGuildManager } from './discord-guild';
import { jst } from './meeting-model';
import { appOrigin } from './auth';
import type { Interaction } from './discord';

const labels: Record<string, string> = { scheduled: '予約済み', collecting: '収集中', preparing: '本文準備中', adding: 'タブ作成中', writing: 'Docs書き込み中', summarizing: 'Docs完成・議題要約中', notifying: 'Docs完成・通知中', notification_failed: 'Docs完成・要約または通知失敗', notification_review: 'Docs完成・通知結果の確認が必要', complete: '完了', cancelled: '取消済み', failed: '失敗', needs_review: 'Docsの確認が必要' };
function reply(content: string): Response { return Response.json({ type: 4, data: { content: content.slice(0, 2000), flags: 64, allowed_mentions: { parse: [] } } }); }
const stub = (env: Env, guild: string, id: string) => env.MEETINGS.getByName(`${guild}:${id}`);

export async function meetingInteraction(interaction: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const guild = requireGuildManager(interaction);
  if (env.COLLECTION_MODE !== 'cloud') throw new AppError(400, '/mtgにはクラウド収集モードが必要です。');
  const command = interaction.data?.options?.[0];
  if (command?.type !== 1 || !['schedule', 'status', 'cancel'].includes(command.name)) throw new AppError(400, '/mtg schedule・status・cancelを指定してください。');
  const option = (name: string) => {
    const v = command.options?.find(o => o.name === name);
    if (!v) return '';
    if (v.type !== 3 || typeof v.value !== 'string') throw new AppError(400, `${name}は文字列で指定してください。`);
    return v.value;
  };
  const id = option('id');
  if (id && !/^\d{17,20}$/.test(id)) throw new AppError(400, '予約IDを指定してください。');
  if (command.name === 'cancel' && !id) throw new AppError(400, '取消する予約IDを指定してください。');
  // Acknowledge within Discord's deadline; report success only after durable book().
  ctx.waitUntil((async () => {
    let content: string;
    let components: unknown[] = [];
    try {
      if (command.name === 'schedule') {
        if (command.options?.length) throw new AppError(400, '/mtg schedule は引数なしで実行してください。');
        if (!interaction.channel_id || !/^\d{17,20}$/.test(interaction.channel_id)) throw new AppError(400, '通知先のチャンネル内で実行してください。');
        const setting = await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id=?').bind(guild).first<{ document_id: string }>();
        if (!setting) throw new AppError(400, '先に /document document:URL で保存先を設定してください。');
        if (!await env.DB.prepare('SELECT id FROM credentials WHERE id=?').bind(guildOwner(guild)).first()) throw new AppError(400, '先に /auth でこのサーバーをGoogleに接続してください。');
        await env.DB.prepare('INSERT OR IGNORE INTO meeting_polls(id,guild,user,created) VALUES(?,?,?,?)').bind(interaction.id, guild, interaction.member!.user!.id, Date.now()).run();
        const row = await env.DB.prepare('SELECT created FROM meeting_polls WHERE id=?').bind(interaction.id).first<{ created: number }>();
        await env.MEETING_POLLS.getByName(interaction.id).create({ id: interaction.id, guild, user: interaction.member!.user!.id, channel: interaction.channel_id, document: setting.document_id, created: row!.created });
        const url = `${appOrigin(env)}/mtg/polls/${interaction.id}`;
        content = `次回MTGの日程調整を作成しました。\n${url}\nDiscordでログインし、参加者を指定して空き時間を回答してください。7日後を中心に5日間を表示します。全員が回答し、空き時間が一致すると自動で予約します。\n参加者にはこのURLを共有してください。`;
        components = [{ type: 1, components: [{ type: 2, style: 5, label: '日程調整を開く', url }] }];
      } else {
        const rows = (await env.DB.prepare(`SELECT id,run_at FROM meeting_reservations WHERE guild=?${id ? ' AND id=?' : ''} ORDER BY run_at DESC LIMIT 8`).bind(guild, ...(id ? [id] : [])).all<{ id: string; run_at: number }>()).results;
        const polls = (await env.DB.prepare(`SELECT id,user FROM meeting_polls WHERE guild=?${id ? ' AND id=?' : ''} ORDER BY created DESC LIMIT 8`).bind(guild, ...(id ? [id] : [])).all<{ id: string; user: string }>()).results;
        const pollReports: string[] = [];
        for (const p of polls.filter(p => !rows.some(r => r.id === p.id))) {
          const poll = env.MEETING_POLLS.getByName(p.id);
          const result = command.name === 'cancel' ? await poll.cancel(interaction.member!.user!.id) : await poll.view(p.user);
          const statuses: Record<string, string> = { draft: '参加者設定待ち', open: '日程調整中', booking: '予約登録中', confirmed: '確定', cancelled: '取消済み' };
          pollReports.push(`${p.id} | ${statuses[result.status]} | ${result.members.filter(m => m.answered).length}/${result.members.length}人回答\n${appOrigin(env)}/mtg/polls/${p.id}`);
        }
        if (!rows.length) content = 'このサーバーの予約が見つかりません。/mtg schedule で予約できます。';
        else {
          const reports: string[] = [];
          for (const row of rows) {
            let result;
            if (command.name === 'cancel') result = await stub(env, guild, row.id).cancel();
            else result = await stub(env, guild, row.id).summary();
            reports.push(result ? `${result.id} | MTG ${jst(result.meetingAt ?? result.runAt)} JST | ${labels[result.status]}\n収集開始: ${jst(result.runAt)} JST\n${result.title} / 投稿 ${result.posts} / 残りの収集処理 ${result.pending} / 画像リンクへの代替 ${result.imageFallbacks}${result.skipped ? ` / アクセス不可 ${result.skipped}` : ''}${result.url ? `\n${result.url}` : ''}${result.error ? `\n${result.error}` : ''}` : `${row.id}: 予約を確定できませんでした。新しく /mtg schedule を実行してください。`);
          }
          content = reports.join('\n\n');
        }
        if (pollReports.length) content = [...pollReports, ...(rows.length ? [content] : [])].join('\n\n');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      content = message.includes('ReservationAlreadyStarted') ? '処理開始後は取消できません。/mtg status で確認してください。'
        : message.includes('ReservationConflict') ? '同じ予約IDが異なる内容に使われています。/mtg status で確認してください。'
        : error instanceof AppError ? error.message : message.includes('PollForbidden') ? '日程調整の取消は主催者が実行してください。' : '予約操作を完了できませんでした。/mtg status で状態を確認してください。';
    }
    try {
      const response = await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${encodeURIComponent(interaction.token)}/messages/@original`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 2000), components, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('ReplyFailed');
    } catch { console.error(JSON.stringify({ event: 'meeting_reply_failed', id: interaction.id })); }
  })());
  return Response.json({ type: 5, data: { flags: 64 } });
}
