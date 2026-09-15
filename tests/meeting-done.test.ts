import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions, Response as MockResponse } from 'miniflare';
import { encrypt } from '../src/crypto';
import { minutesMessages, minutesText, validateMinutes, type MinutesSummary } from '../src/meeting-minutes';
import { discordCommands } from '../src/discord-commands';

const guild = '456789012345678901', user = '234567890123456789', bot = '123456789012345678', channel = '567890123456789012';
const document = 'minutes_document_12345', key = Buffer.alloc(32, 8).toString('base64url'), origin = 'http://localhost:8787';
const keys = generateKeyPairSync('ed25519');
let sequence = 0n, mf: Miniflare;
const newId = () => ((BigInt(Date.now() - 1420070400000) << 22n) + ++sequence).toString();
let docs: any, generated: MinutesSummary, inputs: any[], posts: any[], replies: string[], gets: string[];
let docsStatus: number, aiStatus: number, postStatus: number, inviteStatus: number, revoked: boolean, wrongChannel: boolean;
const paragraph = (text: string) => ({ paragraph: { elements: [{ textRun: { content: text } }] } });
const content = '検討案：全機能を延期する？\n決定：金曜日に公開する。\n田中：動作確認を木曜までに行う。\n佐藤：案内文を書く。\n担当未定：FAQを更新する。';
function fixture(): any {
  return { tabs: [{ tabProperties: { tabId: 'other' }, documentTab: { body: { content: [paragraph('別会議：全員解雇する')] } }, childTabs: [{ tabProperties: { tabId: 't.agenda' }, documentTab: { body: { content: [paragraph(content)] } } }] }] };
}
const output = (): MinutesSummary => ({ decisions: [{ text: '金曜日に公開する。', evidence: '決定：金曜日に公開する。' }], todos: [
  { member: '田中', task: '動作確認を行う。', deadline: '木曜', evidence: '田中：動作確認を木曜までに行う。' },
  { member: '佐藤', task: '案内文を書く。', deadline: null, evidence: '佐藤：案内文を書く。' },
  { member: null, task: 'FAQを更新する。', deadline: null, evidence: '担当未定：FAQを更新する。' },
] });
async function control(action: string, id: string, extra: object = {}) {
  const r = await mf.dispatchFetch(`${origin}/test/${action}`, { method: 'POST', body: JSON.stringify({ id, guild, ...extra }) });
  assert.equal(r.status, 200, await r.clone().text()); return r.json() as Promise<any>;
}
async function seed(overrides: Record<string, unknown> = {}) {
  const id = newId(), at = Date.now() - 5000;
  const s = { id, guild, user, runAt: at - 3600_000, meetingAt: at, channel, title: '定例mtg', document, status: 'complete',
    url: `https://docs.google.com/document/d/${document}/edit?tab=t.agenda`, tabId: 't.agenda', failures: 0, skipped: 0, imageFallbacks: 0,
    cursorCreated: '', cursorId: '', part: 0, textIndex: 1, ...overrides };
  await control('seed', id, { state: s });
  await (await mf.getD1Database('DB')).prepare('INSERT INTO meeting_reservations(id,guild,user,run_at,title,document,created,meeting_at,channel) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(id, s.guild, user, s.runAt, s.title, s.document, at, s.meetingAt ?? null, s.channel).run();
  return id;
}
function interaction(id?: string) {
  return { id: newId(), type: 2, application_id: bot, token: 'test-reply', guild_id: guild, channel_id: channel,
    member: { user: { id: user }, permissions: '32' }, data: { name: 'mtg', options: [{ name: 'done', type: 1, options: id ? [{ name: 'id', type: 3, value: id }] : [] }] } };
}
async function signed(payload: unknown) {
  const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
  const r = await mf.dispatchFetch(`${origin}/discord/interactions`, { method: 'POST', headers: { 'X-Signature-Timestamp': timestamp,
    'X-Signature-Ed25519': sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex') }, body });
  return r.json() as Promise<any>;
}
async function until<T>(fn: () => Promise<T> | T, predicate: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 200; n++) { const v = await fn(); if (predicate(v)) return v; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('Timed out');
}
async function accept(id: string, payload = interaction(id)) {
  assert.equal((await signed(payload)).type, 5);
  await until(() => control('summary', id), s => !!s); return payload;
}
async function finish(id: string) {
  for (let n = 0; n < 100; n++) { const s = await control('step', id); if (s && ['complete', 'failed', 'needs_review'].includes(s.status)) return s; }
  assert.fail('Completion stalled');
}
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'done-test', modules: true, scriptPath: '.test-dist/done/meeting-done-harness.js', compatibilityDate: '2026-09-15', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['MEDIA'], durableObjects: { MEETINGS: { className: 'DoneSource', useSQLite: true }, MEETING_DONE: { className: 'TestMeetingDone', useSQLite: true }, MEETING_POLLS: { className: 'MeetingPoll', useSQLite: true } },
    bindings: { APP_ORIGIN: origin, DEMO_API_KEY: 'test-api-key-at-least-32-characters', COLLECTION_MODE: 'cloud', GOOGLE_CLIENT_ID: 'fake', GOOGLE_CLIENT_SECRET: 'fake', TOKEN_ENCRYPTION_KEY: key,
      DISCORD_BOT_TOKEN: 'fake-bot', DISCORD_APPLICATION_ID: bot, DISCORD_PUBLIC_KEY: Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex'), OPENAI_API_KEY: 'fake-ai', MTG_SUMMARY_MODEL: 'test-model' },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'oauth2.googleapis.com') return MockResponse.json({ access_token: 'fake-access' });
      if (url.hostname === 'docs.googleapis.com') {
        assert.equal(request.method, 'GET', 'never alter the minutes'); assert.equal(url.pathname, `/v1/documents/${document}`);
        assert.equal(url.searchParams.get('includeTabsContent'), 'true'); assert.equal(url.searchParams.get('suggestionsViewMode'), 'PREVIEW_WITHOUT_SUGGESTIONS');
        gets.push(request.url); return docsStatus === 200 ? MockResponse.json(docs) : MockResponse.json({}, { status: docsStatus });
      }
      if (url.hostname === 'api.openai.com') {
        const body = await request.json() as any; inputs.push(body);
        assert.equal(body.store, false); assert.equal(body.text.format.name, 'meeting_minutes'); assert.equal(body.text.format.strict, true);
        return aiStatus === 200 ? MockResponse.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(generated) }] }] }) : MockResponse.json({}, { status: aiStatus });
      }
      assert.equal(url.hostname, 'discord.com');
      if (url.pathname.includes('/webhooks/')) {
        if (request.method === 'DELETE') replies.push('[deleted]');
        else { const body = await request.json() as any; assert.deepEqual(body.allowed_mentions, { parse: [] }); replies.push(body.content); }
        return new MockResponse(null, { status: 204 });
      }
      if (url.pathname === `/api/v10/guilds/${guild}`) return MockResponse.json({ owner_id: revoked ? '999' : user });
      if (url.pathname === `/api/v10/guilds/${guild}/members/${user}`) return MockResponse.json({ roles: [] });
      if (url.pathname === `/api/v10/guilds/${guild}/roles`) return MockResponse.json([{ id: guild, permissions: '0' }]);
      if (url.pathname === `/api/v10/channels/${channel}`) return MockResponse.json({ guild_id: wrongChannel ? '999' : guild });
      assert.equal(url.pathname, `/api/v10/channels/${channel}/messages`); assert.equal(request.method, 'POST');
      const body = await request.json() as any; posts.push(body);
      assert.equal(body.enforce_nonce, true); assert.ok(body.nonce.length <= 25); assert.ok(body.content.length <= 2000);
      const invite = body.content.includes('次回MTGの日時を入力してください！');
      assert.deepEqual(body.allowed_mentions, { parse: invite ? ['everyone'] : [] });
      const status = invite ? inviteStatus : postStatus;
      return status === 200 ? MockResponse.json({ id: newId(), mention_everyone: invite }) : MockResponse.json({ retry_after: 2 }, { status });
    },
  }));
  const db = await mf.getD1Database('DB');
  for (const f of (await readdir('migrations')).sort()) for (const sql of (await readFile(`migrations/${f}`, 'utf8')).split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(sql).run();
  await db.prepare('INSERT INTO credentials(id,encrypted_refresh_token,connected_at) VALUES(?,?,?)').bind(`discord:guild:${guild}`, await encrypt('refresh', key, `discord:guild:${guild}`), Date.now()).run();
  await db.prepare('INSERT INTO discord_guild_settings(guild_id,document_id,updated_by,updated_at) VALUES(?,?,?,?)').bind(guild, document, user, Date.now()).run();
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  docs = fixture(); generated = output(); inputs = []; posts = []; replies = []; gets = [];
  docsStatus = aiStatus = postStatus = inviteStatus = 200; revoked = wrongChannel = false;
  await (await mf.getD1Database('DB')).prepare('DELETE FROM meeting_reservations').run();
});

