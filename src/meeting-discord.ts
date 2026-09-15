import { AppError } from './errors';
import { guildOwner, requireGuildManager } from './discord-guild';
import { jst, jstTime, type MeetingInput } from './meeting-model';
import type { Interaction } from './discord';

const labels: Record<string, string> = { scheduled: '予約済み', collecting: '収集中', preparing: '本文準備中', adding: 'タブ作成中', writing: 'Docs書き込み中', complete: '完了', cancelled: '取消済み', failed: '失敗', needs_review: 'Docsの確認が必要' };
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
  let input: MeetingInput | undefined;
  if (command.name === 'schedule') {
    const runAt = jstTime(option('datetime'));
    const title = option('title') || `MTG ${jst(runAt)}`;
    if (!title.trim() || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)) throw new AppError(400, 'タブ名は改行なしの1〜100文字で指定してください。');
    const previous = await env.DB.prepare('SELECT id,guild,user,run_at,title,document FROM meeting_reservations WHERE id=? AND guild=?').bind(interaction.id, guild).first<{ id: string; guild: string; user: string; run_at: number; title: string; document: string }>();
    const setting = await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id=?').bind(guild).first<{ document_id: string }>();
    if (!setting && !previous) throw new AppError(400, '先に /document document:URL でこのサーバーの保存先を設定してください。');
    if (!await env.DB.prepare('SELECT id FROM credentials WHERE id=?').bind(guildOwner(guild)).first()) throw new AppError(400, '先に /auth でこのサーバーをGoogleに接続してください。');
    if (!previous && (runAt <= Date.now() || runAt > Date.now() + 366 * 86400_000)) throw new AppError(400, '日時は現在より後、366日以内の日本時間を指定してください。');
    input = { id: interaction.id, guild, user: interaction.member!.user!.id, runAt, title, document: previous?.document ?? setting!.document_id };
  }
  // Acknowledge within Discord's deadline; report success only after durable book().
  ctx.waitUntil((async () => {
    let content: string;
    try {
      if (input) {
        await env.DB.prepare('INSERT OR IGNORE INTO meeting_reservations(id,guild,user,run_at,title,document,created) VALUES(?,?,?,?,?,?,?)').bind(input.id, guild, input.user, input.runAt, input.title, input.document, Date.now()).run();
        const result = await stub(env, guild, input.id).book(input);
        content = `MTG ${labels[result!.status]}\n日時: ${jst(input.runAt)} JST\n予約ID: ${input.id}\nBotが閲覧できる全チャンネル・スレッドの全履歴を予約時刻まで収集し、終了後に「${input.title}」タブへ時系列で書き込みます。画像は対応形式を埋め込み、動画はリンクです。\n確認: /mtg status id:${input.id}\n取消: /mtg cancel id:${input.id}`;
      } else {
        const rows = (await env.DB.prepare(`SELECT id,run_at FROM meeting_reservations WHERE guild=?${id ? ' AND id=?' : ''} ORDER BY run_at DESC LIMIT 8`).bind(guild, ...(id ? [id] : [])).all<{ id: string; run_at: number }>()).results;
        if (!rows.length) content = 'このサーバーの予約が見つかりません。/mtg schedule で予約できます。';
        else {
          const reports: string[] = [];
          for (const row of rows) {
            let result;
            if (command.name === 'cancel') result = await stub(env, guild, row.id).cancel();
            else result = await stub(env, guild, row.id).summary();
            reports.push(result ? `${result.id} | ${jst(result.runAt)} JST | ${labels[result.status]}\n${result.title} / 投稿 ${result.posts} / 残りの収集処理 ${result.pending} / 画像リンクへの代替 ${result.imageFallbacks}${result.skipped ? ` / アクセス不可 ${result.skipped}` : ''}${result.url ? `\n${result.url}` : ''}${result.error ? `\n${result.error}` : ''}` : `${row.id}: 予約を確定できませんでした。新しく /mtg schedule を実行してください。`);
          }
          content = reports.join('\n\n');
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      content = message.includes('ReservationAlreadyStarted') ? '処理開始後は取消できません。/mtg status で確認してください。'
        : message.includes('ReservationConflict') ? '同じ予約IDが異なる内容に使われています。/mtg status で確認してください。'
        : `予約操作を完了できませんでした。/mtg status${input ? ` id:${input.id}` : ''} で状態を確認してください。`;
    }
    try {
      const response = await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${encodeURIComponent(interaction.token)}/messages/@original`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('ReplyFailed');
    } catch { console.error(JSON.stringify({ event: 'meeting_reply_failed', id: interaction.id })); }
  })());
  return Response.json({ type: 5, data: { flags: 64 } });
}
