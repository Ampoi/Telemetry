import { meetingSettings } from './guild-settings';
import { AppError } from './errors';
import { guildOwner, requireGuildManager } from './discord-guild';
import { jst, jstTime } from './meeting-model';
import { meetingTitle } from './meeting-poll-model';
import { meetingSource, sourceInput } from './meeting-source';
import { appOrigin } from './auth';
import type { Interaction } from './discord';
import { debugWindow } from './debug-agenda';
import { acceptMeetingDone, doneStub } from './meeting-done';

const labels: Record<string, string> = { scheduled: '予約済み', collecting: '収集中', preparing: '本文準備中', adding: 'タブ作成中', writing: 'Docs書き込み中', summarizing: 'Docs完成・議題要約中', notifying: 'Docs完成・通知中', notification_failed: 'Docs完成・要約または通知失敗', notification_review: 'Docs完成・通知結果の確認が必要', complete: '完了', cancelled: '取消済み', failed: '失敗', needs_review: 'Docsの確認が必要' };
const stub = (env: Env, guild: string, id: string) => env.MEETINGS.getByName(`${guild}:${id}`);

export async function meetingInteraction(interaction: Interaction, env: Env, ctx: ExecutionContext): Promise<Response> {
  const guild = requireGuildManager(interaction);
  if (env.COLLECTION_MODE !== 'cloud') throw new AppError(400, '/mtgにはクラウド収集モードが必要です。');
  const command = interaction.data?.options?.[0];
  if (command?.type !== 1 || !['schedule', 'done', 'debug', 'status', 'cancel'].includes(command.name)) throw new AppError(400, '/mtg schedule・done・debug・status・cancelを指定してください。');
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
      if (command.name === 'done') {
        if (command.options?.some(o => o.name !== 'id')) throw new AppError(400, '/mtg done または /mtg done id:予約ID を指定してください。');
        const result = await acceptMeetingDone(interaction, env, guild, id);
        // The durable job owns this deferred response until publication/error.
        if (result.accepted) return;
        announced = result.status === 'complete';
        content = result.error ?? '議事録をまとめています。完了するとチャンネルに投稿します。';
      } else if (command.name === 'debug') {
        if (command.options?.some(o => !['datetime', 'after', 'from', 'to', 'previous'].includes(o.name))) throw new AppError(400, '/mtg debug の引数を確認してください。');
        const from = option('from'), to = option('to'), previousMeetingId = option('previous');
        if (!!from !== !!to) throw new AppError(400, 'from と to を両方指定してください（終了日は含みません）。');
        if (previousMeetingId && previousMeetingId !== 'none' && !/^\d{17,20}$/.test(previousMeetingId)) throw new AppError(400, 'previous は前回の予約ID、初回は none を指定してください。');
        const range = from ? { rangeFrom: jstTime(`${from} 00:00`), rangeTo: jstTime(`${to} 00:00`) } : undefined;
        if (range && (range.rangeFrom >= range.rangeTo || range.rangeTo > Date.now() || range.rangeTo - range.rangeFrom > 31 * 86400_000)) throw new AppError(400, '対象期間は過去31日分以内で指定してください。終了日は含みません。');
        const datetime = option('datetime');
        const delay = command.options?.find(o => o.name === 'after');
        if (datetime && delay) throw new AppError(400, 'datetime と after はどちらか一方を指定してください。');
        if (delay && (delay.type !== 4 || typeof delay.value !== 'number' || !Number.isInteger(delay.value) || delay.value < 1 || delay.value > 86400)) throw new AppError(400, 'after は1〜86400秒で指定してください。');
        if (!(env as Env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY) throw new AppError(400, 'OPENAI_API_KEYをWorkerのSecretへ設定してください。');
        const runAt = Number((BigInt(interaction.id) >> 22n) + 1420070400000n);
        if (runAt > Date.now() || runAt < Date.now() - 14 * 60_000) throw new AppError(400, 'コマンドの受付期限が切れました。');
        const meetingAt = datetime ? jstTime(datetime) : delay ? runAt + 3600_000 + (delay.value as number) * 1000 : undefined;
        const existing = await stub(env, guild, interaction.id).summary();
        if (meetingAt && !existing && (meetingAt <= Date.now() || meetingAt > Date.now() + 366 * 86400_000)) throw new AppError(400, '開始日時は現在より後、366日以内で指定してください。');
        if (meetingAt && !existing && !(await meetingSettings(env, guild)).voice_channel_id) throw new AppError(400, '/settings でMTGの通話チャンネルを選択してください。');
        if (meetingAt && !interaction.channel_id) throw new AppError(400, '通知先のチャンネル内で実行してください。');
        const previous = await env.DB.prepare('SELECT document,title FROM meeting_reservations WHERE id=? AND guild=?').bind(interaction.id, guild).first<{ document: string; title: string }>();
        const setting = await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id=?').bind(guild).first<{ document_id: string }>();
        const document = previous?.document ?? setting?.document_id;
        if (!document) throw new AppError(400, '先に /document document:URL で保存先を設定してください。');
        if (!await env.DB.prepare('SELECT id FROM credentials WHERE id=?').bind(guildOwner(guild)).first()) throw new AppError(400, '先に /auth でこのサーバーをGoogleに接続してください。');
        const title = previous?.title ?? meetingTitle(meetingAt ?? runAt);
        const source = await meetingSource(env, guild);
        await env.DB.prepare('INSERT OR IGNORE INTO meeting_reservations(id,guild,user,run_at,title,document,created) VALUES(?,?,?,?,?,?,?)').bind(interaction.id, guild, interaction.member!.user!.id, runAt, title, document, runAt).run();
        await stub(env, guild, interaction.id).book({ id: interaction.id, guild, user: interaction.member!.user!.id, runAt, title, document,
          mode: meetingAt ? 'agenda' : 'debug-agenda', ...debugWindow(runAt), ...sourceInput(source), ...range,
          debug: true, previousMeetingId: previousMeetingId || undefined, customRange: !!range,
          ...(meetingAt ? { meetingAt, channel: interaction.channel_id, startNotice: true } : {}) });
        content = meetingAt ? `${jst(meetingAt)}（日本時間）の会議を予約しました。開始1時間前に通話チャンネルとアジェンダを通知します。アジェンダ作成が間に合わない場合は完成後に通知します。\nアジェンダ：${title}\n確認・取消：/mtg status id:${interaction.id}`
          : `アジェンダを作成します。\n${title}\n確認：/mtg status id:${interaction.id}`;
      } else if (command.name === 'schedule') {
        if (command.options?.length) throw new AppError(400, '/mtg schedule は引数なしで実行してください。');
        if (!interaction.channel_id || !/^\d{17,20}$/.test(interaction.channel_id)) throw new AppError(400, '通知先のチャンネル内で実行してください。');
        const setting = await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id=?').bind(guild).first<{ document_id: string }>();
        if (!setting) throw new AppError(400, '先に /document document:URL で保存先を設定してください。');
        if (!await env.DB.prepare('SELECT id FROM credentials WHERE id=?').bind(guildOwner(guild)).first()) throw new AppError(400, '先に /auth でこのサーバーをGoogleに接続してください。');
        const preferences = await meetingSettings(env, guild);
        if (!preferences.voice_channel_id) throw new AppError(400, '/settings でMTGの通話チャンネルを選択してください。');
        await env.DB.prepare('INSERT OR IGNORE INTO meeting_polls(id,guild,user,created) VALUES(?,?,?,?)').bind(interaction.id, guild, interaction.member!.user!.id, Date.now()).run();
        const row = await env.DB.prepare('SELECT created FROM meeting_polls WHERE id=?').bind(interaction.id).first<{ created: number }>();
        await env.MEETING_POLLS.getByName(interaction.id).create({ id: interaction.id, guild, user: interaction.member!.user!.id, channel: preferences.channel_id ?? interaction.channel_id, centerDays: preferences.center_days, radiusDays: preferences.radius_days, document: setting.document_id, created: row!.created });
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
            const notice = result?.startNotice ? await env.MEETING_STARTS.getByName(`${guild}:${row.id}`).summary() : undefined;
            const noticeLabels = { scheduled: '予約済み', sending: '送信中', sent: '送信済み', failed: '失敗', needs_review: 'チャンネルを確認してください', cancelled: '取消済み' };
            reports.push(result ? `${result.id} | ${result.mode ? 'アジェンダ' : 'MTG'} ${jst(result.meetingAt ?? result.runAt)} JST | ${result.status === 'generating' ? 'アジェンダ生成中' : labels[result.status]}\n${result.title}${notice ? `\n開始通知：${noticeLabels[notice.status]}` : ''}${result.url ? `\n${result.url}` : ''}${result.error ? `\n${result.error}` : ''}${notice?.error ? `\n${notice.error}` : ''}` : `${row.id}: 予約を確定できませんでした。新しくコマンドを実行してください。`);
          }
          if (command.name === 'status' && env.MEETING_DONE) {
            for (const [n, row] of rows.entries()) {
              const done = await doneStub(env, guild, row.id).summary();
              if (done) reports[n] += `\n終了後のまとめ：${done.status === 'complete' ? '投稿済み' : done.error ?? '作成中'}${done.status === 'complete' ? `\n${done.pollUrl}` : ''}`;
            }
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
