import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Response as MockResponse } from 'miniflare';
import { decrypt, encrypt, hash } from '../src/crypto';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const API_KEY = 'test-api-key-32-characters-minimum-long';
const document = 'test_document_12345';
let mf: Miniflare;
let writes: Record<string, unknown>[][] = [];
let tokenCalls = 0;
let rejectContent = false;
let expectedChallenge = '';
const discordKeys = generateKeyPairSync('ed25519');
const discordApplicationId = '123456789012345678';
const discordUserA = '234567890123456789';
const discordUserB = '345678901234567890';
const discordGuildA = '456789012345678901';
const discordGuildB = '567890123456789012';
const documentB = 'other_document_67890';
const discordReplies: { token: string; content: string; allowed_mentions: { parse: string[] } }[] = [];
const docAccessTokens: string[] = [];
const docWritePaths: string[] = [];
let interactionSequence = 0n;

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'dist/index.js',
    compatibilityDate: '2026-09-11', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    queueProducers: { DISCORD_JOBS: 'docs-discord-jobs' },
    queueConsumers: { 'docs-discord-jobs': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 2 } },
    bindings: {
      APP_ORIGIN: 'http://localhost:8787', DEMO_API_KEY: API_KEY,
      GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
      DISCORD_APPLICATION_ID: discordApplicationId,
      DISCORD_PUBLIC_KEY: Buffer.from(discordKeys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex'),
    },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.href === 'https://oauth2.googleapis.com/token') {
        tokenCalls++;
        const params = new URLSearchParams(await request.text());
        assert.equal(params.get('client_secret'), 'test-secret');
        if (params.get('grant_type') === 'authorization_code') {
          assert.equal(await hash(params.get('code_verifier')!), expectedChallenge);
          assert.equal(params.get('redirect_uri'), 'http://localhost:8787/auth/callback');
          return MockResponse.json({ access_token: 'test-access', refresh_token: params.get('code') === 'test-code-b' ? 'test-refresh-b' : 'test-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/documents' });
        }
        assert.ok(['test-refresh', 'test-refresh-b'].includes(params.get('refresh_token')!));
        return MockResponse.json({ access_token: params.get('refresh_token') === 'test-refresh-b' ? 'test-access-b' : 'test-access', expires_in: 3600 });
      }
      if (url.origin === 'https://docs.googleapis.com') {
        const authorization = request.headers.get('Authorization')!;
        assert.ok(['Bearer test-access', 'Bearer test-access-b'].includes(authorization));
        docAccessTokens.push(authorization);
        if (request.method === 'GET') return MockResponse.json({ title: 'Test document', tabs: [{ tabProperties: { tabId: 'existing', title: 'Existing' } }] });
        assert.ok([document, documentB].some(id => url.pathname === `/v1/documents/${id}:batchUpdate`));
        docWritePaths.push(url.pathname);
        const body = await request.json() as { requests: Record<string, unknown>[] };
        writes.push(body.requests);
        if (body.requests[0].addDocumentTab) return MockResponse.json({ replies: [{ addDocumentTab: { tabProperties: { tabId: 't.created', title: 'Debug' } } }] });
        if (rejectContent) return MockResponse.json({ error: { message: 'mock failure' } }, { status: 503 });
        return MockResponse.json({ replies: body.requests.map(() => ({})) });
      }
      if (url.origin === 'https://discord.com') {
        assert.equal(request.method, 'PATCH');
        assert.ok(url.pathname.endsWith('/messages/@original'));
        const body = await request.json() as { content: string; allowed_mentions: { parse: string[] } };
        discordReplies.push({ token: url.pathname.split('/')[5], ...body });
        return MockResponse.json({ id: 'reply' });
      }
      throw new Error(`Unexpected outbound request: ${url.origin}`);
    },
  }));
  const db = await mf.getD1Database('DB');
  for (const file of ['0001_initial.sql', '0002_discord_users.sql', '0003_collector_commands.sql', '0004_discord_guild_settings.sql']) {
    const migration = await readFile(`migrations/${file}`, 'utf8');
    for (const sql of migration.split(';').map(v => v.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
});

test('共有アプリの収集コマンドを署名検証から返信まで中継する', async t => {
  const guild = '456789012345678901';
  const payload = () => ({ ...discordPayload('telemetry'), guild_id: guild, member: { user: { id: discordUserA }, permissions: '32' }, data: { name: 'telemetry', options: [{ name: 'backfill', type: 1, options: [{ name: 'days', type: 4, value: 7 }] }] } });
  await t.test('管理権限・guild・日数を検証する', async () => {
    for (const input of [{ ...payload(), member: { user: { id: discordUserA }, permissions: '0' } }, { ...payload(), guild_id: undefined }, { ...payload(), data: { name: 'telemetry', options: [{ name: 'backfill', type: 1, options: [{ name: 'days', type: 4, value: 0 }] }] } }]) {
      const result = await (await discordRequest(input)).json() as { type: number }; assert.equal(result.type, 4);
    }
  });
  const input = payload();
  await t.test('受付は冪等で返信トークンを暗号化する', async () => {
    for (let i = 0; i < 2; i++) assert.deepEqual(await (await discordRequest(input)).json(), { type: 5, data: { flags: 64 } });
    const db = await mf.getD1Database('DB');
    const row = await db.prepare('SELECT encrypted FROM collector_commands WHERE id=?').bind(input.id).first<{ encrypted: string }>();
    assert.ok(row?.encrypted.startsWith('v1.')); assert.ok(!row!.encrypted.includes(input.token));
  });
  let command: { id: string; lease: string };
  await t.test('API認証とguildを検証し同時pollで二重取得しない', async () => {
    assert.equal((await mf.dispatchFetch(`http://localhost:8787/api/collector/commands?guild=${guild}`)).status, 401);
    assert.deepEqual(await (await api('/api/collector/commands?guild=567890123456789012')).json(), { commands: [] });
    const results = await Promise.all([api(`/api/collector/commands?guild=${guild}`), api(`/api/collector/commands?guild=${guild}`)]);
    const bodies = await Promise.all(results.map(r => r.json() as Promise<{ commands: { id: string; lease: string }[] }>));
    const commands = bodies.flatMap(b => b.commands); assert.equal(commands.length, 1); command = commands[0];
    assert.ok(!JSON.stringify(commands).includes(input.token));
  });
  await t.test('リース違いを拒否し結果を本人限定返信に反映する', async () => {
    const path = `/api/collector/commands/${input.id}/result`;
    assert.equal((await api(path, 'POST', { guild, lease: 'wrong', content: 'accepted' })).status, 409);
    const writesBefore = writes.length;
    assert.equal((await api(path, 'POST', { guild, lease: command.lease, content: '履歴取得を受け付けました。' })).status, 200);
    const reply = await awaitReply(input.token); assert.deepEqual(reply.allowed_mentions.parse, []); assert.match(reply.content, /履歴取得/);
    assert.equal(writes.length, writesBefore);
    assert.equal((await api(path, 'POST', { guild, lease: command.lease, content: 'again' })).status, 200);
    assert.equal(discordReplies.filter(r => r.token === input.token).length, 1);
    assert.deepEqual(await (await api(`/api/collector/commands?guild=${guild}`)).json(), { commands: [] });
  });
  await t.test('未完了の期限切れリースを再取得できる', async () => {
    const next = payload(); await discordRequest(next);
    const first = await (await api(`/api/collector/commands?guild=${guild}`)).json() as { commands: { lease: string }[] };
    const db = await mf.getD1Database('DB'); await db.prepare('UPDATE collector_commands SET lease_until=0 WHERE id=?').bind(next.id).run();
    const second = await (await api(`/api/collector/commands?guild=${guild}`)).json() as { commands: { id: string; lease: string }[] };
    assert.equal(second.commands[0].id, next.id); assert.notEqual(first.commands[0].lease, second.commands[0].lease);
  });
});
after(async () => { await mf?.dispose(); });

function api(path: string, method = 'GET', body?: unknown) {
  return mf.dispatchFetch(`http://localhost:8787${path}`, {
    method, headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function beginLogin() {
  const created = await api('/api/auth', 'POST');
  assert.equal(created.status, 200);
  const login = await created.json() as { id: string; url: string };
  const started = await mf.dispatchFetch(login.url, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const googleUrl = new URL(started.headers.get('Location')!);
  assert.equal(googleUrl.origin, 'https://accounts.google.com');
  assert.equal(googleUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/documents');
  assert.equal(googleUrl.searchParams.get('code_challenge_method'), 'S256');
  expectedChallenge = googleUrl.searchParams.get('code_challenge')!;
  const cookie = started.headers.get('Set-Cookie')!.split(';')[0];
  return { ...login, cookie, state: googleUrl.searchParams.get('state')! };
}

function discordPayload(command: string, userId = discordUserA, options: { name: string; type: number; value: string }[] = [], guildId = discordGuildA) {
  const id = (((BigInt(Date.now()) - 1420070400000n) << 22n) + interactionSequence++).toString();
  return { id, application_id: discordApplicationId, type: 2, token: `token-${id}`, guild_id: guildId, member: { user: { id: userId }, permissions: '32' }, data: { name: command, options } };
}
function discordRequest(payload: unknown, timestamp = String(Math.floor(Date.now() / 1000)), changeBody = false) {
  const body = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(timestamp + body), discordKeys.privateKey).toString('hex');
  return mf.dispatchFetch('http://localhost:8787/discord/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature },
    body: changeBody ? `${body} ` : body,
  });
}
async function awaitReply(token: string, count = 1) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const results = discordReplies.filter(r => r.token === token);
    if (results.length >= count) return results.at(-1)!;
    await sleep(25);
  }
  assert.fail('Discord reply was not delivered');
}
async function discordLogin(user: string, code = 'test-code', guild = discordGuildA) {
  const response = await discordRequest(discordPayload('auth', user, [], guild));
  assert.equal(response.status, 200);
  const body = await response.json() as { type: number; data: { flags: number; components: { components: { url: string }[] }[] } };
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  const loginUrl = body.data.components[0].components[0].url;
  const started = await mf.dispatchFetch(loginUrl, { redirect: 'manual' });
  const google = new URL(started.headers.get('Location')!);
  expectedChallenge = google.searchParams.get('code_challenge')!;
  const cookie = started.headers.get('Set-Cookie')!.split(';')[0];
  const result = await mf.dispatchFetch(`http://localhost:8787/auth/callback?state=${google.searchParams.get('state')}&code=${code}`, { headers: { Cookie: cookie } });
  assert.equal(result.status, 200, await result.text());
  return { loginUrl, cookie, state: google.searchParams.get('state')! };
}

test('Worker上でOAuth・書き込み・失敗時の重複防止を検証', async t => {
  await t.test('APIキーなしの読み書きを拒否', async () => {
    assert.equal((await mf.dispatchFetch('http://localhost:8787/api/status')).status, 401);
    assert.equal((await mf.dispatchFetch('http://localhost:8787/api/auth', { method: 'POST' })).status, 401);
  });
  await t.test('キャンセル・期限切れの認証を扱う', async () => {
    const login = await beginLogin();
    const denied = await mf.dispatchFetch(`http://localhost:8787/auth/callback?state=${login.state}&error=access_denied`, { headers: { Cookie: login.cookie } });
    assert.equal(denied.status, 400);
    assert.deepEqual(await (await api(`/api/auth/${login.id}`)).json(), { status: 'failed' });
    const pending = await (await api('/api/auth', 'POST')).json() as { id: string; url: string };
    const db = await mf.getD1Database('DB');
    await db.prepare('UPDATE auth_requests SET expires_at = 0 WHERE id = ?').bind(pending.id).run();
    assert.equal((await mf.dispatchFetch(pending.url, { redirect: 'manual' })).status, 400);
    assert.deepEqual(await (await api(`/api/auth/${pending.id}`)).json(), { status: 'expired' });
  });
  await t.test('URLから認証完了、Cookie照合、PKCE、リプレイ防止、暗号化保存', async () => {
    const login = await beginLogin();
    assert.equal((await mf.dispatchFetch(login.url, { redirect: 'manual' })).status, 400);
    const callback = `http://localhost:8787/auth/callback?state=${login.state}&code=test-code`;
    assert.equal((await mf.dispatchFetch(callback)).status, 400);
    assert.equal((await mf.dispatchFetch(callback, { headers: { Cookie: 'docs_oauth=wrong' } })).status, 400);
    assert.equal(tokenCalls, 0);
    const finished = await mf.dispatchFetch(callback, { headers: { Cookie: login.cookie } });
    assert.equal(finished.status, 200, await finished.text());
    assert.equal(finished.headers.get('Cache-Control'), 'no-store');
    assert.equal(finished.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal((await mf.dispatchFetch(callback, { headers: { Cookie: login.cookie } })).status, 400);
    assert.equal(tokenCalls, 1);
    assert.deepEqual(await (await api(`/api/auth/${login.id}`)).json(), { status: 'complete' });
    const row = await (await mf.getD1Database('DB')).prepare('SELECT encrypted_refresh_token FROM credentials').first<{ encrypted_refresh_token: string }>();
    assert.ok(row?.encrypted_refresh_token.startsWith('v1.'));
    assert.ok(!row?.encrypted_refresh_token.includes('test-refresh'));
  });
  const input = { document, title: 'Debug', template: '# 作成日時\n{{createdAt}}\n- 完了 🚀\n', data: { createdAt: '2026-09-14T00:00:00+09:00' }, requestId: 'test-operation-1' };
  await t.test('変数不足ならGoogle書き込みを始めない', async () => {
    assert.equal((await api('/api/tabs', 'POST', { ...input, data: {} })).status, 400);
    assert.equal(writes.length, 0);
  });
  await t.test('同時リクエストでタブを1つだけ作成し、新タブだけに本文・書式を適用', async () => {
    const responses = await Promise.all([api('/api/tabs', 'POST', input), api('/api/tabs', 'POST', input)]);
    assert.equal(responses.filter(r => r.status === 201).length, 1);
    assert.ok(responses.every(r => [200, 201, 409].includes(r.status)));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], [{ addDocumentTab: { tabProperties: { title: 'Debug' } } }]);
    const serialized = JSON.stringify(writes[1]);
    assert.ok(serialized.includes('2026-09-14T00:00:00+09:00'));
    assert.ok(!serialized.includes('existing'));
    for (const request of writes[1]) assert.ok(JSON.stringify(request).includes('t.created'));
    const again = await api('/api/tabs', 'POST', input);
    assert.equal(again.status, 200);
    assert.equal((await again.json() as { replayed: boolean }).replayed, true);
    assert.equal(writes.length, 2);
    assert.equal((await api('/api/tabs', 'POST', { ...input, title: 'Different' })).status, 409);
    assert.equal(writes.length, 2);
  });
  await t.test('本文入力が失敗すると作成済みURLを返し、同じIDで再作成しない', async () => {
    rejectContent = true;
    const failedInput = { ...input, requestId: 'test-operation-2' };
    const failed = await api('/api/tabs', 'POST', failedInput);
    assert.equal(failed.status, 502);
    const result = await failed.json() as { details: { tabId: string; url: string } };
    assert.equal(result.details.tabId, 't.created');
    assert.ok(result.details.url.includes('tab=t.created'));
    const before = writes.length;
    assert.equal((await api('/api/tabs', 'POST', failedInput)).status, 409);
    assert.equal(writes.length, before);
    rejectContent = false;
  });
  await t.test('タブ一覧、ログアウト、ログアウト後の書き込み拒否', async () => {
    assert.equal((await api(`/api/tabs?document=${document}`)).status, 200);
    assert.equal((await api('/api/auth', 'DELETE')).status, 200);
    assert.deepEqual(await (await api('/api/status')).json(), { connected: false, connectedAt: null });
    assert.equal((await api('/api/tabs', 'POST', { ...input, requestId: 'after-logout' })).status, 401);
  });
  await t.test('Discord署名検証・PING・改変・古いリクエスト・別アプリの拒否', async () => {
    assert.deepEqual(await (await discordRequest({ type: 1, application_id: discordApplicationId })).json(), { type: 1 });
    assert.equal((await mf.dispatchFetch('http://localhost:8787/discord/interactions', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await discordRequest(discordPayload('auth'), undefined, true)).status, 401);
    assert.equal((await discordRequest(discordPayload('auth'), String(Math.floor(Date.now() / 1000) - 600))).status, 401);
    assert.equal((await discordRequest({ ...discordPayload('auth'), application_id: 'another-app' })).status, 401);
  });
  const options = [{ name: 'document', type: 3, value: document }];
  await t.test('未認証の/createは本人限定で/authを案内し、Googleへ書き込まない', async () => {
    const payload = discordPayload('create', discordUserA, options);
    const before = writes.length;
    const deferred = await discordRequest(payload);
    assert.deepEqual(await deferred.json(), { type: 5, data: { flags: 64 } });
    const reply = await awaitReply(payload.token);
    assert.match(reply.content, /\/auth/);
    assert.deepEqual(reply.allowed_mentions.parse, []);
    assert.equal(writes.length, before);
  });
  await t.test('/authはサーバーごとにGoogleを接続しCLI認証と分離する', async () => {
    await discordLogin(discordUserA);
    assert.deepEqual(await (await api('/api/status')).json(), { connected: false, connectedAt: null });
    const db = await mf.getD1Database('DB');
    assert.ok(await db.prepare('SELECT id FROM credentials WHERE id = ?').bind(`discord:guild:${discordGuildA}`).first());
    assert.equal(await db.prepare('SELECT id FROM credentials WHERE id = ?').bind(`discord:guild:${discordGuildB}`).first(), null);
    const login = await db.prepare('SELECT id FROM auth_requests WHERE owner = ?').bind(`discord:guild:${discordGuildA}`).first<{ id: string }>();
    assert.equal((await api(`/api/auth/${login!.id}`)).status, 404);
    await api('/api/auth', 'DELETE');
    assert.ok(await db.prepare('SELECT id FROM credentials WHERE id = ?').bind(`discord:guild:${discordGuildA}`).first());
  });
  await t.test('/createはキュー経由で新規タブへ入力し、再配信で重複を作らない', async () => {
    const payload = discordPayload('create', discordUserA, [...options, { name: 'message', type: 3, value: 'Discordテスト 🚀' }]);
    const before = writes.length;
    assert.deepEqual(await (await discordRequest(payload)).json(), { type: 5, data: { flags: 64 } });
    assert.match((await awaitReply(payload.token)).content, /tab=t.created/);
    assert.equal(writes.length, before + 2);
    assert.ok(JSON.stringify(writes.at(-1)).includes('Discordテスト 🚀'));
    await discordRequest(payload);
    await awaitReply(payload.token, 2);
    assert.equal(writes.length, before + 2);
    const second = discordPayload('create', discordUserA, options, discordGuildB);
    await discordRequest(second);
    assert.match((await awaitReply(second.token)).content, /未接続/);
    assert.equal(writes.length, before + 2);
  });
  await t.test('同じユーザーが別サーバーを認証しても元サーバーのGoogleトークンは変わらない', async () => {
    await discordLogin(discordUserA, 'test-code-b', discordGuildB);
    const b = discordPayload('create', discordUserA, options, discordGuildB);
    await discordRequest(b);
    await awaitReply(b.token);
    assert.equal(docAccessTokens.at(-1), 'Bearer test-access-b');
    const a = discordPayload('create', discordUserA, options);
    await discordRequest(a);
    await awaitReply(a.token);
    assert.equal(docAccessTokens.at(-1), 'Bearer test-access');
  });
  await t.test('/createの入力不正と本文入力失敗を本人に通知する', async () => {
    const invalid = await discordRequest(discordPayload('create', discordUserA));
    const body = await invalid.json() as { type: number; data: { flags: number } };
    assert.equal(body.type, 4);
    assert.equal(body.data.flags, 64);
    rejectContent = true;
    const failed = discordPayload('create', discordUserA, options);
    await discordRequest(failed);
    const reply = await awaitReply(failed.token);
    assert.match(reply.content, /タブは作成済み/);
    assert.match(reply.content, /tab=t.created/);
    rejectContent = false;
  });
});

test('サーバー設定・認証の境界を検証する', async t => {
  const db = await mf.getD1Database('DB');
  const key = Buffer.alloc(32, 1).toString('base64url');
  await t.test('DM・不正guild・権限なしでは認証・設定・作成を受け付けない', async () => {
    const beforeWrites = writes.length;
    const beforeRequests = await db.prepare('SELECT COUNT(*) AS count FROM auth_requests').first();
    for (const command of ['auth', 'document', 'create']) {
      const payload = discordPayload(command, discordUserA, [{ name: 'document', type: 3, value: document }]);
      for (const invalid of [
        { ...payload, guild_id: undefined, member: undefined, user: { id: discordUserA } },
        { ...payload, guild_id: 'invalid' },
        { ...payload, member: undefined, user: { id: discordUserA } },
        { ...payload, member: { user: { id: discordUserA }, permissions: '0' } },
        { ...payload, member: { user: { id: discordUserA }, permissions: 'bad' } },
      ]) {
        const body = await (await discordRequest(invalid)).json() as { type: number; data: { flags: number; content: string } };
        assert.equal(body.type, 4);
        assert.equal(body.data.flags, 64);
        assert.match(body.data.content, /サーバー/);
      }
    }
    assert.equal(writes.length, beforeWrites);
    assert.deepEqual(await db.prepare('SELECT COUNT(*) AS count FROM auth_requests').first(), beforeRequests);
    assert.equal(await db.prepare('SELECT guild_id FROM discord_guild_settings').first(), null);
  });
  await t.test('サーバー別にURLを正規化してD1に保存し、不正入力で上書きしない', async () => {
    for (const [guild, id] of [[discordGuildA, document], [discordGuildB, documentB]]) {
      const payload = discordPayload('document', discordUserA, [{ name: 'document', type: 3, value: `https://docs.google.com/document/d/${id}/edit?tab=old` }], guild);
      // Administrator is accepted even without an explicit Manage Guild bit.
      payload.member.permissions = '8';
      const result = await (await discordRequest(payload)).json() as { data: { content: string } };
      assert.match(result.data.content, /保存先を設定/);
      const row = await db.prepare('SELECT document_id, updated_by FROM discord_guild_settings WHERE guild_id = ?').bind(guild).first();
      assert.deepEqual(row, { document_id: id, updated_by: discordUserA });
    }
    for (const value of ['', 'https://example.com/document/d/test_document_12345', 'a'.repeat(501)]) {
      const response = await (await discordRequest(discordPayload('document', discordUserA, [{ name: 'document', type: 3, value }]))).json() as { data: { content: string } };
      assert.doesNotMatch(response.data.content, /保存先を設定しました/);
    }
    assert.equal((await db.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id = ?').bind(discordGuildA).first())?.document_id, document);
    for (const [guild, id, otherId] of [[discordGuildA, document, documentB], [discordGuildB, documentB, document]]) {
      const response = await (await discordRequest(discordPayload('document', discordUserB, [], guild))).json() as { data: { content: string } };
      assert.ok(response.data.content.includes(`/d/${id}/edit`));
      assert.ok(!response.data.content.includes(`/d/${otherId}/edit`));
      assert.match(response.data.content, /登録済み/);
    }
  });
  await t.test('URL省略時に各サーバーのURLと認証を使い、管理者間で接続を共用する', async () => {
    for (const [guild, id, token] of [[discordGuildA, document, 'Bearer test-access'], [discordGuildB, documentB, 'Bearer test-access-b']]) {
      const payload = discordPayload('create', discordUserB, [], guild);
      const before = writes.length;
      assert.deepEqual(await (await discordRequest(payload)).json(), { type: 5, data: { flags: 64 } });
      assert.match((await awaitReply(payload.token)).content, /タブを作成/);
      assert.equal(writes.length, before + 2);
      assert.deepEqual(docWritePaths.slice(-2), Array(2).fill(`/v1/documents/${id}:batchUpdate`));
      assert.deepEqual(docAccessTokens.slice(-2), Array(2).fill(token));
      assert.ok(await db.prepare('SELECT id FROM operations WHERE id = ?').bind(`discord:guild:${guild}:${payload.id}`).first());
      await discordRequest(payload);
      await awaitReply(payload.token, 2);
      assert.equal(writes.length, before + 2);
    }
  });
  await t.test('今回だけのURL指定はサーバー設定を上書きしない', async () => {
    const payload = discordPayload('create', discordUserA, [{ name: 'document', type: 3, value: documentB }]);
    await discordRequest(payload);
    assert.match((await awaitReply(payload.token)).content, /タブを作成/);
    assert.equal(docWritePaths.at(-1), `/v1/documents/${documentB}:batchUpdate`);
    assert.equal(docAccessTokens.at(-1), 'Bearer test-access');
    assert.equal((await db.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id = ?').bind(discordGuildA).first())?.document_id, document);
  });
  await t.test('未設定サーバーは他サーバーのURL・認証や旧個人認証を使わない', async () => {
    const guild = '678901234567890123';
    const before = writes.length;
    const missing = await (await discordRequest(discordPayload('create', discordUserA, [], guild))).json() as { type: number; data: { content: string } };
    assert.equal(missing.type, 4);
    assert.match(missing.data.content, /未設定/);
    const legacyOwner = `discord:${discordUserA}`;
    await db.prepare('INSERT INTO credentials (id, encrypted_refresh_token, connected_at) VALUES (?, ?, ?)')
      .bind(legacyOwner, await encrypt('test-refresh', key, legacyOwner), Date.now()).run();
    const payload = discordPayload('create', discordUserA, [{ name: 'document', type: 3, value: document }], guild);
    await discordRequest(payload);
    assert.match((await awaitReply(payload.token)).content, /未接続/);
    assert.equal(writes.length, before);
  });
  await t.test('暗号化トークンを別サーバーの所有者として復号できない', async () => {
    const owner = `discord:guild:${discordGuildA}`;
    const row = await db.prepare('SELECT encrypted_refresh_token FROM credentials WHERE id = ?').bind(owner).first<{ encrypted_refresh_token: string }>();
    assert.ok(row?.encrypted_refresh_token.startsWith('v1.'));
    assert.equal(await decrypt(row!.encrypted_refresh_token, key, owner), 'test-refresh');
    await assert.rejects(decrypt(row!.encrypted_refresh_token, key, `discord:guild:${discordGuildB}`));
  });
  await t.test('同サーバーの再認証だけを置換し、完了URLの再利用を拒否する', async () => {
    const otherBefore = await db.prepare('SELECT * FROM credentials WHERE id = ?').bind(`discord:guild:${discordGuildB}`).first();
    const login = await discordLogin(discordUserB, 'test-code-b');
    assert.equal((await mf.dispatchFetch(`http://localhost:8787/auth/callback?state=${login.state}&code=test-code`, { headers: { Cookie: login.cookie } })).status, 400);
    assert.deepEqual(await db.prepare('SELECT * FROM credentials WHERE id = ?').bind(`discord:guild:${discordGuildB}`).first(), otherBefore);
    const payload = discordPayload('create');
    await discordRequest(payload);
    await awaitReply(payload.token);
    assert.equal(docAccessTokens.at(-1), 'Bearer test-access-b');
  });
  await t.test('キャンセルしてもサーバーの既存接続を変更しない', async () => {
    const before = await db.prepare('SELECT * FROM credentials ORDER BY id').all();
    const response = await (await discordRequest(discordPayload('auth'))).json() as { data: { components: { components: { url: string }[] }[] } };
    const started = await mf.dispatchFetch(response.data.components[0].components[0].url, { redirect: 'manual' });
    const google = new URL(started.headers.get('Location')!);
    const cookie = started.headers.get('Set-Cookie')!.split(';')[0];
    const cancelled = await mf.dispatchFetch(`http://localhost:8787/auth/callback?state=${google.searchParams.get('state')}&error=access_denied`, { headers: { Cookie: cookie } });
    assert.equal(cancelled.status, 400);
    assert.deepEqual((await db.prepare('SELECT * FROM credentials ORDER BY id').all()).results, before.results);
  });
  await t.test('移行前の個人用認証URLはトークン交換に進めない', async () => {
    const login = await beginLogin();
    await db.prepare('UPDATE auth_requests SET owner = ? WHERE id = ?').bind(`discord:${discordUserA}`, login.id).run();
    const before = tokenCalls;
    const result = await mf.dispatchFetch(`http://localhost:8787/auth/callback?state=${login.state}&code=test-code`, { headers: { Cookie: login.cookie } });
    assert.equal(result.status, 400);
    assert.match(await result.text(), /サーバー別Google連携/);
    assert.equal(tokenCalls, before);
  });
});
