import { Client, GatewayIntentBits, Partials, PermissionFlagsBits, ChannelType, Events, type Guild, type GuildBasedChannel, type Message, type TextChannel, type ForumChannel, type ThreadChannel } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.ts';
import { iso, safeError, snowflakeAt, type RecordData, type Attachment } from './model.ts';
import { Store } from './store.ts';
import { Attachments } from './attachments.ts';

type ReadChannel = TextChannel | ThreadChannel;
export function inScope(config: Pick<Config, 'guild' | 'channels'>, channel: { guildId: string; id: string; parentId: string | null; isThread(): boolean }): boolean {
  return channel.guildId === config.guild && config.channels.has(channel.isThread() ? channel.parentId ?? '' : channel.id);
}
export function acceptAuthor(config: Pick<Config, 'includeBots' | 'includeWebhooks'>, self: string, author: { id: string; bot?: boolean }, webhook: string | null): boolean {
  if (author.id === self) return false;
  return webhook ? config.includeWebhooks : !author.bot || config.includeBots;
}
export function messageRecord(message: Message<true>, department: string | null, observed: string): RecordData {
  const channel = message.channel, thread = channel.isThread() ? channel : null;
  return { guild_id: message.guildId, channel_id: channel.id, channel_name: channel.name,
    thread_id: thread?.id ?? null, thread_name: thread?.name ?? null, parent_channel_id: thread?.parentId ?? null,
    message_id: message.id, author_id: message.author.id, author_display_name: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    content: message.content, created_at: iso(message.createdTimestamp), edited_at: message.editedTimestamp ? iso(message.editedTimestamp) : null, collected_at: observed,
    reply_to_message_id: message.reference?.messageId ?? null, reply_to_channel_id: message.reference?.channelId ?? null,
    jump_url: message.url, department,
    attachments: [...message.attachments.values()].map(a => ({ attachment_id: a.id, filename: a.name, content_type: a.contentType, size: a.size, url: a.url })) };
}
export class Collector {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Message, Partials.Channel], rest: { timeout: 20_000, retries: 3 } });
  readonly attachments: Attachments;
  private stopSignal = new AbortController();
  private scans: Promise<void> = Promise.resolve();
  private liveQueued = false;
  private backfillQueued = false;
  private loops: Promise<void>[] = [];
  private events = new Set<Promise<unknown>>();
  constructor(readonly config: Config, readonly store: Store) {
    this.attachments = new Attachments(config, store, key => this.refresh(key));
    this.client.on(Events.Error, e => this.log('discord_error', e));
    this.client.on(Events.ShardError, e => this.log('connection_error', e));
    this.client.on(Events.MessageCreate, message => this.track(this.ingest(message, iso(), true)));
    // Raw edits keep absent fields absent, including uncached messages.
    this.client.on(Events.Raw, packet => { if (['MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK'].includes(packet.t)) this.track(this.raw(packet.t, packet.d as RawMessage, iso())); });
    this.client.on(Events.ShardResume, () => this.recover());
    this.client.on(Events.ThreadCreate, () => this.recover());
    this.client.on(Events.ThreadMembersUpdate, () => this.recover());
    this.client.on(Events.InteractionCreate, interaction => {
      if (config.controlMode !== 'gateway' || !interaction.isChatInputCommand() || interaction.commandName !== 'telemetry') return;
      this.track((async () => {
        await interaction.deferReply({ flags: 64 });
        const command = interaction.options.getSubcommand();
        const content = await this.command(interaction.id, interaction.guildId ?? '', interaction.user.id, command, interaction.options.getInteger('days') ?? undefined);
        await interaction.editReply({ content, allowedMentions: { parse: [] } });
      })());
    });
  }
  private log(event: string, error: unknown) { console.error(JSON.stringify({ event, error: safeError(error) })); }
  private track(task: Promise<unknown>) { this.events.add(task); void task.catch(e => this.log('event_failed', e)).finally(() => this.events.delete(task)); }
  private async guild(): Promise<Guild> { return this.client.guilds.fetch(this.config.guild); }
  async allowed(channel: GuildBasedChannel | ThreadChannel | null): Promise<boolean> {
    if (!channel || !inScope(this.config, channel) || ![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type)) return false;
    const me = await channel.guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) return false;
    if (channel.type === ChannelType.PrivateThread) {
      try { await channel.members.fetch({ member: me.id, cache: false }); } catch (e) { if ([10007, 10013].includes(Number((e as { code?: number }).code))) return false; throw e; }
    }
    return true;
  }
  async ingest(message: Message, observed: string, live = false) {
    if (!message.inGuild() || !await this.allowed(message.channel)) return;
    if (!acceptAuthor(this.config, this.client.user!.id, message.author, message.webhookId)) return;
    const parent = message.channel.isThread() ? message.channel.parentId! : message.channelId;
    this.store.upsert(messageRecord(message, this.config.channels.get(parent) ?? null, observed), observed, live);
    this.attachments.pump();
  }
  async refresh(key: string) {
    const saved = this.store.get(key); if (!saved || saved.deleted) return;
    const channel = await (await this.guild()).channels.fetch(saved.channel_id);
    if (!await this.allowed(channel) || !channel || !('messages' in channel)) return;
    const observed = iso();
    try { const message = await (channel as ReadChannel).messages.fetch({ message: key, force: true, cache: false }); await this.ingest(message, observed); }
    catch (e) { if (Number((e as { code?: number }).code) === 10008) { this.store.delete(key, saved.channel_id); this.attachments.cleanup(); } else throw e; }
  }
  private async raw(kind: string, data: RawMessage, observed: string) {
    if (data.guild_id !== this.config.guild) return;
    if (kind !== 'MESSAGE_UPDATE') {
      const keys = kind === 'MESSAGE_DELETE_BULK' ? data.ids ?? [] : [data.id];
      let allowed: boolean | undefined;
      for (const key of keys) {
        const saved = this.store.get(key);
        if (saved && saved.channel_id !== data.channel_id) continue;
        if (!saved) {
          allowed ??= await this.allowed(await (await this.guild()).channels.fetch(data.channel_id));
          if (!allowed) continue;
        }
        this.store.delete(key, data.channel_id, observed);
      }
      this.attachments.cleanup(); return;
    }
    const channel = await (await this.guild()).channels.fetch(data.channel_id);
    if (!await this.allowed(channel) || !channel || !('messages' in channel)) return;
    const patch: Partial<RecordData> = {};
    if ('content' in data) patch.content = data.content;
    if (data.edited_timestamp) patch.edited_at = iso(data.edited_timestamp);
    if (data.attachments) patch.attachments = data.attachments.map(a => ({ attachment_id: a.id, filename: a.filename, content_type: a.content_type ?? null, size: a.size, url: a.url }));
    if (this.store.get(data.id)) this.store.patch(data.id, patch, observed);
    else {
      try {
        const message = await (channel as ReadChannel).messages.fetch({ message: data.id, force: true, cache: false });
        await this.ingest(message, observed);
        this.store.patch(data.id, {}, observed);
      } catch (e) { if (Number((e as { code?: number }).code) === 10008) this.store.delete(data.id, data.channel_id); else throw e; }
    }
    this.attachments.pump();
  }
  recover() {
    if (this.liveQueued || this.stopSignal.signal.aborted || !this.client.isReady()) return;
    this.liveQueued = true;
    this.scans = this.scans.then(() => this.scan('live')).catch(e => this.log('recovery_failed', e)).finally(() => { this.liveQueued = false; });
  }
  private async scan(kind: 'live' | 'backfill', days?: number) {
    if (this.stopSignal.signal.aborted) return;
    const job = randomUUID(), end = iso(), start = kind === 'backfill' ? iso(Date.now() - days! * 86400_000) : this.store.meta('initial_start')!;
    this.store.startJob(job, kind);
    let failed = false;
    const channels = new Map<string, ReadChannel>();
    const failure = (key: string, e: unknown) => { failed = true; this.store.jobChannel(job, key, start, end, 'failed', safeError(e)); };
    const consider = async (channel: GuildBasedChannel) => { if (await this.allowed(channel) && 'messages' in channel && !channel.isVoiceBased()) channels.set(channel.id, channel as ReadChannel); };
    try {
      const guild = await this.guild();
      for (const key of this.config.channels.keys()) {
        try {
          const parent = await guild.channels.fetch(key, { force: true });
          if (!parent || !await this.allowed(parent)) throw new Error('ChannelUnavailable');
          await consider(parent);
          if ('threads' in parent) {
            const manager = (parent as TextChannel | ForumChannel).threads;
            for (const type of parent.type === ChannelType.GuildText ? ['public', 'private'] as const : ['public'] as const) {
              try {
                let before: string | Date | undefined;
                while (!this.stopSignal.signal.aborted) {
                  const page = await manager.fetchArchived({ type, fetchAll: false, before, limit: 100 });
                  for (const thread of page.threads.values()) { try { await consider(thread); } catch (e) { failure(thread.id, e); } }
                  if (!page.hasMore || page.threads.size === 0) break;
                  const threads = [...page.threads.values()];
                  const next = type === 'private' ? threads.reduce((a, b) => BigInt(a.id) < BigInt(b.id) ? a : b).id : new Date(Math.min(...threads.map(t => t.archiveTimestamp ?? NaN)));
                  if (String(next) === String(before) || (next instanceof Date && !Number.isFinite(next.getTime()))) throw new Error('ArchivePaginationStopped');
                  before = next;
                }
              } catch (e) { failure(`${key}:${type}`, e); }
            }
          }
        } catch (e) { failure(key, e); }
      }
      try { for (const thread of (await guild.channels.fetchActiveThreads()).threads.values()) { try { await consider(thread); } catch (e) { failure(thread.id, e); } } } catch (e) { failure('active_threads', e); }
      for (const key of this.store.channels()) if (!channels.has(key)) {
        try { const channel = await guild.channels.fetch(key, { force: true }); if (channel) await consider(channel); } catch (e) { failure(key, e); }
      }
      for (const channel of channels.values()) {
        if (this.stopSignal.signal.aborted) { failure(channel.id, new Error('Interrupted')); break; }
        this.store.jobChannel(job, channel.id, start, end, 'running');
        try {
          let after = kind === 'live' ? this.store.cursor('live', channel.id) ?? snowflakeAt(Date.parse(start)) : snowflakeAt(Date.parse(start));
          const before = snowflakeAt(Date.parse(end));
          while (!this.stopSignal.signal.aborted && BigInt(after) < BigInt(before)) {
            const previousAfter = after;
            if (!await this.allowed(channel)) throw new Error('ChannelUnavailable');
            const observed = iso();
            const page = await channel.messages.fetch({ after, limit: 100, cache: false });
            const sorted = [...page.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
            let reachedEnd = false;
            for (const message of sorted) {
              if (BigInt(message.id) <= BigInt(after)) continue;
              if (BigInt(message.id) > BigInt(before)) { reachedEnd = true; break; }
              await this.ingest(message, observed); after = message.id; this.store.advance(kind, channel.id, after);
            }
            if (reachedEnd || page.size < 100) break;
            if (after === previousAfter) throw new Error('HistoryPaginationStopped');
          }
          if (this.stopSignal.signal.aborted) throw new Error('Interrupted');
          if (kind === 'live') this.store.advance(kind, channel.id, before);
          this.store.jobChannel(job, channel.id, start, end, 'complete');
        } catch (e) { failure(channel.id, e); }
      }
    } catch (e) { failure('discovery', e); }
    finally { this.store.finishJob(job, failed); }
  }
  async command(key: string, guild: string, user: string, kind: string, days?: number): Promise<string> {
    if (guild !== this.config.guild) return 'このサーバーは収集対象ではありません。';
    const member = await (await this.guild()).members.fetch({ user, force: true });
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) return 'サーバー管理権限が必要です。';
    const previous = this.store.control(key); if (previous) return previous;
    let result: string;
    if (kind === 'status') result = '収集状況\n```json\n' + JSON.stringify(this.store.status(), null, 2).slice(0, 1800) + '\n```';
    else if (kind === 'backfill') {
      if (!Number.isInteger(days) || days! < 1 || days! > 3650) return 'daysは1〜3650の整数で指定してください。';
      if (this.backfillQueued) result = '履歴取得は既に実行中です。/telemetry statusで確認してください。';
      else {
        this.backfillQueued = true;
        result = `過去${days}日分の履歴取得を受け付けました。/telemetry statusで確認してください。再起動で中断した場合は再実行してください。`;
        this.scans = this.scans.then(() => this.scan('backfill', days)).catch(e => this.log('backfill_failed', e)).finally(() => { this.backfillQueued = false; });
      }
    } else return '未対応のコマンドです。';
    this.store.saveControl(key, result); return result;
  }
  private async controlLoop() {
    while (!this.stopSignal.signal.aborted) {
      try {
        const response = await this.api(`/api/collector/commands?guild=${this.config.guild}`);
        const body = await response.json() as { commands: { id: string; guild: string; user: string; kind: string; days?: number; lease: string }[] };
        for (const command of body.commands) {
          if (this.stopSignal.signal.aborted) break;
          let content: string;
          try { content = await this.command(command.id, command.guild, command.user, command.kind, command.days); }
          catch (e) { content = `権限または接続を確認してください（${safeError(e)}）。`; }
          const reply = await this.api(`/api/collector/commands/${command.id}/result`, { guild: this.config.guild, lease: command.lease, content });
          await reply.body?.cancel();
        }
      } catch (e) { if (!this.stopSignal.signal.aborted) this.log('control_poll_failed', e); }
      await delay(3000, undefined, { signal: this.stopSignal.signal }).catch(() => {});
    }
  }
  private async api(path: string, body?: unknown) {
    const response = await fetch(this.config.origin + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.any([this.stopSignal.signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('WorkerRequestFailed'), { status: response.status }); } return response;
  }
  async start() {
    this.store.recover();
    if (!this.store.meta('initial_start')) this.store.setMeta('initial_start', iso());
    await this.client.login(this.config.token);
    if (!this.client.isReady()) await new Promise<void>(resolve => this.client.once(Events.ClientReady, () => resolve()));
    await this.guild(); this.attachments.pump(); this.recover();
    this.loops.push((async () => {
      while (!this.stopSignal.signal.aborted) {
        await delay(this.config.recoverySeconds * 1000, undefined, { signal: this.stopSignal.signal }).catch(() => {});
        this.attachments.pump(); this.recover();
      }
    })());
    if (this.config.controlMode === 'worker') this.loops.push(this.controlLoop());
    console.log('収集Botを起動しました。履歴取得は /telemetry backfill days:日数 で実行してください。');
  }
  async close() {
    this.stopSignal.abort(); await this.client.destroy();
    await Promise.allSettled(this.loops); await this.scans; await Promise.allSettled(this.events); await this.attachments.close();
  }
}
interface RawMessage { guild_id: string; channel_id: string; id: string; ids?: string[]; content?: string; edited_timestamp?: string | null; attachments?: { id: string; filename: string; content_type?: string; size: number; url: string }[] }
