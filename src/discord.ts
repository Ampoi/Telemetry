import { createLogin } from './auth';
import { decrypt, encrypt } from './crypto';
import { createTab } from './documents';
import { AppError } from './errors';
import { documentId } from './template';
import { cloudInteraction } from './cloud/api';
import { acceptCollector } from './collector-control';
import { guildOwner, requireGuildManager } from './discord-guild';
import { meetingInteraction } from './meeting-discord';

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  member?: { user?: { id: string }; permissions?: string };
  user?: { id: string };
  data?: { name: string; options?: { name: string; type: number; value: unknown; options?: { name: string; type: number; value: unknown }[] }[] };
}
interface CreateJob { id: string; applicationId: string; token: string; guildId: string; owner: string; document: string; title: string; message: string; createdAt: string; expiresAt: number }
export interface DiscordJobEnvelope { id: string; encrypted: string }

function ephemeral(content: string) {
  return Response.json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
}
function fromHex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16));
}
async function verifiedBody(request: Request, publicKey: string): Promise<string> {
  const signature = request.headers.get('X-Signature-Ed25519') ?? '';
  const timestamp = request.headers.get('X-Signature-Timestamp') ?? '';
  if (!/^[a-f\d]{64}$/i.test(publicKey)) throw new AppError(503, 'DISCORD_PUBLIC_KEYを設定してください。');
  if (!/^[a-f\d]{128}$/i.test(signature) || !/^\d{10,11}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new AppError(401, 'Invalid Discord signature.');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, 'Empty interaction.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 200_000) { await reader.cancel(); throw new AppError(413, 'Interaction too large.'); }
    chunks.push(value);
  }
  const prefix = new TextEncoder().encode(timestamp);
  const signed = new Uint8Array(prefix.length + size);
  signed.set(prefix);
  let offset = prefix.length;
  for (const chunk of chunks) { signed.set(chunk, offset); offset += chunk.length; }
  const key = await crypto.subtle.importKey('raw', fromHex(publicKey), 'Ed25519', false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, fromHex(signature), signed)) throw new AppError(401, 'Invalid Discord signature.');
  return new TextDecoder().decode(signed.subarray(prefix.length));
}

