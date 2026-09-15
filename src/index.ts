import { appOrigin, createLogin, finishLogin, startLogin } from './auth';
import { meetingWeb } from './meeting-web';
import { equalSecret } from './crypto';
import { AppError } from './errors';
import { accessToken, googleDocs } from './google';
import { documentId } from './template';
import { createTab } from './documents';
import { collectorApi } from './collector-control';
import { handleDiscord, consumeDiscordJobs, type DiscordQueueJob } from './discord';
import { connectionProfile, enqueueProfile } from './discord-profile';

import { cloudApi } from './cloud/api';
import { consume } from './cloud/jobs';
import type { QueueJob } from './cloud/model';
export { MeetingPoll } from './meeting-poll';
export { MeetingDone } from './meeting-done';
export { MeetingScheduler } from './meeting-scheduler';
export { MeetingStart } from './meeting-start';
export { CollectionRecovery } from './cloud/recovery';

interface Tab { tabProperties: { tabId: string; title: string }; childTabs?: Tab[] }
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/discord/interactions' && request.method === 'POST') return handleDiscord(request, env, ctx);
  if (url.pathname.startsWith('/mtg/')) return meetingWeb(request, env);
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
  if (url.pathname.startsWith('/auth/')) {
    if (url.origin !== appOrigin(env)) throw new AppError(400, '認証URLのホストがAPP_ORIGINと一致しません。');
    if (url.pathname === '/auth/start' && request.method === 'GET') return startLogin(request, env);
    if (url.pathname === '/auth/callback' && request.method === 'GET') return finishLogin(request, env, ctx);
  }
  if (!url.pathname.startsWith('/api/')) throw new AppError(404, 'コマンドラインから pnpm demo --help を実行してください。');
  if (!env.DEMO_API_KEY || env.DEMO_API_KEY.length < 32) throw new AppError(503, 'DEMO_API_KEYを設定してください。');
  if (!await equalSecret(request.headers.get('Authorization') ?? '', `Bearer ${env.DEMO_API_KEY}`)) throw new AppError(401, 'DEMO_API_KEYが一致しません。');
  if (url.pathname === '/api/discord/profile' && ['GET', 'POST'].includes(request.method)) {
    const guild = url.searchParams.get('guild') ?? '';
    if (!/^\d{17,20}$/.test(guild)) throw new AppError(400, 'guildにサーバーIDを指定してください。');
    if (request.method === 'POST') {
      if (!env.DISCORD_BOT_TOKEN) throw new AppError(503, 'DISCORD_BOT_TOKENを設定してください。');
      await enqueueProfile(env, guild);
      return Response.json({ accepted: true }, { status: 202 });
    }
    const sync = await env.DB.prepare('SELECT synced_at, error FROM discord_profile_sync WHERE guild_id = ?').bind(guild).first();
    return Response.json({ ...await connectionProfile(env, guild), sync });
  }
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
  async queue(batch: MessageBatch<DiscordQueueJob | QueueJob>, env: Env) {
    // Queue names may differ between local testing and a provisioned environment.
    const collection = batch.messages.every(m => 'kind' in m.body && m.body.kind === 'collection');
    if (collection) await consume(batch as MessageBatch<QueueJob>, env);
    else await consumeDiscordJobs(batch as MessageBatch<DiscordQueueJob>, env);
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
    if (!response.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    return response;
  },
} satisfies ExportedHandler<Env, DiscordQueueJob | QueueJob>;