test('reads exact nested tab, tables and people; refuses missing/empty/oversized tabs', () => {
  const d = fixture(); d.tabs[0].childTabs[0].documentTab.body.content.push({ table: { tableRows: [{ tableCells: [{ content: [paragraph('表の決定事項')] }, { content: [{ paragraph: { elements: [{ person: { personProperties: { name: '鈴木' } } }] } }] }] }] } });
  const text = minutesText(d, 't.agenda'); assert.ok(text.includes('表の決定事項\t鈴木')); assert.ok(!text.includes('全員解雇'));
  assert.throws(() => minutesText(d, 'missing')); assert.throws(() => minutesText({ tabs: [{ tabProperties: { tabId: 'empty' } }] }, 'empty'));
  assert.throws(() => minutesText({ tabs: [{ tabProperties: { tabId: 'x' }, documentTab: { body: { content: [paragraph('x'.repeat(100001))] } } }] }, 'x'));
});
test('rejects ungrounded evidence, assignees and deadlines; renders all tasks and inert mentions', () => {
  assert.deepEqual(validateMinutes(output(), content), output());
  for (const field of ['member', 'deadline', 'evidence'] as const) { const s = output(); s.todos[0][field] = '架空'; assert.throws(() => validateMinutes(s, content)); }
  const s = output(); s.todos = Array.from({ length: 60 }, (_, n) => ({ member: `担当${n} @everyone`, task: 'あ'.repeat(100), deadline: null, evidence: '' }));
  const pages = minutesMessages(s, '@here', 'https://docs.google.com/x'); assert.ok(pages.length > 1); assert.ok(pages.every(p => p.length <= 2000));
  assert.equal(pages.join('').match(/担当\d+/g)?.length, 60); assert.ok(!pages.join('').includes('@everyone')); assert.ok(!pages.join('').includes('@here'));
  const empty = minutesMessages({ decisions: [], todos: [] }, '会議', 'url').join(''); assert.equal(empty.match(/明記されていません/g)?.length, 2);
});
test('done is registered and create stays retired', () => {
  assert.ok(discordCommands.find(c => c.name === 'mtg')?.options?.some(c => c.name === 'done')); assert.ok(!discordCommands.some(c => c.name === 'create'));
});
test('signed done reads live edits, posts decisions and member todos, then creates one poll', async () => {
  const id = await seed(); const payload = await accept(id, interaction());
  assert.equal((await finish(id)).status, 'complete'); assert.equal(gets.length, 1); assert.equal(inputs.length, 1);
  const text = JSON.parse(inputs[0].input).minutes; assert.equal(text, content); assert.ok(!text.includes('全員解雇'));
  assert.equal(posts.length, 2); assert.match(posts[0].content, /決まったこと/); assert.match(posts[0].content, /\*\*田中\*\*/); assert.match(posts[0].content, /期限：木曜/); assert.match(posts[0].content, /\*\*担当未定\*\*/);
  assert.equal(posts[1].content, '@everyone\n次回MTGの日時を入力してください！'); assert.ok(posts[1].components[0].components[0].url.endsWith(payload.id)); assert.deepEqual(replies, ['[deleted]']);
  await signed(payload); await signed(interaction(id)); await control('step', id); assert.equal(posts.length, 2); assert.equal(inputs.length, 1);
});
test('missing meeting, cross-guild, future and unfinished agendas never post', async () => {
  await signed(interaction()); await until(() => replies.length, n => n === 1); assert.match(replies[0], /見つかりません/);
  for (const overrides of [{ guild: '999999999999999999' }, { meetingAt: Date.now() + 86400000 }, { status: 'writing' }]) {
    const id = await seed(overrides); const n = replies.length; await signed(interaction(id)); await until(() => replies.length, x => x > n);
  }
  assert.equal(posts.length, 0); assert.equal(gets.length, 0);
  const denied = interaction(); denied.member.permissions = '0'; assert.equal((await signed(denied)).type, 4);
});
test('latest selection skips future and debug agendas; replay stays pinned after a newer meeting', async () => {
  const id = await seed(); await seed({ meetingAt: Date.now() + 86400000 }); await seed({ meetingAt: null, mode: 'debug-agenda' });
  const payload = await accept(id, interaction()); await finish(id);
  const newer = await seed({ meetingAt: Date.now() - 100 }); await signed(payload);
  await until(() => replies.length, n => n >= 2); assert.equal(await control('summary', newer), null); assert.equal(posts.length, 2);
});
test('concurrent commands and a process restart preserve one completion and one AI call', async () => {
  const id = await seed(); await Promise.all([signed(interaction(id)), signed(interaction(id))]);
  await until(() => control('summary', id), s => !!s); await control('step', id); await control('step', id);
  assert.equal(inputs.length, 1); await control('restart', id);
  assert.equal((await finish(id)).status, 'complete'); assert.equal(inputs.length, 1); assert.equal(posts.length, 2);
});
test('AI and missing-tab failures publish nothing; a fresh command can retry safely', async () => {
  const id = await seed(); aiStatus = 503; const first = await accept(id);
  assert.equal((await finish(id)).status, 'failed'); assert.equal(posts.length, 0); assert.equal(inputs.length, 1);
  await signed(first); await control('step', id); assert.equal(inputs.length, 1);
  aiStatus = 200; await signed(interaction(id)); await until(() => control('summary', id), s => s.status === 'reading');
  assert.equal((await finish(id)).status, 'complete'); assert.equal(inputs.length, 2); assert.equal(posts.length, 2);
  const missing = await seed(); docs = { tabs: [] }; await accept(missing); assert.equal((await finish(missing)).status, 'failed'); assert.equal(posts.length, 2);
});
test('revoked role, wrong channel, and unreadable Docs stop before disclosure', async () => {
  for (const mode of ['role', 'channel', 'docs']) {
    revoked = mode === 'role'; wrongChannel = mode === 'channel'; docsStatus = mode === 'docs' ? 403 : 200;
    const id = await seed(); await accept(id); assert.equal((await finish(id)).status, 'failed');
  }
  assert.equal(posts.length, 0); assert.equal(inputs.length, 0);
});
test('unknown summary delivery and restarted in-flight sends never repost or ping', async () => {
  const id = await seed(); await accept(id); postStatus = 503;
  assert.equal((await finish(id)).status, 'needs_review'); assert.equal(posts.length, 1);
  postStatus = 200; await signed(interaction(id)); await control('step', id); assert.equal(posts.length, 1);
  const second = await seed(); await accept(second); await control('uncertain', second, { kind: 'sending' });
  assert.equal((await finish(second)).status, 'needs_review'); assert.equal(posts.length, 1);
});
test('rate limiting retries only a definitely unsent page and invitation uncertainty never repeats', async () => {
  const id = await seed(); await accept(id); await control('step', id); await control('step', id);
  postStatus = 429; assert.equal((await control('step', id)).status, 'publishing'); postStatus = 200; inviteStatus = 503;
  assert.equal((await finish(id)).status, 'needs_review'); assert.equal(posts.length, 3);
  await signed(interaction(id)); await control('step', id); assert.equal(posts.length, 3); assert.match(replies.at(-1)!, /日程調整/);
});