export async function handleDiscord(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await verifiedBody(request, env.DISCORD_PUBLIC_KEY);
  let interaction: Interaction;
  try { interaction = JSON.parse(raw); } catch { throw new AppError(400, 'Invalid interaction JSON.'); }
  if (!interaction || interaction.application_id !== env.DISCORD_APPLICATION_ID) throw new AppError(401, 'Discord application mismatch.');
  if (interaction.type === 1) return Response.json({ type: 1 });
  if (interaction.type !== 2) return ephemeral('対応しているコマンドは /auth・/document・/create・/telemetry・/mtg です。');
  const userId = interaction.member?.user?.id ?? interaction.user?.id;
  if (!userId || !/^\d{17,20}$/.test(userId) || !/^\d{17,20}$/.test(interaction.id) || typeof interaction.token !== 'string' || !interaction.token) throw new AppError(400, 'Discord user or interaction missing.');
  try {
    if (interaction.data?.name === 'mtg') return await meetingInteraction(interaction, env, ctx);
    if (interaction.data?.name === 'telemetry') return await (env.COLLECTION_MODE === 'cloud' ? cloudInteraction(interaction, env, ctx) : acceptCollector(interaction, env));
    if (!['auth', 'document', 'create'].includes(interaction.data?.name ?? '')) return ephemeral('対応しているコマンドは /auth・/document・/create・/telemetry です。');
    const guildId = requireGuildManager(interaction);
    const owner = guildOwner(guildId);
    if (interaction.data?.name === 'auth') {
      const login = await createLogin(env, owner);
      return Response.json({ type: 4, data: {
        content: `このサーバー（ID: ${guildId}）専用のGoogle接続です。接続したアカウントは、このサーバーの管理者による /create に使用されます。下のボタンから編集を許可してください（10分間有効）。このリンクは他の人に渡さないでください。`,
        flags: 64, allowed_mentions: { parse: [] },
        components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Googleアカウントを接続', url: login.url }] }],
      } });
    }
    const options = interaction.data?.options ?? [];
    const option = (name: string, fallback = '') => {
      const found = options.find(o => o.name === name);
      if (!found) return fallback;
      if (found.type !== 3 || typeof found.value !== 'string') throw new AppError(400, `${name}は文字列で指定してください。`);
      return found.value;
    };
    const specifiedDocument = option('document');
    if (options.some(o => o.name === 'document') && (!specifiedDocument.trim() || specifiedDocument.length > 500)) throw new AppError(400, 'ドキュメントのURLまたはIDは1〜500文字で指定してください。');
    if (interaction.data?.name === 'document') {
      if (specifiedDocument) {
        const id = documentId(specifiedDocument);
        await env.DB.prepare('INSERT INTO discord_guild_settings (guild_id, document_id, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET document_id = excluded.document_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at')
          .bind(guildId, id, userId, Date.now()).run();
        return ephemeral(`このサーバーの保存先を設定しました。\nhttps://docs.google.com/document/d/${id}/edit\n/auth で接続後、/create でタブを作成できます。`);
      }
      const settings = await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id = ?').bind(guildId).first<{ document_id: string }>();
      const connection = await env.DB.prepare('SELECT connected_at FROM credentials WHERE id = ?').bind(owner).first();
      return ephemeral(`このサーバーの保存先: ${settings ? `https://docs.google.com/document/d/${settings.document_id}/edit` : '未設定（/document document:URL で設定）'}\nGoogle接続: ${connection ? '登録済み（有効性は作成時に確認）' : '未接続（/auth で接続）'}`);
    }
    const settings = specifiedDocument ? null : await env.DB.prepare('SELECT document_id FROM discord_guild_settings WHERE guild_id = ?').bind(guildId).first<{ document_id: string }>();
    const targetDocument = specifiedDocument || settings?.document_id;
    if (!targetDocument) throw new AppError(400, 'このサーバーの保存先が未設定です。/document document:URL で設定するか、/create document:URL を指定してください。');
    // Snowflake time is stable across redelivery of the same interaction.
    const createdAt = new Date(Number((BigInt(interaction.id) >> 22n) + 1420070400000n)).toISOString();
    const title = option('title', `デバッグ ${createdAt}`);
    const message = option('message', 'Discordの /create から作成しました。');
    if (!title.trim() || title.length > 100 || /[\u0000-\u001f]/.test(title)) throw new AppError(400, 'タブ名は改行なしの1〜100文字にしてください。');
    if (message.length > 1000) throw new AppError(400, 'メモは1,000文字以内にしてください。');
    const job: CreateJob = { id: interaction.id, applicationId: interaction.application_id, token: interaction.token, guildId, owner,
      document: documentId(targetDocument), title, message, createdAt, expiresAt: new Date(createdAt).getTime() + 14 * 60_000 };
    if (job.expiresAt <= Date.now()) return ephemeral('コマンドの有効時間を過ぎています。/create を再実行してください。');
    // Only queue publishing runs after the response; Google work runs in the queue consumer.
    ctx.waitUntil((async () => {
      try {
        const encrypted = await encrypt(JSON.stringify(job), env.TOKEN_ENCRYPTION_KEY, `discord-job:${job.id}`);
        await env.DISCORD_JOBS.send({ id: job.id, encrypted });
      } catch {
        await editReply(job, '作成処理を受け付けられませんでした。少し待って /create を再実行してください。').catch(() => {
          console.error(JSON.stringify({ event: 'discord_enqueue_failed', interactionId: job.id }));
        });
      }
    })());
    return Response.json({ type: 5, data: { flags: 64 } });
  } catch (error) {
    return ephemeral(error instanceof AppError ? error.message : '設定を確認してください。Google OAuth・D1・Discordの設定が必要です。');
  }
}

async function editReply(job: CreateJob, content: string): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/webhooks/${job.applicationId}/${encodeURIComponent(job.token)}/messages/@original`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Discord reply failed: ${response.status}`);
}

export async function consumeDiscordJobs(batch: MessageBatch<DiscordJobEnvelope>, env: Env): Promise<void> {
  for (const queued of batch.messages) {
    try {
      const job = JSON.parse(await decrypt(queued.body.encrypted, env.TOKEN_ENCRYPTION_KEY, `discord-job:${queued.body.id}`)) as CreateJob;
      if (job.expiresAt <= Date.now()) { queued.ack(); continue; }
      // Pre-migration jobs have personal credentials and no server context.
      if (!/^\d{17,20}$/.test(job.guildId ?? '') || job.owner !== guildOwner(job.guildId)) {
        await editReply(job, 'サーバー別Google連携への切り替えにより、この作成処理を停止しました。サーバー内で /auth と /create を再実行してください。');
        queued.ack(); continue;
      }
      const request = new Request('https://internal.invalid/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document: job.document, title: job.title,
          template: '# デバッグ記録\n\n作成日時: {{createdAt}}\n実行ID: {{runId}}\n\n## メモ\n{{message}}\n',
          data: { createdAt: job.createdAt, runId: job.id, message: job.message }, requestId: job.id }),
      });
      let content: string;
      try {
        const result = await (await createTab(request, env, job.owner)).json<{ url: string }>();
        content = `タブを作成してデバッグ内容を入力しました。\n${result.url}`;
      } catch (error) {
        const url = error instanceof AppError ? error.details?.url ?? (error.details?.previousResult as { url?: string } | undefined)?.url : undefined;
        content = `${error instanceof AppError ? error.message : '処理が中断しました。ドキュメントを確認してください。'}${url ? `\n${url}` : ''}`;
      }
      // Retrying a failed Discord delivery reuses the interaction ID; no duplicate Google writes.
      await editReply(job, content);
      queued.ack();
    } catch {
      console.error(JSON.stringify({ event: 'discord_job_delivery_failed', interactionId: queued.body.id }));
      queued.retry({ delaySeconds: 5 });
    }
  }
}
