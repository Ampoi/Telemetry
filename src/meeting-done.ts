import { DurableObject } from 'cloudflare:workers';
import { appOrigin } from './auth';
import { discord } from './cloud/discord-rest';
import { decrypt, encrypt } from './crypto';
import type { Interaction } from './discord';
import { guildOwner } from './discord-guild';
import { AppError } from './errors';
import { accessToken, googleDocs } from './google';
import { meetingSettings } from './guild-settings';
import { minutesMessages, minutesText, summarizeMinutes, type MinutesDocument } from './meeting-minutes';
import type { PollInput } from './meeting-poll-model';
import type { SummaryEnv } from './meeting-summary';

type DoneStatus = 'reading' | 'summarizing' | 'publishing' | 'complete' | 'failed' | 'needs_review';
interface DoneInput { meeting: string; poll: PollInput; tab: string; title: string; url: string; reply: string; expires: number }
interface DoneState extends DoneInput { status: DoneStatus; pages?: string[]; page: number; sending?: boolean; generating?: boolean; error?: string }
const finished = (s: DoneStatus) => ['complete', 'failed', 'needs_review'].includes(s);
export const doneStub = (env: Env, guild: string, meeting: string) => env.MEETING_DONE.getByName(`${guild}:${meeting}`);

export async function acceptMeetingDone(i: Interaction, env: Env, guild: string, requested: string) {
  const receipt = await env.DB.prepare('SELECT meeting_id FROM meeting_done_requests WHERE id=? AND guild=?').bind(i.id, guild).first<{ meeting_id: string }>();
  let meeting = receipt?.meeting_id ?? requested;
  const at = Number((BigInt(i.id) >> 22n) + 1420070400000n);
  if (at > Date.now() || at < Date.now() - 14 * 60_000) throw new AppError(400, 'コマンドの受付期限が切れました。再実行してください。');
  if (!meeting) {
    // Choose the latest actual MTG whose start time has passed. Debug agendas
    // have no meeting_at; future/preparing meetings cannot be silently skipped.
    const row = await env.DB.prepare('SELECT id FROM meeting_reservations WHERE guild=? AND meeting_at<=? ORDER BY meeting_at DESC,id DESC LIMIT 1').bind(guild, at).first<{ id: string }>();
    if (!row) throw new AppError(400, '終了対象のMTGが見つかりません。/mtg status で確認し、必要なら /mtg done id:予約ID を指定してください。');
    meeting = row.id;
  }
  const reservation = await env.DB.prepare('SELECT id FROM meeting_reservations WHERE guild=? AND id=?').bind(guild, meeting).first();
  if (!reservation) throw new AppError(400, 'このサーバーのMTGが見つかりません。/mtg status で確認してください。');
  const source = await env.MEETINGS.getByName(`${guild}:${meeting}`).summary();
  if (!source?.url || !['complete', 'notification_failed', 'notification_review'].includes(source.status)) throw new AppError(400, 'アジェンダの作成が完了していません。/mtg status で確認してください。');
  if (source.meetingAt && source.meetingAt > at) throw new AppError(400, 'まだ開始前のMTGです。会議が終わってから実行してください。');
  const url = new URL(source.url);
  const doc = url.pathname.match(/^\/document\/d\/([\w-]+)\/edit$/)?.[1], tab = url.searchParams.get('tab');
  if (url.origin !== 'https://docs.google.com' || !doc || !tab) throw new AppError(400, '議事録のタブを確認できません。/mtg status で確認してください。');
  const preferences = await meetingSettings(env, guild);
  const channel = preferences.channel_id ?? i.channel_id;
  if (!channel || !/^\d{17,20}$/.test(channel)) throw new AppError(400, '投稿先のチャンネル内で実行してください。');
  if (!(env as Env & SummaryEnv).OPENAI_API_KEY || !(env as Env & SummaryEnv).MTG_SUMMARY_MODEL) throw new AppError(400, '要約の設定が見つかりません。管理者に連絡してください。');
  const setting = await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id=?').bind(guild).first<{ document_id: string }>();
  if (!setting) throw new AppError(400, '先に /document document:URL で保存先を設定してください。');
  await env.DB.prepare('INSERT OR IGNORE INTO meeting_done_requests(id,guild,meeting_id) VALUES(?,?,?)').bind(i.id, guild, meeting).run();
  // Read the winner so concurrent redelivery cannot select a different meeting.
  const pinned = await env.DB.prepare('SELECT meeting_id FROM meeting_done_requests WHERE id=? AND guild=?').bind(i.id, guild).first<{ meeting_id: string }>();
  if (pinned?.meeting_id !== meeting) return acceptMeetingDone(i, env, guild, pinned!.meeting_id);
  const reply = await encrypt(JSON.stringify({ application: i.application_id, token: i.token }), env.TOKEN_ENCRYPTION_KEY, `meeting-done:${guild}:${meeting}`);
  return doneStub(env, guild, meeting).start({ meeting, title: source.title, tab, url: source.url, reply, expires: at + 14 * 60_000,
    poll: { id: i.id, guild, user: i.member!.user!.id, channel, document: setting.document_id, created: at, centerDays: preferences.center_days, radiusDays: preferences.radius_days },
  });
}

