import { AppError } from '../errors';
export class DiscordError extends AppError {
  constructor(public httpStatus: number, public code: number, public retryAfter = 0) { super(httpStatus === 429 ? 429 : 502, `Discord API: HTTP ${httpStatus}, code ${code}`); }
}
export async function discord<T>(env: Env, path: string): Promise<T> {
  if (!env.DISCORD_BOT_TOKEN) throw new AppError(503, '収集WorkerにDISCORD_BOT_TOKENを設定してください。');
  const response = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new DiscordError(response.status, 0); }
  const body = await response.json() as T & { code?: number; retry_after?: number };
  if (!response.ok) throw new DiscordError(response.status, typeof body.code === 'number' ? body.code : 0, Math.max(1,Math.ceil(Number(body.retry_after) || Number(response.headers.get('Retry-After')) || 5)));
  return body;
}
