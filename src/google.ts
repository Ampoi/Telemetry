import { decrypt } from './crypto';
import { AppError } from './errors';

export const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
export interface TokenResponse { access_token: string; refresh_token?: string; scope?: string; expires_in: number }

export async function exchangeToken(env: Env, parameters: Record<string, string>): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...parameters }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new AppError(502, 'Google認証への接続に失敗しました。再度ログインしてください。'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(response.status === 400 ? 401 : 502, 'Google認証に失敗しました。OAuth設定を確認し、/auth または pnpm demo auth を再実行してください。');
  }
  const token = await response.json<TokenResponse>();
  if (!token.access_token) throw new AppError(502, 'Googleからアクセストークンが返されませんでした。');
  return token;
}

export async function accessToken(env: Env, owner = 'default'): Promise<string> {
  const row = await env.DB.prepare("SELECT encrypted_refresh_token FROM credentials WHERE id = ?").bind(owner).first<{ encrypted_refresh_token: string }>();
  if (!row) throw new AppError(401, 'Google未接続です。/auth または pnpm demo auth を実行してください。');
  const refresh = await decrypt(row.encrypted_refresh_token, env.TOKEN_ENCRYPTION_KEY, owner);
  return (await exchangeToken(env, { grant_type: 'refresh_token', refresh_token: refresh })).access_token;
}

export async function googleDocs<T>(token: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://docs.googleapis.com/v1/documents/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new AppError(502, 'Google Docs APIとの通信が中断しました。書き込みが完了した可能性があるため、ドキュメントを確認してください。');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 403 ? '認証したGoogleアカウントの編集権限、Docs APIの有効化、OAuthスコープを確認してください。'
      : response.status === 404 ? 'ドキュメントIDとアクセス権限を確認してください。'
      : response.status === 429 ? 'Google APIの利用制限です。時間を置いてください。'
      : '入力内容とGoogle APIの設定を確認してください。';
    throw new AppError(502, `Google Docs API: HTTP ${response.status}。${hint}`, { googleStatus: response.status });
  }
  return response.json<T>();
}
