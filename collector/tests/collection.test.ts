import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Collection } from 'discord.js';
import { Collector } from '../src/bot.ts';
import { Store } from '../src/store.ts';
import { iso, snowflakeAt, type RecordData } from '../src/model.ts';
import type { Config } from '../src/config.ts';

function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-scan-')), guildId = '123456789012345678', channelId = '223456789012345678';
  const config: Config = { guild: guildId, token: 'fake', channels: new Map([[channelId, null]]), database: join(root, 'test.sqlite3'), attachments: join(root, 'attachments'), exports: join(root, 'exports'), maxBytes: 100, concurrency: 1, timeout: 1000, retries: 0, minFree: 0, includeBots: false, includeWebhooks: false, recoverySeconds: 300, controlMode: 'gateway', origin: 'http://localhost:8787', apiKey: '' };
  const store = new Store(config.database, guildId), bot = new Collector(config, store);
  // Discord transport only is replaced; scan/store/raw event code is real.
  const guild: any = { id: guildId, members: { fetchMe: async () => ({ id: 'self' }), fetch: async () => ({ permissions: { has: () => true } }) }, channels: {} };
  const channel: any = { id: channelId, guildId, name: 'test', guild, type: ChannelType.GuildText, parentId: null, isThread: () => false, isVoiceBased: () => false, permissionsFor: () => ({ has: () => true }), messages: { fetch: async () => new Collection() } };
  const channels = new Map([[channelId, channel]]);
  guild.channels.fetch = async (id: string) => channels.get(id) ?? null;
  guild.channels.fetchActiveThreads = async () => ({ threads: new Collection() });
  bot.client.guilds.fetch = async () => guild;
  Object.defineProperty(bot.client, 'user', { value: { id: 'self' } });
  const initial = Date.now() - 3600_000, first = BigInt(snowflakeAt(initial));
  store.setMeta('initial_start', iso(initial));
  const message = (n: number, ch = channel): any => ({ id: (first + BigInt(n)).toString(), guildId, channelId: ch.id, channel: ch, author: { id: 'author', bot: false, username: 'author' }, webhookId: null, content: `message-${n}`, createdTimestamp: initial, editedTimestamp: null, attachments: new Collection(), url: 'https://discord.com/channels/test', inGuild: () => true });
  const internals = bot as unknown as { scan(kind: 'live' | 'backfill', days?: number): Promise<void>; raw(kind: string, data: unknown, observed: string): Promise<void> };
  t.after(async () => { await bot.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { bot, store, guild, channel, channels, config, message, first, internals };
}
test('history pages >100 are sorted, stored once, and resume from completed cursor', async t => {
  const f = setup(t), items = Array.from({ length: 205 }, (_, i) => f.message(i + 1)); let calls = 0;
  f.channel.messages.fetch = async ({ after }: { after: string }) => { calls++; return new Collection(items.filter(m => BigInt(m.id) > BigInt(after)).slice(0, 100).reverse().map(m => [m.id, m])); };
  await f.internals.scan('live'); assert.equal(calls, 3); assert.equal(f.store.status().messages[0].count, 205);
  await f.internals.scan('live'); assert.equal(f.store.status().messages[0].count, 205); assert.equal(f.store.status().jobs[0].state, 'complete');
});
test('scan request observation prevents an in-flight history snapshot undoing edit', async t => {
  const f = setup(t), m = f.message(1); await f.bot.ingest(m, iso());
  f.channel.messages.fetch = async () => { f.store.patch(m.id, { content: 'edited while fetching' }); return new Collection([[m.id, m]]); };
  await f.internals.scan('live'); assert.equal(f.store.get(m.id)!.content, 'edited while fetching');
});
test('history request failure leaves cursor for retry and reports time range', async t => {
  const f = setup(t); f.channel.messages.fetch = async () => { throw Object.assign(new Error('contains secret but not logged'), { status: 403 }); };
  await f.internals.scan('live'); assert.equal(f.store.cursor('live', f.channel.id), undefined);
  const error = f.store.status().errors[0]; assert.equal(error.error, 'Error:403'); assert.ok(error.start); assert.ok(error.end);
});
test('backfill always rescans requested range independently of live cursor', async t => {
  const f = setup(t), afters: string[] = []; f.channel.messages.fetch = async ({ after }: { after: string }) => { afters.push(after); return new Collection([[f.message(1).id, f.message(1)]]); };
  f.store.advance('live', f.channel.id, snowflakeAt(Date.now())); f.store.advance('backfill', f.channel.id, snowflakeAt(Date.now()));
  await f.internals.scan('backfill', 7); await f.internals.scan('backfill', 7);
  assert.equal(afters.length, 2); assert.ok(afters.every(a => BigInt(a) < f.first)); assert.equal(f.store.status().messages[0].count, 1);
});
test('public and joined-private archives paginate independently and isolate thread failures', async t => {
  const f = setup(t), seen: { type: string; before?: string | Date }[] = [];
  const thread = (id: string, archiveTimestamp: number): any => ({ ...f.channel, id, parentId: f.channel.id, type: ChannelType.PublicThread, isThread: () => true, archiveTimestamp });
  const one = thread('323456789012345678', Date.now() - 1000), two = thread('323456789012345679', Date.now() - 2000);
  f.channel.threads = { fetchArchived: async (options: { type: string; before?: string | Date }) => { seen.push(options); if (options.type === 'private') return { threads: new Collection(), hasMore: false }; return options.before ? { threads: new Collection([[two.id, two]]), hasMore: false } : { threads: new Collection([[one.id, one]]), hasMore: true }; } };
  await f.internals.scan('live'); assert.equal(seen.filter(o => o.type === 'public').length, 2); assert.ok(seen[1].before instanceof Date); assert.equal(seen.filter(o => o.type === 'private').length, 1);
  assert.ok(f.store.cursor('live', one.id)); assert.ok(f.store.cursor('live', two.id));
});
test('private thread must be joined even with view permission', async t => {
  const f = setup(t), thread: any = { ...f.channel, type: ChannelType.PrivateThread, id: '323456789012345678', parentId: f.channel.id, isThread: () => true, members: { fetch: async () => { throw { code: 10007 }; } } };
  assert.equal(await f.bot.allowed(thread), false); thread.members.fetch = async () => ({}); assert.equal(await f.bot.allowed(thread), true);
});
test('raw sparse edit and known deletion work without message cache', async t => {
  const f = setup(t), m = f.message(1); await f.bot.ingest(m, iso());
  await f.internals.raw('MESSAGE_UPDATE', { guild_id: f.config.guild, channel_id: f.channel.id, id: m.id, content: 'edited', edited_timestamp: null }, iso());
  assert.equal(f.store.get(m.id)!.content, 'edited');
  f.guild.channels.fetch = async () => { throw { status: 403 }; };
  await f.internals.raw('MESSAGE_DELETE', { guild_id: f.config.guild, channel_id: f.channel.id, id: m.id }, iso());
  assert.equal(f.store.get(m.id)!.deleted, true);
});
test('only confirmed Unknown Message deletes on refresh; access failure preserves content', async t => {
  const f = setup(t), m = f.message(1); await f.bot.ingest(m, iso());
  f.channel.messages.fetch = async () => { throw { status: 403, code: 50001 }; };
  await assert.rejects(f.bot.refresh(m.id)); assert.equal(f.store.get(m.id)!.deleted, false);
  f.channel.messages.fetch = async () => { throw { status: 404, code: 10008 }; };
  await f.bot.refresh(m.id); assert.equal(f.store.get(m.id)!.deleted, true);
});
test('management command rechecks current guild permission and remembers responses', async t => {
  const f = setup(t), key = '523456789012345678';
  const first = await f.bot.command(key, f.config.guild, 'user', 'status');
  assert.equal(await f.bot.command(key, f.config.guild, 'user', 'status'), first);
  f.guild.members.fetch = async () => ({ permissions: { has: () => false } });
  assert.match(await f.bot.command(key, f.config.guild, 'user', 'status'), /管理権限/);
  assert.match(await f.bot.command(key, 'other', 'user', 'status'), /対象ではありません/);
});
