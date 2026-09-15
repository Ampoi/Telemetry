import { appOrigin } from './auth';
import { DurableObject } from 'cloudflare:workers';
import { discord, DiscordError } from './cloud/discord-rest';
import { meetingSource, sourceInput } from './meeting-source';
import { debugWindow } from './debug-agenda';
import { jst, type MeetingInput } from './meeting-model';
import { pollDays, meetingTitle, commonSlot, windowStart, DAY, SLOT, type PollInput, type PollState } from './meeting-poll-model';

// A single serialized state per poll prevents simultaneous answers from choosing
// different dates. The alarm durably bridges the poll to the existing scheduler.
export class MeetingPoll extends DurableObject<Env> {
  private state(): PollState {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM poll WHERE id=1').toArray()[0];
    if (!row) throw new Error('PollNotFound');
    return JSON.parse(row.data);
  }
  private save(p: PollState) { this.ctx.storage.sql.exec('INSERT INTO poll(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(p)); }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS poll(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS invitation(id INTEGER PRIMARY KEY, status TEXT NOT NULL)');
  }
  async create(input: PollInput) {
    const exists = this.ctx.storage.sql.exec('SELECT id FROM poll WHERE id=1').toArray().length;
    if (!exists) this.save({ ...input, start: windowStart(input.created, input.centerDays, input.radiusDays), title: '定例mtg', status: 'draft', members: [], answers: {} });
    return { id: input.id };
  }
  async announce(): Promise<'sent' | 'unconfirmed' | 'failed' | 'unmentioned'> {
    const p = this.state();
    const channel = await discord<{ guild_id: string }>(this.env, `/channels/${p.channel}`);
    if (channel.guild_id !== p.guild) throw new Error('ChannelMismatch');
    // A separate record prevents concurrent Web edits from losing the send marker.
    const claimed = this.ctx.storage.sql.exec("INSERT OR IGNORE INTO invitation(id,status) VALUES(1,'unconfirmed') RETURNING id").toArray().length;
    if (!claimed) return this.ctx.storage.sql.exec<{ status: 'sent' | 'unconfirmed' | 'failed' | 'unmentioned' }>('SELECT status FROM invitation WHERE id=1').one().status;
    await this.ctx.storage.sync();
    let status: 'sent' | 'unconfirmed' | 'failed' | 'unmentioned' = 'unconfirmed';
    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${p.channel}/messages`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '@everyone\n次回MTGの日時を入力してください！',
          components: [{ type: 1, components: [{ type: 2, style: 5, label: '日程調整を開く', url: `${appOrigin(this.env)}/mtg/polls/${p.id}` }] }],
          allowed_mentions: { parse: ['everyone'] }, nonce: `i${p.id}`, enforce_nonce: true }),
      });
      if (response.ok) {
        const message = await response.json() as { id?: string; mention_everyone?: boolean };
        if (message.id) status = message.mention_everyone ? 'sent' : 'unmentioned';
      } else {
        if (response.status >= 400 && response.status < 500) status = 'failed';
        await response.body?.cancel();
      }
    } catch { /* Keep the durable uncertain marker; never repeat a possible ping. */ }
    this.ctx.storage.sql.exec('UPDATE invitation SET status=? WHERE id=1', status);
    return status;
  }
  view(user: string) {
    const p = this.state();
    if (user !== p.user && !p.members.some(m => m.id === user)) throw new Error('PollForbidden');
    const counts = Array.from({ length: pollDays(p) * 48 }, (_, i) => p.members.filter(m => p.answers[m.id]?.includes(i)).length);
    return { id: p.id, start: p.start, days: pollDays(p), centerDays: p.centerDays ?? 7, duration: p.duration, title: p.title, status: p.status, owner: user === p.user,
      members: p.members.map(m => ({ ...m, answered: Object.hasOwn(p.answers, m.id) })), counts, mine: p.answers[user] ?? [],
      answered: Object.hasOwn(p.answers, user), meetingAt: p.meetingAt, error: p.error, notified: p.notified };
  }
  async open(user: string) {
    const failure = await this.ctx.blockConcurrencyWhile(async () => {
      try {
      const p = this.state();
      if (p.status !== 'draft') return;
      const members = new Map<string, { id: string; name: string }>();
      let after = '0';
      for (;;) {
        const page = await discord<{ user: { id: string; username: string; global_name?: string; bot?: boolean }; nick?: string }[]>(this.env, `/guilds/${p.guild}/members?limit=1000&after=${after}`);
        for (const m of page) if (!m.user.bot) members.set(m.user.id, { id: m.user.id, name: m.nick ?? m.user.global_name ?? m.user.username });
        if (page.length < 1000) break;
        const next = page[page.length - 1].user.id;
        if (BigInt(next) <= BigInt(after)) throw new Error('InvalidMemberPage');
        after = next;
      }
      if (!members.has(user)) throw new Error('PollForbidden');
      p.members = [...members.values()]; p.duration = undefined; p.title = '定例mtg';
      p.status = Date.now() >= p.start + pollDays(p) * DAY ? 'cancelled' : 'open';
      if (p.status === 'open') await this.ctx.storage.setAlarm(p.start + pollDays(p) * DAY);
      this.save(p);
      } catch (error) {
        if (error instanceof DiscordError) return error.httpStatus === 403 ? 'MemberListForbidden' : 'MemberListUnavailable';
        return error instanceof Error ? error.message : 'MemberListUnavailable';
      }
    });
    if (failure) throw new Error(failure);
    return this.view(user);
  }
  async answer(user: string, slots: number[]) {
    const p = this.state();
    if (!p.members.some(m => m.id === user)) throw new Error('PollForbidden');
    if (p.status !== 'open') throw new Error('PollClosed');
    if (Date.now() >= p.start + pollDays(p) * DAY) throw new Error('PollExpired');
    if (!Array.isArray(slots) || slots.length > pollDays(p) * 48 || slots.some(n => !Number.isInteger(n) || n < 0 || n >= pollDays(p) * 48)) throw new Error('InvalidSlots');
    p.answers[user] = [...new Set(slots)];
    const at = commonSlot(p, Date.now());
    if (at !== undefined) { p.meetingAt = at; p.title = meetingTitle(at); p.status = 'booking'; }
    this.save(p);
    if (p.status === 'booking') await this.ctx.storage.setAlarm(Date.now() + 1);
    return this.view(user);
  }
  async confirm(user: string, slot: number) {
    const p = this.state();
    if (p.user !== user) throw new Error('PollForbidden');
    if (p.status !== 'open') throw new Error('PollClosed');
    if (!Number.isInteger(slot) || slot < 0 || slot >= pollDays(p) * 48) throw new Error('InvalidSlot');
    const at = p.start + slot * SLOT;
    if (at <= Date.now() + 3600_000) throw new Error('InvalidMeetingTime');
    p.meetingAt = at; p.title = meetingTitle(at); p.status = 'booking';
    this.save(p);
    await this.ctx.storage.setAlarm(Date.now() + 1);
    return this.view(user);
  }
  async cancel(user: string) {
    const p = this.state();
    if (p.user !== user) throw new Error('PollForbidden');
    if (!['draft', 'open', 'cancelled'].includes(p.status)) throw new Error('PollClosed');
    p.status = 'cancelled'; this.save(p); await this.ctx.storage.deleteAlarm();
    return this.view(user);
  }
  async alarm() {
    const p = this.state();
    if (p.status === 'open') {
      if (Date.now() >= p.start + pollDays(p) * DAY) { p.status = 'cancelled'; p.error = '候補期間が終了しました。新しい日程調整を作成してください。'; this.save(p); }
      else await this.ctx.storage.setAlarm(p.start + pollDays(p) * DAY);
      return;
    }
    if (p.status !== 'booking') return;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    try {
      const runAt = p.meetingAt! - 7200_000;
      const source = await meetingSource(this.env, p.guild);
      const input: MeetingInput = { id: p.id, guild: p.guild, user: p.user, channel: p.channel, document: p.document, title: p.title,
        meetingAt: p.meetingAt!, runAt, mode: 'agenda', startNotice: true, ...debugWindow(runAt), ...sourceInput(source) };
      await this.env.DB.prepare('INSERT OR IGNORE INTO meeting_reservations(id,guild,user,run_at,title,document,created,meeting_at,channel) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(p.id, p.guild, p.user, input.runAt, p.title, p.document, p.created, input.meetingAt, p.channel).run();
      const result = await this.env.MEETINGS.getByName(`${p.guild}:${p.id}`).book(input);
      if (result?.status === 'cancelled') { p.status = 'cancelled'; this.save(p); await this.ctx.storage.deleteAlarm(); return; }
      p.status = 'confirmed'; p.error = undefined;
      this.save(p);
      // Announcement is sent only once, with no mentions. An uncertain send is
      // shown on the page; the reservation remains safely persisted.
      if (!p.notificationAttempted) {
        const channel = await discord<{ guild_id: string }>(this.env, `/channels/${p.channel}`);
        if (channel.guild_id !== p.guild) throw new Error('ChannelMismatch');
        p.notificationAttempted = true; this.save(p); await this.ctx.storage.sync();
        const response = await fetch(`https://discord.com/api/v10/channels/${p.channel}/messages`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `次のMTG日時は${jst(p.meetingAt!)}（日本時間）です！`, allowed_mentions: { parse: [] }, nonce: p.id, enforce_nonce: true }),
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('NotificationFailed'); }
        const message = await response.json() as { id?: string };
        if (!message.id) throw new Error('NotificationUncertain');
        p.notified = true; this.save(p);
      }
      await this.ctx.storage.deleteAlarm();
    } catch {
      p.error = p.status === 'confirmed' ? '日時は確定しました。Discord通知の送信結果をチャンネルで確認してください。' : '予約の登録を再試行しています。';
      if (p.meetingAt! <= Date.now() && p.status === 'booking') { p.status = 'cancelled'; p.error = '予約を登録できないまま候補日時を過ぎました。日程調整を作り直してください。'; }
      this.save(p);
      if (p.status !== 'booking') await this.ctx.storage.deleteAlarm();
    }
  }
}
