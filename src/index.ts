import { appOrigin, createLogin, finishLogin, startLogin } from './auth';
import { equalSecret } from './crypto';
import { AppError } from './errors';
import { accessToken, googleDocs } from './google';
import { documentId } from './template';
import { createTab } from './documents';
import { collectorApi } from './collector-control';
import { handleDiscord, consumeDiscordJobs, type DiscordJobEnvelope } from './discord';

import { cloudApi } from './cloud/api';
import { consume, scheduled } from './cloud/jobs';
import type { QueueJob } from './cloud/model';

interface Tab { tabProperties: { tabId: string; title: string }; childTabs?: Tab[] }
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/discord/interactions' && request.method === 'POST') return handleDiscord(request, env, ctx);
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
  if (url.pathname.startsWith('/auth/')) {
    if (url.origin !== appOrigin(env)) throw new AppError(400, '認証URLのホストがAPP_ORIGINと一致しません。');
    if (url.pathname === '/auth/start' && request.method === 'GET') return startLogin(request, env);
    if (url.pathname === '/auth/callback' && request.method === 'GET') return finishLogin(request, env);
  }
  if (!url.pathname.startsWith('/api/')) throw new AppError(404, 'コマンドラインから pnpm demo --help を実行してください。');
  if (!env.DEMO_API_KEY || env.DEMO_API_KEY.length < 32) throw new AppError(503, 'DEMO_API_KEYを設定してください。');
  if (!await equalSecret(request.headers.get('Authorization') ?? '', `Bearer ${env.DEMO_API_KEY}`)) throw new AppError(401, 'DEMO_API_KEYが一致しません。');
  if (url.pathname.startsWith('/api/telemetry/')) return cloudApi(request, env);
  if (url.pathname.startsWith('/api/collector/')) return collectorApi(request, env);
  if (request.method === 'POST' && url.pathname === '/api/auth') return Response.json(await createLogin(env));
  if (request.method === 'GET' && url.pathname.startsWith('/api/auth/')) {
    const row = await env.DB.prepare("SELECT status, expires_at FROM auth_requests WHERE owner = 'default' AND id = ?").bind(url.pathname.slice('/api/auth/'.length)).first<{ status: string; expires_at: number }>();
    if (!row) throw new AppError(404, '認証リクエストが見つかりません。');
    return Response.json({ status: row.expires_at < Date.now() && row.status !== 'complete' ? 'expired' : row.status });
  }
  if (request.method === 'GET' && url.pathname === '/api/status') {
    const row = await env.DB.prepare("SELECT connected_at FROM credentials WHERE id = 'default'").first();
    return Response.json({ connected: !!row, connectedAt: row?.connected_at ?? null });
  }
  if (request.method === 'DELETE' && url.pathname === '/api/auth') {
    await env.DB.batch([env.DB.prepare("DELETE FROM credentials WHERE id = 'default'"), env.DB.prepare("DELETE FROM auth_requests WHERE owner = 'default'")]);
    return Response.json({ disconnected: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/tabs') {
    const id = documentId(url.searchParams.get('document') ?? '');
    const result = await googleDocs<{ title: string; tabs: Tab[] }>(await accessToken(env), `${id}?includeTabsContent=true&fields=title,tabs(tabProperties,childTabs)`);
    return Response.json(result);
  }
  if (request.method === 'POST' && url.pathname === '/api/tabs') return createTab(request, env);
  throw new AppError(404, 'エンドポイントが見つかりません。');
}

export default {
  scheduled,
  async queue(batch: MessageBatch<DiscordJobEnvelope | QueueJob>, env: Env) {
    // Queue names may differ between local testing and a provisioned environment.
    const collection = batch.messages.every(m => 'kind' in m.body && m.body.kind === 'collection');
    if (collection) await consume(batch as MessageBatch<QueueJob>, env);
    else await consumeDiscordJobs(batch as MessageBatch<DiscordJobEnvelope>, env);
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let response: Response;
    try { response = await route(request, env, ctx); }
    catch (error) {
      response = Response.json({ error: error instanceof AppError ? error.message : '処理に失敗しました。D1マイグレーションとSecretsの設定を確認してください。', ...(error instanceof AppError && error.details ? { details: error.details } : {}) }, { status: error instanceof AppError ? error.status : 500 });
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    return response;
  },
} satisfies ExportedHandler<Env, DiscordJobEnvelope | QueueJob>;
