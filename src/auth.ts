import { encrypt, hash, randomToken } from './crypto';
import { AppError } from './errors';
import { DOCS_SCOPE, exchangeToken } from './google';
import { connectedPage } from './auth-page';

export function appOrigin(env: Env): string {
  const url = new URL(env.APP_ORIGIN);
  if (url.origin !== env.APP_ORIGIN || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))) {
    throw new AppError(503, 'APP_ORIGINはHTTPSのオリジン（ローカルは http://localhost:8787）にしてください。');
  }
  return url.origin;
}
export async function createLogin(env: Env, owner = 'default') {
  if (!env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID.startsWith('replace-') || !env.GOOGLE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET.startsWith('replace-')) {
    throw new AppError(503, '先に .dev.vars またはWorkers SecretsにGoogle OAuthクライアントを設定してください。READMEの初回設定を参照してください。');
  }
  const origin = appOrigin(env);
  const id = crypto.randomUUID();
  const ticket = randomToken();
  await env.DB.prepare('DELETE FROM auth_requests WHERE expires_at < ?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO auth_requests (id, ticket_hash, verifier, status, expires_at, owner) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, await hash(ticket), randomToken(), 'pending', Date.now() + 600_000, owner).run();
  return { id, url: `${origin}/auth/start?ticket=${ticket}`, expiresIn: 600 };
}

export async function startLogin(request: Request, env: Env): Promise<Response> {
  const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
  const state = randomToken();
  const browser = randomToken();
  let row = await env.DB.prepare("UPDATE auth_requests SET state_hash = ?, browser_hash = ?, status = 'authorizing' WHERE ticket_hash = ? AND status = 'pending' AND expires_at > ? RETURNING verifier")
    .bind(await hash(state), await hash(browser), await hash(ticket), Date.now()).first<{ verifier: string }>();
  if (!row) {
    const previous = await env.DB.prepare("SELECT state_hash, browser_hash FROM auth_requests WHERE ticket_hash = ? AND status = 'authorizing' AND expires_at > ?")
      .bind(await hash(ticket), Date.now()).first<{ state_hash: string; browser_hash: string }>();
    if (previous) {
      const cookies = request.headers.get('Cookie')?.split(';').map(v => v.trim()) ?? [];
      const prefix = `docs_oauth_${previous.state_hash}=`;
      const proof = cookies.find(v => v.startsWith(prefix))?.slice(prefix.length);
      if (proof && await hash(proof) === previous.browser_hash) {
        row = await env.DB.prepare("UPDATE auth_requests SET state_hash = ?, browser_hash = ? WHERE ticket_hash = ? AND state_hash = ? AND status = 'authorizing' AND expires_at > ? RETURNING verifier")
          .bind(await hash(state), await hash(browser), await hash(ticket), previous.state_hash, Date.now()).first<{ verifier: string }>();
      }
    }
  }
  if (!row) throw new AppError(400, '認証URLは期限切れか使用済みです。/auth または pnpm demo auth を再実行してください。');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${appOrigin(env)}/auth/callback`,
    response_type: 'code', scope: DOCS_SCOPE, access_type: 'offline', prompt: 'consent',
    state, code_challenge: await hash(row.verifier), code_challenge_method: 'S256',
  }).toString();
  return new Response(null, { status: 302, headers: {
    Location: url.toString(),
    'Set-Cookie': cookie(browser, env, 600, `docs_oauth_${await hash(state)}`),
  } });
}

function cookie(value: string, env: Env, age: number, name: string) {
  const path = name === 'docs_oauth' ? '/auth/callback' : '/auth';
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${age}${appOrigin(env).startsWith('https:') ? '; Secure' : ''}`;
}

export async function finishLogin(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  if (!state) throw new AppError(400, '認証状態を確認できません。URLを開いた同じブラウザで認証してください。');
  // Each login needs its own cookie: another guild or CLI login may be open
  // in the same browser. Accept the old name for logins started before rollout.
  const cookies = request.headers.get('Cookie')?.split(';').map(v => v.trim()) ?? [];
  const scopedName = `docs_oauth_${await hash(state)}`;
  const cookieName = cookies.some(v => v.startsWith(`${scopedName}=`)) ? scopedName : 'docs_oauth';
  const browser = cookies.find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!browser) throw new AppError(400, '認証状態を確認できません。URLを開いた同じブラウザで認証してください。');
  const row = await env.DB.prepare("UPDATE auth_requests SET status = 'exchanging' WHERE state_hash = ? AND browser_hash = ? AND status = 'authorizing' AND expires_at > ? RETURNING id, verifier, owner")
    .bind(await hash(params.get('state')!), await hash(browser), Date.now()).first<{ id: string; verifier: string; owner: string }>();
  if (!row) throw new AppError(400, '認証状態が無効・期限切れ・使用済みです。/auth または pnpm demo auth を再実行してください。');
  try {
    if (row.owner !== 'default' && !/^discord:guild:\d{17,20}$/.test(row.owner)) {
      throw new AppError(400, 'サーバー別Google連携に切り替わりました。サーバー内で /auth を再実行してください。');
    }
    if (params.has('error') || !params.get('code')) throw new AppError(400, 'Googleの許可がキャンセルされました。/auth または pnpm demo auth で再実行できます。');
    const tokens = await exchangeToken(env, {
      code: params.get('code')!, grant_type: 'authorization_code',
      redirect_uri: `${appOrigin(env)}/auth/callback`, code_verifier: row.verifier,
    });
    if (!tokens.refresh_token || !tokens.scope?.split(' ').includes(DOCS_SCOPE)) {
      throw new AppError(400, 'ドキュメント編集の許可または継続アクセスのトークンがありません。/auth または pnpm demo auth で編集を許可してください。');
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO credentials (id, encrypted_refresh_token, connected_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET encrypted_refresh_token = excluded.encrypted_refresh_token, connected_at = excluded.connected_at")
        .bind(row.owner, await encrypt(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY, row.owner), Date.now()),
      env.DB.prepare("UPDATE auth_requests SET status = 'complete', verifier = '' WHERE id = ?").bind(row.id),
    ]);
    const nonce = randomToken();
    return new Response(connectedPage(row.owner, nonce), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie('', env, 0, cookieName),
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
      },
    });
  } catch (error) {
    await env.DB.prepare("UPDATE auth_requests SET status = 'failed', verifier = '' WHERE id = ?").bind(row.id).run();
    throw error;
  }
}
