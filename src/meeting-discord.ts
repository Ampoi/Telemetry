import { AppError } from './errors';
import { guildOwner, requireGuildManager } from './discord-guild';
import { jst } from './meeting-model';
import { appOrigin } from './auth';
import type { Interaction } from './discord';
import { DEBUG_MODEL, DEBUG_EFFORT, debugWindow } from './debug-agenda';

const labels: Record<string, string> = { scheduled: '予約済み', collecting: '収集中', preparing: '本文準備中', adding: 'タブ作成中', writing: 'Docs書き込み中', summarizing: 'Docs完成・議題要約中', notifying: 'Docs完成・通知中', notification_failed: 'Docs完成・要約または通知失敗', notification_review: 'Docs完成・通知結果の確認が必要', complete: '完了', cancelled: '取消済み', failed: '失敗', needs_review: 'Docsの確認が必要' };
const stub = (env: Env, guild: string, id: string) => env.MEETINGS.getByName(`${guild}:${id}`);

export async function meetingInteraction(interaction: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const guild = requireGuildManager(interaction);
  if (env.COLLECTION_MODE !== 'cloud') throw new AppError(400, '/mtgにはクラウド収集モードが必要です。');
  const command = interaction.data?.options?.[0];
  if (command?.type !== 1 || !['schedule', 'debug', 'status', 'cancel'].includes(command.name)) throw new AppError(400, '/mtg schedule・debug・status・cancelを指定してください。');
  const option = (name: string) => {
    const v = command.options?.find(o => o.name === name);
    if (!v) return '';
    if (v.type !== 3 || typeof v.value !== 'string') throw new AppError(400, `${name}は文字列で指定してください。`);
    return v.value;
  };
  const id = option('id');
  if (id && !/^\d{17,20}$/.test(id)) throw new AppError(400, '予約IDを指定してください。');
  if (command.name === 'cancel' && !id) throw new AppError(400, '取消する予約IDを指定してください。');
  // Keep validation failures private; successful invitations are public Bot posts.
  ctx.waitUntil((async () => {
    let content: string;
    let components: unknown[] = [];
    let announced = false;
    try {
      if (command.name === 'debug') {
        if (command.options?.length) throw new AppError(400, '/mtg debug は引数なしで実行してください。直近168時間・Luna・mediumを使用します。');
        if (!(env as Env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY) throw new AppError(400, 'OPENAI_API_KEYをWorkerのSecretへ設定してください。');
        const runAt = Number((BigInt(interaction.id) >> 22n) + 1420070400000n);
        if (runAt > Date.now() || runAt < Date.now() - 14 * 60_000) throw new AppError(400, 'コマンドの受付期限が切れました。');
        const previous = await env.DB.prepare('SELECT document,title FROM meeting_reservations WHERE id=? AND guild=?').bind(interaction.id, guild).first<{ document: string; title: string }>();
        const setting = await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id=?').bind(guild).first<{ document_id: string }>();
        const document = previous?.document ?? setting?.document_id;
        if (!document) throw new AppError(400, '先に /document document:URL で保存先を設定してください。');
        if (!await env.DB.prepare('SELECT id FROM credentials WHERE id=?').bind(guildOwner(guild)).first()) throw new AppError(400, '先に /auth でこのサーバーをGoogleに接続してください。');
        const title = previous?.title ?? `週次アジェンダ ${jst(runAt)}`;
        await env.DB.prepare('INSERT OR IGNORE INTO meeting_reservations(id,guild,user,run_at,title,document,created) VALUES(?,?,?,?,?,?,?)').bind(interaction.id, guild, interaction.member!.user!.id, runAt, title, document, runAt).run();
        const result = await stub(env, guild, interaction.id).book({ id: interaction.id, guild, user: interaction.member!.user!.id, runAt, title, document, mode: 'debug-agenda', ...debugWindow(runAt) });
        content = `週次アジェンダ ${labels[result!.status] ?? result!.status}\n期間: ${jst(runAt - 7 * 86400_000)} ～ ${jst(runAt)} JST（直近168時間）\nモデル: ${DEBUG_MODEL} / 推論: ${DEBUG_EFFORT}\n全履歴の収集設定を変更せず、取得できる投稿・画像を3部構成にまとめ、新しいDocsタブへ出力します。全員通知は行いません。\n進捗・結果: /mtg status id:${interaction.id}`;
      } else if (command.name === 'schedule') {
        if (command.options?.length) throw new AppError(400, '/mtg schedule は引数なしで実行してください。');
        if (!interaction.channel_id || !/^\d{17,20}$/.test(interaction.channel_id)) throw new AppError(400, '通知先のチャンネル内で実行してください。');
        const setting = await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id=?').bind(guild).first<{ document_id: string }>();
        if (!setting) throw new AppError(400, '先に /document document:URL で保存先を設定してください。');
        if (!await env.DB.prepare('SELECT id FROM credentials WHERE id=?').bind(guildOwner(guild)).first()) throw new AppError(400, '先に /auth でこのサーバーをGoogleに接続してください。');
        await env.DB.prepare('INSERT OR IGNORE INTO meeting_polls(id,guild,user,created) VALUES(?,?,?,?)').bind(interaction.id, guild, interaction.member!.user!.id, Date.now()).run();
        const row = await env.DB.prepare('SELECT created FROM meeting_polls WHERE id=?').bind(interaction.id).first<{ created: number }>();
        await env.MEETING_POLLS.getByName(interaction.id).create({ id: interaction.id, guild, user: interaction.member!.user!.id, channel: interaction.channel_id, document: setting.document_id, created: row!.created });
        const url = `${appOrigin(env)}/mtg/polls/${interaction.id}`;
        components = [{ type: 1, components: [{ type: 2, style: 5, label: '日程調整を開く', url }] }];
        const invitation = await env.MEETING_POLLS.getByName(interaction.id).announce();
        announced = invitation === 'sent';
        content = invitation === 'failed' ? '案内を送信できませんでした。Botの投稿権限を確認してください。'
          : invitation === 'unmentioned' ? '案内は投稿しましたが、全員に通知できませんでした。Botの「全員にメンション」権限を確認してください。'
          : '案内が届いているかチャンネルを確認してください。';
      } else {
        const rows = (await env.DB.prepare(`SELECT id,run_at FROM meeting_reservations WHERE guild=?${id ? ' AND id=?' : ''} ORDER BY run_at DESC LIMIT 8`).bind(guild, ...(id ? [id] : [])).all<{ id: string; run_at: number }>()).results;
        const polls = (await env.DB.prepare(`SELECT id,user FROM meeting_polls WHERE guild=?${id ? ' AND id=?' : ''} ORDER BY created DESC LIMIT 8`).bind(guild, ...(id ? [id] : [])).all<{ id: string; user: string }>()).results;
        const pollReports: string[] = [];
        for (const p of polls.filter(p => !rows.some(r => r.id === p.id))) {
          const poll = env.MEETING_POLLS.getByName(p.id);
          const result = command.name === 'cancel' ? await poll.cancel(interaction.member!.user!.id) : await poll.view(p.user);
          const statuses: Record<string, string> = { draft: '日程調整中', open: '日程調整中', booking: '予約登録中', confirmed: '確定', cancelled: '取消済み' };
          pollReports.push(`${p.id} | ${statuses[result.status]} | ${result.members.filter(m => m.answered).length}/${result.members.length}人回答\n${appOrigin(env)}/mtg/polls/${p.id}`);
        }
        if (!rows.length) content = 'このサーバーの予約が見つかりません。/mtg schedule で予約できます。';
        else {
          const reports: string[] = [];
          for (const row of rows) {
            let result;
            if (command.name === 'cancel') result = await stub(env, guild, row.id).cancel();
            else result = await stub(env, guild, row.id).summary();
            reports.push(result ? `${result.id} | ${result.mode ? 'アジェンダ' : 'MTG'} ${jst(result.meetingAt ?? result.runAt)} JST | ${result.status === 'generating' ? 'アジェンダ生成中' : labels[result.status]}\n${result.title}${result.url ? `\n${result.url}` : ''}${result.error ? `\n${result.error}` : ''}` : `${row.id}: 予約を確定できませんでした。新しくコマンドを実行してください。`);
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
        method: announced ? 'DELETE' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: announced ? undefined : JSON.stringify({ content: content.slice(0, 2000), components, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('ReplyFailed');
    } catch { console.error(JSON.stringify({ event: 'meeting_reply_failed', id: interaction.id })); }
  })());
  return Response.json({ type: 5, data: { flags: 64 } });
}
