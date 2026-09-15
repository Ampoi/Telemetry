import { DurableObject } from 'cloudflare:workers';
import { AppError } from './errors';
import { guildOwner } from './discord-guild';
import { accessToken, googleDocs } from './google';
import { discord, DiscordError } from './cloud/discord-rest';
import { iso, snowflake, type RemoteChannel, type RemoteMessage } from './cloud/model';
import { mediaUrl } from './cloud/media';
import { notificationText, summarizeMeeting, type SummaryEnv } from './meeting-summary';
import { agendaParts, agendaTextRequests, createDebugAgenda, DEBUG_MODEL, DEBUG_EFFORT, DEBUG_WEEK, type DebugResult } from './debug-agenda';
import { docsText, embeddable, jst, postText, splitText, textRequests, type ImagePart, type MeetingInput, type MeetingPost, type MeetingState } from './meeting-model';

type Task = { id: string; kind: string; channel: string; cursor: string | null };
type Part = { n: number; kind: string; value: string; status: string };
const terminal = new Set(['complete', 'failed', 'needs_review', 'cancelled', 'notification_failed', 'notification_review']);

// One persistent alarm/state machine per reservation. No Discord reply token is
// retained: completion notifications use the Bot token and a persisted channel.
export class MeetingScheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meeting (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT, kind INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel TEXT NOT NULL, cursor TEXT, done INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, created TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS posts_order ON posts(created,id);
        CREATE TABLE IF NOT EXISTS parts (n INTEGER PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
        CREATE TABLE IF NOT EXISTS agenda_result (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      `);
    });
  }
  private state(): MeetingState | undefined {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM meeting WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  private save(state: MeetingState): void {
    this.ctx.storage.sql.exec('INSERT INTO meeting(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', JSON.stringify(state));
  }
  async book(input: MeetingInput): Promise<ReturnType<MeetingScheduler['summary']>> {
    const previous = this.state();
    if (previous) {
      for (const key of ['id', 'guild', 'user', 'runAt', 'title', 'document', 'meetingAt', 'channel', 'mode', 'rangeFrom', 'rangeTo'] as const) {
        if (previous[key] !== input[key]) throw new Error('ReservationConflict');
      }
      // Retrying a lost acknowledgment never recreates a completed/cancelled job.
      if (previous.status === 'scheduled') await this.ctx.storage.setAlarm(previous.runAt);
      return this.summary();
    }
    const deadline = input.meetingAt ?? input.runAt;
    if (input.mode === 'debug-agenda') {
      if (!Number.isSafeInteger(input.rangeFrom) || !Number.isSafeInteger(input.rangeTo) || input.rangeTo! - input.rangeFrom! !== DEBUG_WEEK
          || input.rangeTo! > Date.now() || input.rangeTo! < Date.now() - 14 * 60_000 || input.runAt !== input.rangeTo || input.channel || input.meetingAt) throw new AppError(400, 'デバッグの期間・実行時刻が不正、または受付期限切れです。');
    } else if (deadline <= Date.now() || deadline > Date.now() + 366 * 86400_000) throw new Error('ReservationDateOutOfRange');
    const state: MeetingState = { ...input, status: 'scheduled', failures: 0, skipped: 0, imageFallbacks: 0, cursorCreated: '', cursorId: '', part: 0, textIndex: 1 };
    // SQL and alarm writes before the first await are atomically persisted.
    this.save(state);
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, input.runAt));
    return this.summary();
  }
  summary() {
    const state = this.state();
    if (!state) return null;
    const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM posts').one().n;
    const pending = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE done=0').one().n;
    return { id: state.id, guild: state.guild, runAt: state.runAt, meetingAt: state.meetingAt, channel: state.channel, notificationId: state.notificationId, title: state.title, status: state.status, url: state.url, error: state.error, posts: count, pending, skipped: state.skipped, imageFallbacks: state.imageFallbacks,
      mode: state.mode, rangeFrom: state.rangeFrom, rangeTo: state.rangeTo, model: state.mode ? DEBUG_MODEL : undefined, reasoningEffort: state.mode ? DEBUG_EFFORT : undefined, requestCount: state.requestCount, reviewedImages: state.reviewedImages };
  }
  async cancel() {
    const state = this.state();
    if (!state) throw new Error('ReservationNotFound');
    if (state.status === 'cancelled') return this.summary();
    if (state.status !== 'scheduled') throw new Error('ReservationAlreadyStarted');
    state.status = 'cancelled'; state.finished = Date.now(); this.save(state);
    await this.ctx.storage.deleteAlarm();
    return this.summary();
  }
  private task(id: string, kind: string, channel = '', cursor: string | null = null): void {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO tasks(id,kind,channel,cursor) VALUES(?,?,?,?)', id, kind, channel, cursor);
  }
  private addChannel(c: RemoteChannel, end: number, parent: string | null = null): void {
    this.ctx.storage.sql.exec('INSERT INTO channels(id,name,parent,kind) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name', c.id, c.name, parent, c.type);
    if (![15, 16].includes(c.type)) this.task(`scan:${c.id}`, 'scan', c.id, snowflake(end));
  }
  private async checkManager(state: MeetingState): Promise<void> {
    const guild = await discord<{ owner_id: string }>(this.env, `/guilds/${state.guild}`);
    if (guild.owner_id === state.user) return;
    const member = await discord<{ roles: string[] }>(this.env, `/guilds/${state.guild}/members/${state.user}`);
    const roles = await discord<{ id: string; permissions: string }[]>(this.env, `/guilds/${state.guild}/roles`);
    const allowed = roles.some(r => (r.id === state.guild || member.roles.includes(r.id)) && (BigInt(r.permissions) & (8n | 32n)) !== 0n);
    if (!allowed) throw new AppError(403, '予約者のサーバー管理権限がなくなったため停止しました。');
  }
  private async collect(state: MeetingState): Promise<void> {
    const task = this.ctx.storage.sql.exec<Task>('SELECT id,kind,channel,cursor FROM tasks WHERE done=0 ORDER BY id LIMIT 1').toArray()[0];
    if (!task) { state.status = state.mode === 'debug-agenda' ? 'generating' : 'preparing'; this.save(state); return; }
    if (task.kind === 'bootstrap') {
      await this.checkManager(state);
      const app = await discord<{ flags?: number; flags_new?: string }>(this.env, '/applications/@me');
      if ((BigInt(app.flags_new ?? app.flags ?? 0) & ((1n << 18n) | (1n << 19n))) === 0n) throw new AppError(400, 'Discord Developer PortalでMessage Content Intentを有効にしてください。本文を読めないため収集を停止しました。');
      // Refresh and scope checks happen before any history is read.
      await accessToken(this.env, guildOwner(state.guild));
      const channels = await discord<RemoteChannel[]>(this.env, `/guilds/${state.guild}/channels`);
      for (const c of channels.filter(c => [0, 2, 5, 13, 15, 16].includes(c.type))) {
        if (c.guild_id && c.guild_id !== state.guild) throw new Error('GuildMismatch');
        this.addChannel(c, state.runAt);
        if ([0, 5, 15, 16].includes(c.type)) this.task(`public:${c.id}`, 'public', c.id);
        if (c.type === 0) {
          this.task(`private:${c.id}`, 'private', c.id);
          this.task(`private-all:${c.id}`, 'private-all', c.id);
        }
      }
      this.task('threads-active', 'active');
    } else if (task.kind === 'scan') {
      const messages = await discord<RemoteMessage[]>(this.env, `/channels/${task.channel}/messages?limit=100&before=${task.cursor}`);
      const channel = this.ctx.storage.sql.exec<{ name: string; parent: string | null }>('SELECT name,parent FROM channels WHERE id=?', task.channel).one();
      for (const m of messages) {
        if (m.channel_id !== task.channel) throw new Error('ChannelMismatch');
        if (Date.parse(m.timestamp) >= state.runAt || (state.rangeFrom !== undefined && Date.parse(m.timestamp) < state.rangeFrom) || m.author.id === this.env.DISCORD_APPLICATION_ID) continue;
        const post: MeetingPost = { ...m, channel_name: channel.name, parent_id: channel.parent };
        this.ctx.storage.sql.exec('INSERT INTO posts(id,created,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', m.id, iso(m.timestamp), JSON.stringify(post));
      }
      if (state.mode && this.ctx.storage.sql.exec<{ n: number; bytes: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(length(data)),0) AS bytes FROM posts').toArray().some(r => r.n > 2000 || r.bytes > 1_500_000)) throw new AppError(400, 'デバッグ上限（2000投稿・本文メタデータ150万文字）を超えました。Docs作成前に停止しました。');
      if (messages.length === 100 && !messages.some(m => state.rangeFrom !== undefined && Date.parse(m.timestamp) < state.rangeFrom)) {
        const before = messages.reduce((min, m) => BigInt(m.id) < BigInt(min) ? m.id : min, task.cursor!);
        if (BigInt(before) >= BigInt(task.cursor!)) throw new Error('PaginationStalled');
        this.ctx.storage.sql.exec('UPDATE tasks SET cursor=? WHERE id=?', before, task.id); return;
      }
    } else {
      const suffix = task.cursor ? `&before=${encodeURIComponent(task.cursor)}` : '';
      const path = task.kind === 'active' ? `/guilds/${state.guild}/threads/active`
        : task.kind === 'public' ? `/channels/${task.channel}/threads/archived/public?limit=100${suffix}`
        : task.kind === 'private-all' ? `/channels/${task.channel}/threads/archived/private?limit=100${suffix}`
        : `/channels/${task.channel}/users/@me/threads/archived/private?limit=100${suffix}`;
      const page = await discord<{ threads: RemoteChannel[]; has_more?: boolean }>(this.env, path);
      for (const thread of page.threads) {
        if (![10, 11, 12].includes(thread.type) || !thread.parent_id) continue;
        const parent = this.ctx.storage.sql.exec('SELECT id FROM channels WHERE id=? AND parent IS NULL', thread.parent_id).toArray()[0];
        if (!parent || (task.kind !== 'active' && thread.parent_id !== task.channel)) continue;
        this.addChannel(thread, state.runAt, thread.parent_id);
      }
      if (task.kind !== 'active' && page.has_more) {
        const last = page.threads.at(-1);
        const before = task.kind === 'private' ? last?.id : last?.thread_metadata?.archive_timestamp;
        if (!before || before === task.cursor) throw new Error('PaginationStalled');
        this.ctx.storage.sql.exec('UPDATE tasks SET cursor=? WHERE id=?', before, task.id); return;
      }
    }
    this.ctx.storage.sql.exec('UPDATE tasks SET done=1 WHERE id=?', task.id);
  }
  private addText(state: MeetingState, value: string): void {
    for (const text of splitText(docsText(value))) {
      const last = this.ctx.storage.sql.exec<Part>('SELECT * FROM parts WHERE n=?', state.part - 1).toArray()[0];
      if (last?.kind === 'text' && last.value.length + text.length <= 12_000) this.ctx.storage.sql.exec('UPDATE parts SET value=? WHERE n=?', last.value + text, last.n);
      else this.ctx.storage.sql.exec('INSERT INTO parts(n,kind,value) VALUES(?,?,?)', state.part++, 'text', text);
    }
  }
  private async generate(state: MeetingState): Promise<void> {
    if (state.generationStarted && !state.generationComplete) throw new AppError(409, 'AI生成が中断し結果を確認できません。重複課金を避けるため自動再実行しません。');
    await this.checkManager(state);
    const posts = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM posts ORDER BY created,id').toArray().map(r => JSON.parse(r.data) as MeetingPost);
    if (!state.generationComplete) {
      const apiKey = (this.env as Env & { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
      if (!apiKey) throw new AppError(400, 'OPENAI_API_KEYをWorkerのSecretへ設定してください。');
      state.generationStarted = true; this.save(state);
      await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
      await this.ctx.storage.sync();
      let result: DebugResult;
      try { result = await createDebugAgenda(posts, state, apiKey); }
      catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(400, `アジェンダ生成を停止しました（${error instanceof Error && /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'GENERATION_FAILED'}）。AI生成は自動再試行しません。`);
      }
      this.ctx.storage.sql.exec('INSERT INTO agenda_result(id,data) VALUES(1,?)', JSON.stringify(result));
      state.generationComplete = true; state.requestCount = result.metadata.requestCount; state.reviewedImages = result.metadata.imageCount;
      this.save(state); await this.ctx.storage.sync();
    }
    const result: DebugResult = JSON.parse(this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM agenda_result WHERE id=1').one().data);
    // Transactionally prepare all output parts; an eviction cannot append them twice.
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM parts'); state.part = 0;
      let text = '';
      const flush = () => { if (text) { this.ctx.storage.sql.exec('INSERT INTO parts(n,kind,value) VALUES(?,?,?)', state.part++, 'markdown', text); text = ''; } };
      for (const p of agendaParts(result, posts)) {
        if (p.kind === 'image') { flush(); this.ctx.storage.sql.exec('INSERT INTO parts(n,kind,value) VALUES(?,?,?)', state.part++, p.kind, p.value); }
        else for (const chunk of splitText(p.value)) { if (text.length + chunk.length > 12_000) flush(); text += chunk; }
      }
      flush(); state.status = 'adding'; this.task('docs-add', 'docs'); this.save(state);
    });
  }
  private prepare(state: MeetingState): void {
    if (state.part === 0) this.addText(state, `${state.title}\nMTG日時: ${jst(state.meetingAt ?? state.runAt)} JST\n収集開始: ${jst(state.runAt)} JST\n収集範囲: サーバー内の取得可能な全履歴（収集開始時刻未満）\n投稿は収集時点の状態です。閲覧できないチャンネル・スレッド、削除済み投稿は含みません。\n画像は対応形式のみ埋め込み、動画はリンクです。添付URLには有効期限があります。\n\n`);
    const rows = this.ctx.storage.sql.exec<{ id: string; created: string; data: string }>('SELECT id,created,data FROM posts WHERE (created,id)>(?,?) ORDER BY created,id LIMIT 50', state.cursorCreated, state.cursorId).toArray();
    for (const row of rows) {
      const post: MeetingPost = JSON.parse(row.data);
      this.addText(state, postText(state.guild, post));
      for (const a of post.attachments.filter(embeddable)) {
        const value: ImagePart = { channel: post.channel_id, message: post.id, attachment: a.id };
        this.ctx.storage.sql.exec('INSERT INTO parts(n,kind,value) VALUES(?,?,?)', state.part++, 'image', JSON.stringify(value));
        this.addText(state, '\n');
      }
      state.cursorCreated = row.created; state.cursorId = row.id;
    }
    if (rows.length < 50) {
      const total = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM posts').one().n;
      this.addText(state, `\n収集投稿数: ${total}\nアクセスできずスキップした取得処理: ${state.skipped}\n`);
      state.status = 'adding';
      // The separate marker distinguishes "ready to add" from an uncertain call.
      this.task('docs-add', 'docs');
    }
    this.save(state);
  }
  private async addTab(state: MeetingState): Promise<void> {
    const marker = this.ctx.storage.sql.exec<{ done: number }>("SELECT done FROM tasks WHERE id='docs-add'").one();
    if (marker.done) throw new AppError(409, 'タブ作成の結果が不明です。ドキュメントを確認してください。');
    await this.checkManager(state);
    const token = await accessToken(this.env, guildOwner(state.guild));
    this.ctx.storage.sql.exec("UPDATE tasks SET done=1 WHERE id='docs-add'");
    await this.ctx.storage.sync();
    const result = await googleDocs<{ replies: { addDocumentTab?: { tabProperties: { tabId: string } } }[] }>(token, `${state.document}:batchUpdate`, {
      requests: [{ addDocumentTab: { tabProperties: { title: state.title } } }],
    });
    const tabId = result.replies?.[0]?.addDocumentTab?.tabProperties.tabId;
    if (!tabId) throw new Error('MissingTabId');
    state.tabId = tabId; state.url = `https://docs.google.com/document/d/${state.document}/edit?tab=${encodeURIComponent(tabId)}`;
    state.status = 'writing'; this.save(state);
    await this.ctx.storage.sync();
  }
  private async writePart(state: MeetingState): Promise<void> {
    const part = this.ctx.storage.sql.exec<Part>("SELECT * FROM parts WHERE status<>'done' ORDER BY n LIMIT 1").toArray()[0];
    if (!part) { state.status = state.channel ? 'summarizing' : 'complete'; state.finished = Date.now(); this.save(state); return; }
    if (part.status === 'writing') throw new AppError(409, '本文・画像の書き込み結果が不明です。作成済みタブを確認してください。');
    let requests: Record<string, unknown>[];
    if (part.kind === 'image') {
      const image: ImagePart = JSON.parse(part.value);
      // Renew expiring CDN links just before Google fetches the image.
      let attachment: RemoteMessage['attachments'][number] | undefined;
      try {
        const message = await discord<RemoteMessage>(this.env, `/channels/${image.channel}/messages/${image.message}`);
        if (message.id !== image.message || message.channel_id !== image.channel) throw new Error('MessageMismatch');
        attachment = message.attachments.find(a => a.id === image.attachment);
      } catch (error) {
        if (!(error instanceof DiscordError && [403, 404].includes(error.httpStatus))) throw error;
      }
      if (!attachment || !embeddable(attachment)) { this.fallback(state, part); return; }
      requests = [{ insertInlineImage: { endOfSegmentLocation: { tabId: state.tabId }, uri: mediaUrl(attachment.url), objectSize: { width: { magnitude: 400, unit: 'PT' } } } }];
    } else requests = part.kind === 'markdown' ? agendaTextRequests(part.value, state.tabId!, state.textIndex).requests : textRequests(part.value, state.tabId!, state.textIndex);
    const token = await accessToken(this.env, guildOwner(state.guild));
    this.ctx.storage.sql.exec("UPDATE parts SET status='writing' WHERE n=?", part.n);
    await this.ctx.storage.sync();
    try { await googleDocs(token, `${state.document}:batchUpdate`, { requests }); }
    catch (error) {
      // A rejected image request is atomic and made no edit. Keep the text link.
      if (part.kind === 'image' && error instanceof AppError && error.details?.googleStatus === 400) { this.fallback(state, part); return; }
      throw error;
    }
    this.ctx.storage.sql.exec("UPDATE parts SET status='done' WHERE n=?", part.n);
    state.textIndex += part.kind === 'image' ? 1 : part.kind === 'markdown' ? agendaTextRequests(part.value, state.tabId!, state.textIndex).text.length : part.value.length;
    this.save(state);
    await this.ctx.storage.sync();
  }
  private fallback(state: MeetingState, part: Part): void {
    this.ctx.storage.sql.exec("UPDATE parts SET status='done' WHERE n=?", part.n);
    state.imageFallbacks++; this.save(state);
  }
  private async summarize(state: MeetingState): Promise<void> {
    // Read bounded text parts in chronological order, retaining the merged summary.
    const part = this.ctx.storage.sql.exec<Part>("SELECT * FROM parts WHERE kind='text' AND n>=? ORDER BY n LIMIT 1", state.summaryPart ?? 0).toArray()[0];
    const total = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM posts').one().n;
    if (!total) state.agendaLines = ['収集対象の投稿がありませんでした。', '投稿から議題を抽出できませんでした。', '当日の議題はMTGで確認してください。'];
    else if (part) {
      state.agendaLines = await summarizeMeeting(this.env as Env & SummaryEnv, state.agendaLines ?? [], part.value);
      state.summaryPart = part.n + 1;
      this.save(state); return;
    }
    state.status = 'notifying'; this.save(state);
  }
  private async notify(state: MeetingState): Promise<void> {
    if (state.notificationAttempted) {
      state.status = 'notification_review'; state.error = '通知の送信結果が不明です。通知先チャンネルを確認してください。'; this.save(state); return;
    }
    await this.checkManager(state);
    const channel = await discord<RemoteChannel>(this.env, `/channels/${state.channel}`);
    if (channel.guild_id !== state.guild) throw new AppError(403, '通知先のサーバーが一致しません。');
    if (!state.url || state.agendaLines?.length !== 3) throw new AppError(400, '完成通知の情報が不足しています。');
    const content = `@everyone\nMTG日時: ${jst(state.meetingAt ?? state.runAt)} JST\n${notificationText(state.title)} の資料が完成しました。\n${state.url}\n議題の要約:\n${state.agendaLines.map(line => `・${notificationText(line)}`).join('\n')}${state.skipped ? '\n※取得できなかったチャンネル・スレッドがあります。' : ''}`;
    state.notificationAttempted = true; this.save(state);
    await this.ctx.storage.sync();
    const response = await fetch(`https://discord.com/api/v10/channels/${state.channel}/messages`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: ['everyone'] }, nonce: state.id, enforce_nonce: true }),
    });
    if (response.status === 429) {
      const body = await response.json() as { retry_after?: number };
      state.notificationAttempted = false; this.save(state);
      throw new DiscordError(429, 0, Math.max(1, Math.ceil(body.retry_after ?? 5)));
    }
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel(); state.notificationAttempted = false; this.save(state);
      throw new AppError(403, `Docsは完成しましたが通知できませんでした（HTTP ${response.status}）。Botの送信・全員メンション権限を確認してください。`);
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('NotificationUncertain'); }
    const result = await response.json() as { id?: string; mention_everyone?: boolean };
    if (!result.id) throw new Error('NotificationUncertain');
    state.notificationId = result.id;
    state.status = result.mention_everyone ? 'complete' : 'notification_failed';
    if (!result.mention_everyone) state.error = '通知は投稿されましたが全員メンションが無効でした。Botに全員メンション権限を設定してください。';
    this.save(state);
  }
  async alarm(): Promise<void> {
    const state = this.state();
    if (!state || terminal.has(state.status)) { await this.ctx.storage.deleteAlarm(); return; }
    if (state.runAt > Date.now()) { await this.ctx.storage.setAlarm(state.runAt); return; }
    // A crash retains a future wakeup even if the platform's retry budget expires.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    try {
      if (state.status === 'scheduled') {
        // Cancellation can interleave at the preceding await.
        if (this.state()?.status !== 'scheduled') { await this.ctx.storage.deleteAlarm(); return; }
        state.status = 'collecting'; state.started = Date.now(); this.task('!bootstrap', 'bootstrap'); this.save(state);
      }
      if (Date.now() - state.started! > 7 * 86400_000) throw new AppError(400, '7日間で処理が完了しなかったため停止しました。');
      const phase = state.status;
      if (phase === 'collecting') {
        for (let i = 0; i < 3 && state.status === 'collecting'; i++) await this.collect(state);
      } else if (phase === 'preparing') this.prepare(state);
      else if (phase === 'generating') await this.generate(state);
      else if (phase === 'adding') await this.addTab(state);
      else if (phase === 'writing') await this.writePart(state);
      else if (phase === 'summarizing') await this.summarize(state);
      else if (phase === 'notifying') await this.notify(state);
      state.failures = 0; this.save(state);
      if (terminal.has(state.status)) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now() + (state.status === 'writing' ? 1500 : 1000));
    } catch (error) {
      const unsafe = this.ctx.storage.sql.exec("SELECT n FROM parts WHERE status='writing' LIMIT 1").toArray().length > 0
        || (state.status === 'adding' && this.ctx.storage.sql.exec<{ done: number }>("SELECT done FROM tasks WHERE id='docs-add'").toArray()[0]?.done === 1);
      const task = this.ctx.storage.sql.exec<Task>('SELECT id,kind,channel,cursor FROM tasks WHERE done=0 ORDER BY id LIMIT 1').toArray()[0];
      if (!unsafe && state.status === 'collecting' && task && task.kind !== 'bootstrap' && error instanceof DiscordError && [403, 404].includes(error.httpStatus)) {
        this.ctx.storage.sql.exec('UPDATE tasks SET done=1 WHERE id=?', task.id); state.skipped++; state.failures = 0;
      } else {
        const limited = error instanceof DiscordError && error.httpStatus === 429;
        if (!limited) state.failures++;
        const permanent = error instanceof AppError && [400, 401, 403, 409].includes(error.status);
        if (unsafe || permanent || state.failures >= 6 || state.notificationAttempted) {
          state.status = state.status === 'notifying' && state.notificationAttempted ? 'notification_review'
            : ['summarizing', 'notifying'].includes(state.status) ? 'notification_failed' : unsafe ? 'needs_review' : 'failed'; state.finished = Date.now();
          state.error = state.status === 'notification_review' ? 'Docsは完成しましたが通知の送信結果が不明です。通知先チャンネルを確認してください。'
            : error instanceof AppError ? error.message : '処理が中断しました。権限と作成済みドキュメントを確認してください。';
        }
      }
      this.save(state);
      if (terminal.has(state.status)) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now() + (error instanceof DiscordError && error.httpStatus === 429 ? error.retryAfter * 1000 : Math.min(300_000, 5000 * 2 ** state.failures)));
    }
  }
}
