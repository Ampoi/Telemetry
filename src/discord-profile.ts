import { hash } from './crypto';
import { guildOwner } from './discord-guild';
import { AppError } from './errors';
import { DiscordError } from './cloud/discord-rest';

export interface ProfileJob { kind: 'profile'; id: string }

export async function connectionProfile(env: Env, guild: string) {
  const [settings, credential] = await Promise.all([
    env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id = ?').bind(guild).first<{ document_id: string }>(),
    env.DB.prepare('SELECT email FROM credentials WHERE id = ?').bind(guildOwner(guild)).first<{ email: string | null }>(),
  ]);
  return { documentUrl: settings ? `https://docs.google.com/document/d/${settings.document_id}/edit` : null,
    connected: !!credential, email: credential?.email ?? null };
}

export function profileBio(profile: { documentUrl: string | null; connected: boolean; email: string | null }): string {
  const account = !profile.connected ? '設定されてないです（/auth）' : profile.email ?? '接続済み・メール未取得（/authで再接続）';
  const document = profile.documentUrl ?? '設定されてないです（/document）';
  const bio = `Google: ${account}\nDocs: ${document}`;
  // Never publish a truncated email address or a broken document URL.
  if (bio.length <= 190) return bio;
  const compact = `${account}\n${document}`;
  if (compact.length <= 190) return compact;
  return 'Google連携の情報がプロフィールの文字数上限を超えています。\n/document で接続メールアドレスとドキュメントURLを確認してください。';
}

export function applicationDescription(configured: boolean): string {
  return `${configured ? '接続情報はサーバーごとに設定されています。' : '設定されてないです'}\nサーバーごとのドキュメントURL・接続メールは /document で確認できます。\n/auth でGoogle接続、/document で保存先を設定してください。`;
}

async function syncApplicationProfile(env: Env): Promise<void> {
  // Discord's common About Me uses the application description. It is visible
  // outside the guild too, so never copy a guild's email or document URL here.
  const configured = await env.DB.prepare("SELECT 1 AS found FROM discord_guild_settings s JOIN credentials c ON c.id = 'discord:guild:' || s.guild_id LIMIT 1").first();
  const description = applicationDescription(!!configured);
  const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' };
  const current = await fetch('https://discord.com/api/v10/applications/@me', {
    headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  if (!current.ok) { await discordFailure(current); }
  const application = await current.json<{ description?: string }>();
  if (application.description === description) return;
  const response = await fetch('https://discord.com/api/v10/applications/@me', {
    method: 'PATCH', headers, body: JSON.stringify({ description }),
    redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) { await discordFailure(response); }
  const updated = await response.json<{ description?: string }>();
  if (updated.description !== description) throw new Error('ApplicationDescriptionNotUpdated');
}

async function discordFailure(response: Response): Promise<never> {
  const body = await response.json<{ code?: number; retry_after?: number }>().catch(() => ({} as { code?: number; retry_after?: number }));
  throw new DiscordError(response.status, body.code ?? 0, Math.min(43200, Math.max(1, Math.ceil(body.retry_after ?? (Number(response.headers.get('Retry-After')) || 5)))));
}

export async function enqueueProfile(env: Env, guild: string): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) return;
  await env.DISCORD_JOBS.send({ kind: 'profile', id: guild } satisfies ProfileJob);
}

export function refreshProfile(env: Env, ctx: ExecutionContext, guild: string): void {
  ctx.waitUntil(enqueueProfile(env, guild).catch(() => {
    console.error(JSON.stringify({ event: 'discord_profile_enqueue_failed', guild }));
  }));
}

export async function syncProfile(env: Env, guild: string): Promise<void> {
  if (!/^\d{17,20}$/.test(guild)) throw new AppError(400, 'Invalid guild.');
  if (!env.DISCORD_BOT_TOKEN) throw new AppError(503, 'DISCORD_BOT_TOKENを設定してください。');
  await syncApplicationProfile(env);
  // This runs in the serial Docs queue. Read current data at execution time so
  // delayed/redelivered jobs cannot restore an old account or document.
  const bio = profileBio(await connectionProfile(env, guild));
  const bioHash = await hash(bio);
  const previous = await env.DB.prepare('SELECT bio_hash FROM discord_profile_sync WHERE guild_id = ?').bind(guild).first<{ bio_hash: string | null }>();
  if (previous?.bio_hash === bioHash) return;
  const response = await fetch(`https://discord.com/api/v10/guilds/${guild}/members/@me`, {
    method: 'PATCH', headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bio }), redirect: 'manual', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await discordFailure(response);
  }
  await response.body?.cancel();
  await env.DB.prepare('INSERT INTO discord_profile_sync (guild_id, bio_hash, synced_at, error) VALUES (?, ?, ?, NULL) ON CONFLICT(guild_id) DO UPDATE SET bio_hash = excluded.bio_hash, synced_at = excluded.synced_at, error = NULL')
    .bind(guild, bioHash, Date.now()).run();
}

export async function consumeProfile(queued: Message<ProfileJob>, env: Env): Promise<void> {
  try { await syncProfile(env, queued.body.id); queued.ack(); }
  catch (error) {
    const message = error instanceof DiscordError ? error.message : 'プロフィールの更新に失敗しました。';
    await env.DB.prepare('INSERT INTO discord_profile_sync (guild_id, error) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET error = excluded.error')
      .bind(queued.body.id, message).run();
    queued.retry({ delaySeconds: error instanceof DiscordError ? error.retryAfter || 5 : 5 });
  }
}
