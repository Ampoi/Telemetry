import { DurableObject } from 'cloudflare:workers';
import { discord } from './cloud/discord-rest';
import { jst, type MeetingInput } from './meeting-model';
import { commonSlot, windowStart, DAY, type PollInput, type PollMember, type PollState } from './meeting-poll-model';

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
  }
  async create(input: PollInput) {
    const exists = this.ctx.storage.sql.exec('SELECT id FROM poll WHERE id=1').toArray().length;
    if (!exists) this.save({ ...input, start: windowStart(input.created), duration: 60, title: '定例MTG', status: 'draft', members: [], answers: {} });
    return { id: input.id };
  }
  view(user: string) {
    const p = this.state();
    if (user !== p.user && !p.members.some(m => m.id === user)) throw new Error('PollForbidden');
    const counts = Array.from({ length: 240 }, (_, i) => p.members.filter(m => p.answers[m.id]?.includes(i)).length);
    return { id: p.id, start: p.start, duration: p.duration, title: p.title, status: p.status, owner: user === p.user,
      members: p.members.map(m => ({ ...m, answered: Object.hasOwn(p.answers, m.id) })), counts, mine: p.answers[user] ?? [],
      answered: Object.hasOwn(p.answers, user), meetingAt: p.meetingAt, error: p.error, notified: p.notified };
  }
  async configure(user: string, members: PollMember[], duration: number, title: string) {
    const p = this.state();
    if (p.user !== user) throw new Error('PollForbidden');
    if (p.status !== 'draft') throw new Error('PollClosed');
    if (!members.some(m => m.id === user) || members.length < 2 || members.length > 50 || new Set(members.map(m => m.id)).size !== members.length) throw new Error('InvalidMembers');
    if (![30, 60, 90, 120].includes(duration) || !title.trim() || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('InvalidSettings');
    p.members = members; p.duration = duration; p.title = title; p.status = 'open'; this.save(p);
    await this.ctx.storage.setAlarm(p.start + 5 * DAY);
    return this.view(user);
  }
  async answer(user: string, slots: number[]) {
    const p = this.state();
    if (!p.members.some(m => m.id === user)) throw new Error('PollForbidden');
    if (p.status !== 'open') throw new Error('PollClosed');
    if (Date.now() >= p.start + 5 * DAY) throw new Error('PollExpired');
    if (!Array.isArray(slots) || slots.length > 240 || slots.some(n => !Number.isInteger(n) || n < 0 || n >= 240)) throw new Error('InvalidSlots');
    p.answers[user] = [...new Set(slots)];
    const at = commonSlot(p, Date.now());
    if (at !== undefined) { p.meetingAt = at; p.status = 'booking'; }
    this.save(p);
    if (p.status === 'booking') await this.ctx.storage.setAlarm(Date.now() + 1);
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
      if (Date.now() >= p.start + 5 * DAY) { p.status = 'cancelled'; p.error = '候補期間が終了しました。新しい日程調整を作成してください。'; this.save(p); }
      else await this.ctx.storage.setAlarm(p.start + 5 * DAY);
      return;
    }
    if (p.status !== 'booking') return;
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    try {
      const input: MeetingInput = { id: p.id, guild: p.guild, user: p.user, channel: p.channel, document: p.document, title: p.title, meetingAt: p.meetingAt!, runAt: p.meetingAt! - 3600_000 };
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
          body: JSON.stringify({ content: `次回MTGが確定しました。\n${jst(p.meetingAt!)} JST（${p.duration}分）\n参加者${p.members.length}名全員の空き時間が一致しました。\n1時間前に資料作成を開始します。\n確認: /mtg status id:${p.id}`, allowed_mentions: { parse: [] }, nonce: p.id, enforce_nonce: true }),
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
