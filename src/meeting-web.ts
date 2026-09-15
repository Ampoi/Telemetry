import { appOrigin } from './auth';
import { hash, randomToken } from './crypto';
import { discord } from './cloud/discord-rest';
import { id as discordId, jsonBody } from './cloud/model';
import { AppError } from './errors';
import { meetingPage } from './meeting-page';

export type MeetingWebEnv = Env & { DISCORD_CLIENT_SECRET?: string };
type PollRow = { id: string; guild: string; user: string };
type Session = { user: string; name: string };
const cookie = (r: Request, name: string) => r.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
function setCookie(env: Env, name: string, value: string, age: number) {
  return `${name}=${value}; Path=/mtg; Max-Age=${age}; HttpOnly; SameSite=Lax${appOrigin(env).startsWith('https:') ? '; Secure' : ''}`;
}
async function poll(env: Env, id: string) {
  if (!/^\d{17,20}$/.test(id)) throw new AppError(404, '日程調整が見つかりません。');
  const row = await env.DB.prepare('SELECT id,guild,user FROM meeting_polls WHERE id=?').bind(id).first<PollRow>();
  if (!row) throw new AppError(404, '日程調整が見つかりません。');
  return row;
}
async function session(request: Request, env: Env): Promise<Session | null> {
  const token = cookie(request, 'mtg_session');
  if (!token) return null;
  return env.DB.prepare('SELECT user,name FROM meeting_sessions WHERE token_hash=? AND expires>?').bind(await hash(token), Date.now()).first<Session>();
}
async function member(env: Env, guild: string, user: string) {
  try {
    const m = await discord<{ user: { id: string; username: string; global_name?: string; bot?: boolean }; nick?: string; roles: string[] }>(env, `/guilds/${guild}/members/${user}`);
    if (!m.user || m.user.id !== user || m.user.bot) throw new Error('InvalidMember');
    return m;
  } catch { throw new AppError(403, '対象サーバーのメンバーを確認できません。Discord IDとBotのアクセス権を確認してください。'); }
}
async function manager(env: Env, row: PollRow, user: string) {
  if (row.user !== user) throw new AppError(403, '主催者のみ操作できます。');
  const m = await member(env, row.guild, user);
  const guild = await discord<{ owner_id: string }>(env, `/guilds/${row.guild}`);
  if (guild.owner_id === user) return;
  const roles = await discord<{ id: string; permissions: string }[]>(env, `/guilds/${row.guild}/roles`);
  if (!roles.some(r => (r.id === row.guild || m.roles.includes(r.id)) && (BigInt(r.permissions) & 40n) !== 0n)) throw new AppError(403, 'サーバー管理権限が必要です。');
}
async function oauth(request: Request, env: MeetingWebEnv, url: URL) {
  if (!env.DISCORD_CLIENT_SECRET) throw new AppError(503, 'Discordログインの設定が必要です。運営者にDISCORD_CLIENT_SECRETとOAuthリダイレクトURLの設定を依頼してください。');
  const redirect = `${appOrigin(env)}/mtg/login/callback`;
  if (url.pathname === '/mtg/login') {
    const row = await poll(env, url.searchParams.get('poll') ?? '');
    const state = randomToken(), browser = randomToken();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM meeting_oauth WHERE expires<?').bind(Date.now()),
      env.DB.prepare('DELETE FROM meeting_sessions WHERE expires<?').bind(Date.now()),
      env.DB.prepare('INSERT INTO meeting_oauth(state_hash,browser_hash,poll,expires) VALUES(?,?,?,?)').bind(await hash(state), await hash(browser), row.id, Date.now() + 600_000),
    ]);
    const auth = new URL('https://discord.com/oauth2/authorize');
    auth.search = new URLSearchParams({ client_id: env.DISCORD_APPLICATION_ID, response_type: 'code', scope: 'identify', redirect_uri: redirect, state }).toString();
    return new Response(null, { status: 302, headers: { Location: auth.href, 'Set-Cookie': setCookie(env, 'mtg_oauth', browser, 600) } });
  }
  const state = url.searchParams.get('state'), browser = cookie(request, 'mtg_oauth');
  if (!state || !browser) throw new AppError(400, 'ログインを最初からやり直してください。');
  const consumed = await env.DB.prepare('DELETE FROM meeting_oauth WHERE state_hash=? AND browser_hash=? AND expires>? RETURNING poll')
    .bind(await hash(state), await hash(browser), Date.now()).first<{ poll: string }>();
  if (!consumed) throw new AppError(400, '認証リンクは使用済み、または期限切れです。');
  const headers = new Headers({ Location: `/mtg/polls/${consumed.poll}`, 'Set-Cookie': setCookie(env, 'mtg_oauth', '', 0) });
  if (url.searchParams.has('error')) return new Response(null, { status: 303, headers });
  const code = url.searchParams.get('code');
  if (!code) throw new AppError(400, '認証コードがありません。');
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_APPLICATION_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirect }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new AppError(502, 'Discord認証に失敗しました。ログインをやり直してください。'); }
  const token = await response.json() as { access_token?: string; scope?: string };
  if (!token.access_token || !token.scope?.split(' ').includes('identify')) throw new AppError(502, 'Discordの本人確認権限がありません。');
  const identity = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!identity.ok) { await identity.body?.cancel(); throw new AppError(502, 'Discordの本人確認に失敗しました。'); }
  const user = await identity.json() as { id: string; username: string; global_name?: string; bot?: boolean };
  discordId(user.id);
  if (user.bot) throw new AppError(403, 'Botは回答できません。');
  const row = await poll(env, consumed.poll);
  await member(env, row.guild, user.id);
  const raw = randomToken();
  await env.DB.prepare('INSERT INTO meeting_sessions(token_hash,user,name,expires) VALUES(?,?,?,?)').bind(await hash(raw), user.id, user.global_name ?? user.username, Date.now() + 86400_000).run();
  headers.append('Set-Cookie', setCookie(env, 'mtg_session', raw, 86400));
  return new Response(null, { status: 303, headers });
}
export async function meetingWeb(request: Request, env: MeetingWebEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== appOrigin(env)) throw new AppError(400, 'URLのホストが一致しません。');
  if (request.method === 'GET' && ['/mtg/login', '/mtg/login/callback'].includes(url.pathname)) return oauth(request, env, url);
  if (request.method === 'POST' && request.headers.get('Origin') !== appOrigin(env)) throw new AppError(403, 'ページを開き直してください。');
  if (url.pathname === '/mtg/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM meeting_sessions WHERE token_hash=?').bind(await hash(cookie(request, 'mtg_session'))).run();
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': setCookie(env, 'mtg_session', '', 0) } });
  }
  const match = url.pathname.match(/^\/mtg\/polls\/(\d{17,20})(?:\/(data|answer|cancel|confirm))?$/);
  if (!match) throw new AppError(404, 'ページが見つかりません。');
  const row = await poll(env, match[1]);
  if (!match[2] && request.method === 'GET') return meetingPage(row.id);
  const current = await session(request, env);
  if (!current) throw new AppError(401, 'Discordでログインしてください。');
  await member(env, row.guild, current.user);
  const stub = env.MEETING_POLLS.getByName(row.id);
  try {
    if (match[2] === 'data' && request.method === 'GET') {
      const view = await stub.open(current.user);
      if (view.status === 'confirmed') {
        const reservation = await env.MEETINGS.getByName(`${row.guild}:${row.id}`).summary();
        if (reservation?.status === 'cancelled') view.status = 'cancelled';
        else if (!view.notified && !view.error) view.error = 'Discordへの確定通知は完了未確認です。チャンネルの表示をご確認ください。';
      }
      return Response.json({ ...view, name: current.name });
    }
    if (match[2] === 'answer' && request.method === 'POST') {
      const data = await jsonBody(request);
      if (!Array.isArray(data.slots) || data.slots.length > 1392 || data.slots.some(n => !Number.isInteger(n) || n < 0 || n >= 1392)) throw new AppError(400, '空き時間の指定が不正です。');
      return Response.json(await stub.answer(current.user, data.slots));
    }
    if (match[2] === 'confirm' && request.method === 'POST') {
      await manager(env, row, current.user);
      const data = await jsonBody(request);
      if (typeof data.slot !== 'number' || !Number.isInteger(data.slot) || data.slot < 0 || data.slot >= 1392) throw new AppError(400, '表から開始時刻を1つ選んでください。');
      return Response.json(await stub.confirm(current.user, data.slot));
    }
    if (match[2] === 'cancel' && request.method === 'POST') { await manager(env, row, current.user); return Response.json(await stub.cancel(current.user)); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message.includes('MemberList')) throw new AppError(503, message.includes('MemberListForbidden') ? 'メンバーを取得できません。サーバー管理者にBotのServer Members Intent設定を確認してもらってください。' : 'メンバーを取得できませんでした。少し待ってページを更新してください。');
    if (message.includes('PollForbidden')) throw new AppError(403, 'この日程調整の参加者ではありません。サーバーの所属を確認してください。');
    if (/PollClosed|PollExpired/.test(message)) throw new AppError(409, '募集を終了しています。ページを更新してください。');
    if (message.includes('InvalidMeetingTime')) throw new AppError(400, '現在から1時間より先の開始時刻を選んでください。');
    if (/Invalid/.test(message)) throw new AppError(400, '入力内容を確認して、もう一度お試しください。');
    throw error;
  }
  throw new AppError(405, 'この操作には対応していません。');
}
