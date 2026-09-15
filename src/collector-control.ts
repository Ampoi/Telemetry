import { encrypt, decrypt } from './crypto';
import { AppError } from './errors';

export interface CollectorInteraction {
  id: string; application_id: string; token: string; guild_id?: string;
  member?: { permissions?: string; user?: { id: string } };
  data?: { options?: { name: string; type: number; options?: { name: string; type: number; value: unknown }[] }[] };
}
export async function acceptCollector(interaction: CollectorInteraction, env: Env): Promise<Response> {
  const permissions = interaction.member?.permissions ?? '';
  if (!interaction.guild_id || !/^\d{17,20}$/.test(interaction.guild_id) || !/^\d+$/.test(permissions) || (BigInt(permissions) & (32n | 8n)) === 0n) throw new AppError(403, '収集コマンドにはサーバー管理権限が必要です。');
  const option = interaction.data?.options?.[0];
  if (!option || option.type !== 1 || !['status', 'backfill'].includes(option.name)) throw new AppError(400, '/telemetry status または /telemetry backfill days:日数 を指定してください。');
  const daysOption = option.options?.find(o => o.name === 'days');
  const days = option.name === 'backfill' ? daysOption?.value : null;
  if (option.name === 'backfill' && (daysOption?.type !== 4 || typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) throw new AppError(400, 'daysは1〜3650の整数です。');
  const expires = Number((BigInt(interaction.id) >> 22n) + 1420070400000n) + 14 * 60_000;
  if (expires <= Date.now()) throw new AppError(400, 'コマンドの有効期限が切れました。再実行してください。');
  const encrypted = await encrypt(JSON.stringify({ application: interaction.application_id, token: interaction.token }), env.TOKEN_ENCRYPTION_KEY, `collector:${interaction.id}`);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM collector_commands WHERE expires < ?').bind(Date.now() - 86400_000),
    env.DB.prepare('INSERT OR IGNORE INTO collector_commands(id,guild,user,kind,days,encrypted,expires) VALUES(?,?,?,?,?,?,?)').bind(interaction.id, interaction.guild_id, interaction.member!.user!.id, option.name, days, encrypted, expires),
  ]);
  return Response.json({ type: 5, data: { flags: 64 } });
}
export async function collectorApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), now = Date.now();
  if (request.method === 'GET' && url.pathname === '/api/collector/commands') {
    const guild = url.searchParams.get('guild') ?? '';
    if (!/^\d{17,20}$/.test(guild)) throw new AppError(400, 'guildを指定してください。');
    const lease = crypto.randomUUID();
    // Atomic claim; a second poller cannot claim the same lease until timeout.
    const result = await env.DB.prepare('UPDATE collector_commands SET lease=?,lease_until=? WHERE id IN (SELECT id FROM collector_commands WHERE guild=? AND delivered=0 AND expires>? AND lease_until<? ORDER BY id LIMIT 5) RETURNING id,guild,user,kind,days,lease').bind(lease, now + 60_000, guild, now, now).all();
    return Response.json({ commands: result.results });
  }
  const match = url.pathname.match(/^\/api\/collector\/commands\/(\d{17,20})\/result$/);
  if (request.method !== 'POST' || !match) throw new AppError(404, 'Collector endpoint not found.');
  const reader = request.body?.getReader(); let text = '';
  if (!reader) throw new AppError(400, 'Empty result.');
  const decoder = new TextDecoder(); let bytes = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 16_000) { await reader.cancel(); throw new AppError(413, 'Result too large.'); } text += decoder.decode(value, { stream: true }); }
  text += decoder.decode();
  let body: { guild?: string; lease?: string; content?: string }; try { body = JSON.parse(text); } catch { throw new AppError(400, 'Invalid result.'); }
  if (!body || typeof body.guild !== 'string' || typeof body.lease !== 'string' || typeof body.content !== 'string' || !body.content || body.content.length > 2000) throw new AppError(400, 'Invalid result.');
  const row = await env.DB.prepare('SELECT encrypted,expires,result,delivered FROM collector_commands WHERE id=? AND guild=? AND lease=?').bind(match[1], body.guild, body.lease).first<{ encrypted: string; expires: number; result: string | null; delivered: number }>();
  if (!row) throw new AppError(409, 'Collector lease mismatch.');
  if (row.delivered) return Response.json({ ok: true });
  if (row.expires <= now) throw new AppError(410, 'Interaction expired.');
  await env.DB.prepare('UPDATE collector_commands SET result=COALESCE(result,?) WHERE id=?').bind(body.content, match[1]).run();
  const reply = JSON.parse(await decrypt(row.encrypted, env.TOKEN_ENCRYPTION_KEY, `collector:${match[1]}`)) as { application: string; token: string };
  const response = await fetch(`https://discord.com/api/v10/webhooks/${reply.application}/${encodeURIComponent(reply.token)}/messages/@original`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: row.result ?? body.content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  if (!response.ok) throw new AppError(502, 'Discordへの返信に失敗しました。');
  await env.DB.prepare('UPDATE collector_commands SET delivered=1,encrypted=? WHERE id=?').bind('', match[1]).run();
  return Response.json({ ok: true });
}