// One object per completed MTG deduplicates different users/command IDs too.
// The old scheduler keeps its own alarm; long summaries cannot delay a meeting.
export class MeetingDone extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS completion(id INTEGER PRIMARY KEY,data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS minutes(id INTEGER PRIMARY KEY,text TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY)');
  }
  private state(): DoneState | undefined {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM completion WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private save(s: DoneState) { this.ctx.storage.sql.exec('INSERT INTO completion(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(s)); }
  summary() {
    const s = this.state();
    return s ? { status: s.status, error: s.error, pollUrl: `${appOrigin(this.env)}/mtg/polls/${s.poll.id}` } : null;
  }
  async start(input: DoneInput) {
    const old = this.state();
    if (old) {
      // Only a new explicit command may retry a failure before public delivery.
      if (old.status !== 'failed' || old.page > 0 || old.sending || this.ctx.storage.sql.exec('SELECT id FROM attempts WHERE id=?', input.poll.id).toArray().length) return { ...this.summary()!, accepted: false };
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO attempts(id) VALUES(?)', input.poll.id);
    this.save({ ...input, status: 'reading', page: 0 });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { ...this.summary()!, accepted: true };
  }
  private async check(s: DoneState) {
    const p = s.poll;
    const guild = await discord<{ owner_id: string }>(this.env, `/guilds/${p.guild}`);
    if (guild.owner_id !== p.user) {
      const member = await discord<{ roles: string[] }>(this.env, `/guilds/${p.guild}/members/${p.user}`);
      const roles = await discord<{ id: string; permissions: string }[]>(this.env, `/guilds/${p.guild}/roles`);
      if (!roles.some(r => (r.id === p.guild || member.roles.includes(r.id)) && (BigInt(r.permissions) & 40n))) throw new AppError(403, 'サーバー管理権限を確認して、管理者が再実行してください。');
    }
    const channel = await discord<{ guild_id: string }>(this.env, `/channels/${p.channel}`);
    if (channel.guild_id !== p.guild) throw new AppError(403, '投稿先のサーバーが一致しません。通知設定を確認してください。');
  }
  private async reply(s: DoneState) {
    if (!s.reply) return;
    try {
      if (s.expires > Date.now()) {
        const reply = JSON.parse(await decrypt(s.reply, this.env.TOKEN_ENCRYPTION_KEY, `meeting-done:${s.poll.guild}:${s.meeting}`));
        const response = await fetch(`https://discord.com/api/v10/webhooks/${reply.application}/${encodeURIComponent(reply.token)}/messages/@original`, {
          method: s.status === 'complete' ? 'DELETE' : 'PATCH', signal: AbortSignal.timeout(10_000),
          headers: { 'Content-Type': 'application/json' },
          ...(s.status === 'complete' ? {} : { body: JSON.stringify({ content: s.error, allowed_mentions: { parse: [] } }) }),
        });
        await response.body?.cancel();
      }
    } catch { console.error(JSON.stringify({ event: 'meeting_done_reply_failed', meeting: s.meeting })); }
    // A manager can retry while the failed attempt's private reply is in flight.
    // Never overwrite that newer attempt with this stale snapshot.
    const current = this.state();
    if (current?.poll.id === s.poll.id) { current.reply = ''; this.save(current); }
  }
  async alarm() {
    const s = this.state();
    if (!s) return;
    if (finished(s.status)) { await this.ctx.storage.deleteAlarm(); await this.reply(s); return; }
    await this.ctx.storage.setAlarm(Date.now() + 180_000);
    try {
      if (s.sending) throw new AppError(409, '要約が届いているかチャンネルを確認してください。重複を防ぐため送信を停止しました。');
      if (s.generating) throw new AppError(502, '議事録の要約が中断しました。/mtg done を再実行してください。');
      await this.check(s);
      if (s.status === 'reading') {
        const doc = new URL(s.url).pathname.split('/')[3];
        const token = await accessToken(this.env, guildOwner(s.poll.guild));
        let result: MinutesDocument;
        try { result = await googleDocs<MinutesDocument>(token, `${doc}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`); }
        catch { throw new AppError(502, '議事録を読み取れませんでした。Googleの接続・ドキュメントの共有権限を確認して /mtg done を再実行してください。'); }
        const text = minutesText(result, s.tab);
        this.ctx.storage.sql.exec('INSERT INTO minutes(id,text) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text', text);
        s.status = 'summarizing';
      } else if (s.status === 'summarizing') {
        const source = this.ctx.storage.sql.exec<{ text: string }>('SELECT text FROM minutes WHERE id=1').one().text;
        s.generating = true; this.save(s); await this.ctx.storage.sync();
        const result = await summarizeMinutes(this.env as Env & SummaryEnv, source);
        s.pages = minutesMessages(result, s.title, s.url); s.generating = false; s.status = 'publishing';
      } else if (s.page < s.pages!.length) {
        s.sending = true; this.save(s); await this.ctx.storage.sync();
        const response = await fetch(`https://discord.com/api/v10/channels/${s.poll.channel}/messages`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
          headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: s.pages![s.page], allowed_mentions: { parse: [] }, nonce: `d${s.page}-${s.poll.id}`, enforce_nonce: true }),
        });
        if (response.status === 429) {
          const body = await response.json() as { retry_after?: number }; s.sending = false; this.save(s);
          await this.ctx.storage.setAlarm(Date.now() + Math.max(1, body.retry_after ?? 5) * 1000); return;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status < 500) s.sending = false;
          throw new AppError(502, '要約を投稿できませんでした。チャンネルとBotの投稿権限を確認してください。');
        }
        if (!(await response.json() as { id?: string }).id) throw new Error('SendUncertain');
        s.page++; s.sending = false;
      } else {
        await this.env.DB.prepare('INSERT OR IGNORE INTO meeting_polls(id,guild,user,created) VALUES(?,?,?,?)').bind(s.poll.id, s.poll.guild, s.poll.user, s.poll.created).run();
        const poll = this.env.MEETING_POLLS.getByName(s.poll.id);
        await poll.create(s.poll);
        const result = await poll.announce();
        if (result !== 'sent') {
          s.status = result === 'unconfirmed' ? 'needs_review' : 'failed';
          s.error = result === 'unconfirmed' ? '日程調整の案内が届いているかチャンネルを確認してください。'
            : result === 'unmentioned' ? '要約と日程調整を投稿しましたが、全員に通知できませんでした。Botの「全員にメンション」権限を確認してください。'
            : '要約は投稿しましたが、日程調整の案内を送信できませんでした。Botの投稿権限を確認してください。';
          s.error += `\n日程調整：${appOrigin(this.env)}/mtg/polls/${s.poll.id}`;
        } else s.status = 'complete';
      }
    } catch (error) {
      s.status = s.sending ? 'needs_review' : 'failed';
      s.error = s.sending ? '要約が届いているかチャンネルを確認してください。重複を防ぐため送信を停止しました。'
        : error instanceof AppError && error.status !== 401 ? error.message
        : '議事録を読み取れませんでした。Googleの接続・ドキュメントの共有権限を確認して /mtg done を再実行してください。';
      console.error(JSON.stringify({ event: 'meeting_done_failed', meeting: s.meeting, status: s.status }));
    }
    this.save(s);
    if (finished(s.status)) { this.ctx.storage.sql.exec('DELETE FROM minutes'); await this.ctx.storage.deleteAlarm(); await this.reply(s); }
    else await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
}
