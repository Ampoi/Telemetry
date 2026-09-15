import { AppError } from '../errors';
import { hash } from '../crypto';
import { iso, type Task, type Guild, type Channel, type RemoteMessage } from './model';

// Every mutation made by a consumer is fenced in SQL, including when a fetch outlives its lease.
export function fence(env: Env, task: Task, sql: string, values: (string | number | null)[] = []): D1PreparedStatement {
  return env.DB.prepare(sql.replaceAll('$FENCE', 'EXISTS(SELECT 1 FROM cloud_tasks WHERE id=? AND generation=? AND status=\'running\' AND lease_until>?)'))
    .bind(...values, task.id, task.generation, Date.now());
}
export async function claim(env: Env, id: string): Promise<Task | null> {
  const now = Date.now();
  return env.DB.prepare("UPDATE cloud_tasks SET status='running',generation=generation+1,lease_until=?,attempts=attempts+1,updated=? WHERE id=? AND due<=? AND (status='pending' OR (status='running' AND lease_until<=?)) RETURNING *")
    .bind(now+180_000,now,id,now,now).first<Task>();
}
export async function enqueue(env: Env, guild: string, channel: string | null, kind: Task['kind'], payload: unknown, taskId = crypto.randomUUID()): Promise<string> {
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO cloud_tasks(id,guild,channel,kind,payload,created,updated) VALUES(?,?,?,?,?,?,?) RETURNING id')
    .bind(taskId,guild,channel,kind,JSON.stringify(payload),Date.now(),Date.now()).first<{id:string}>();
  const active = inserted ?? await env.DB.prepare("SELECT id FROM cloud_tasks WHERE id=? OR (guild=? AND channel=? AND kind=? AND status IN ('pending','running')) LIMIT 1").bind(taskId,guild,channel,kind).first<{id:string}>();
  if (!active) throw new AppError(409, 'ジョブを登録できませんでした。');
  await publish(env,active.id);
  return active.id;
}
export async function publish(env:Env,id:string,delaySeconds=0):Promise<void> {
  // The D1 row is the durable outbox, so transport failure does not lose acceptance.
  await env.COLLECTION_JOBS.send({kind:'collection',id},{delaySeconds}).catch(()=>{
    console.error(JSON.stringify({event:'collection_publish_failed',id}));
  });
}

export async function progress(env: Env, task: Task, payload: unknown, done: boolean, extra: D1PreparedStatement[] = []): Promise<void> {
  await env.DB.batch([...extra, fence(env,task,"UPDATE cloud_tasks SET payload=?,status=?,lease_until=0,failures=0,error=NULL,updated=? WHERE id=? AND $FENCE", [JSON.stringify(payload),done?'done':'pending',Date.now(),task.id])]);
  if (!done) await publish(env,task.id);
}
export async function context(env: Env, task: Task): Promise<{ guild: Guild; channel: Channel }> {
  const guild = await env.DB.prepare('SELECT * FROM cloud_guilds WHERE guild=?').bind(task.guild).first<Guild>();
  const channel = await env.DB.prepare('SELECT * FROM cloud_channels WHERE guild=? AND channel=?').bind(task.guild,task.channel).first<Channel>();
  if (!guild || !channel) throw new AppError(404, '収集設定がありません。');
  return { guild,channel };
}
export async function saveMessage(env: Env, task: Task, channel: Channel, message: RemoteMessage, observed: number): Promise<void> {
  const revision = iso(message.edited_timestamp ?? message.timestamp);
  const old = await env.DB.prepare('SELECT deleted,revision,observed FROM cloud_messages WHERE guild=? AND id=?').bind(task.guild,message.id).first<{deleted:number;revision:string;observed:number}>();
  if (old?.deleted || (old && (old.revision > revision || (old.revision === revision && old.observed > observed)))) return;
  const data = {
    guild_id: task.guild, channel_id: channel.channel, channel_name: channel.name,
    thread_id: channel.parent ? channel.channel : null, thread_name: channel.parent ? channel.name : null,
    parent_channel_id: channel.parent, message_id: message.id, author_id: message.author.id,
    author_display_name: message.member?.nick ?? message.author.global_name ?? message.author.username,
    content: message.content, created_at: iso(message.timestamp), edited_at: message.edited_timestamp ? iso(message.edited_timestamp) : null,
    collected_at: iso(observed), reply_to_message_id: message.message_reference?.message_id ?? null,
    reply_to_channel_id: message.message_reference?.channel_id ?? null,
    jump_url: `https://discord.com/channels/${task.guild}/${channel.channel}/${message.id}`, department: channel.department,
    deleted: false, deleted_at: null,
  };
  // Attachment mutations only apply when the exact message snapshot still owns the row.
  const live = 'EXISTS(SELECT 1 FROM cloud_messages WHERE guild=? AND id=? AND deleted=0 AND revision=? AND observed=?)';
  const liveArgs = [task.guild,message.id,revision,observed];
  const attachments = await Promise.all(message.attachments.map(async a => ({ a, version: await hash(JSON.stringify([a.id,a.filename,a.content_type ?? null,a.size])) })));
  const statements = [fence(env,task,`INSERT INTO cloud_messages(guild,id,channel,created,revision,observed,data) SELECT ?,?,?,?,?,?,? WHERE $FENCE
    ON CONFLICT(guild,id) DO UPDATE SET revision=excluded.revision,observed=excluded.observed,data=excluded.data
    WHERE cloud_messages.deleted=0 AND (excluded.revision>cloud_messages.revision OR (excluded.revision=cloud_messages.revision AND excluded.observed>=cloud_messages.observed))`, [task.guild,message.id,channel.channel,data.created_at,revision,observed,JSON.stringify(data)])];
  // Keep URLs in metadata only. No URL or token enters errors/logs.
  for (const { a,version } of attachments) {
    statements.push(fence(env,task,`INSERT OR IGNORE INTO cloud_cleanup(storage_key) SELECT storage_key FROM cloud_attachments WHERE guild=? AND id=? AND version<>? AND storage_key IS NOT NULL AND ${live} AND $FENCE`,[task.guild,a.id,version,...liveArgs]));
    statements.push(fence(env,task,`INSERT INTO cloud_attachments(guild,id,message,channel,data,version) SELECT ?,?,?,?,?,? WHERE ${live} AND $FENCE
      ON CONFLICT(guild,id) DO UPDATE SET data=excluded.data,version=excluded.version,
      status=CASE WHEN cloud_attachments.version=excluded.version THEN cloud_attachments.status ELSE 'pending' END,
      storage_key=CASE WHEN cloud_attachments.version=excluded.version THEN cloud_attachments.storage_key ELSE NULL END,
      attempts=CASE WHEN cloud_attachments.version=excluded.version THEN cloud_attachments.attempts ELSE 0 END,
      retry_start=CASE WHEN cloud_attachments.version=excluded.version THEN cloud_attachments.retry_start ELSE 0 END`,[task.guild,a.id,message.id,channel.channel,JSON.stringify({attachment_id:a.id,message_id:message.id,filename:a.filename,content_type:a.content_type??null,size:a.size,url:a.url}),version,...liveArgs]));
  }
  const ids = JSON.stringify(message.attachments.map(a=>a.id));
  statements.push(fence(env,task,`INSERT OR IGNORE INTO cloud_cleanup(storage_key) SELECT storage_key FROM cloud_attachments WHERE guild=? AND message=? AND id NOT IN (SELECT value FROM json_each(?)) AND storage_key IS NOT NULL AND ${live} AND $FENCE`,[task.guild,message.id,ids,...liveArgs]));
  statements.push(fence(env,task,`DELETE FROM cloud_attachments WHERE guild=? AND message=? AND id NOT IN (SELECT value FROM json_each(?)) AND ${live} AND $FENCE`,[task.guild,message.id,ids,...liveArgs]));
  // D1 batches are transactional; pages may commit message-by-message, but cursor advancement is last.
  await env.DB.batch(statements);
}
export async function tombstone(env: Env, task: Task, channel: Channel, messageId: string, created: string): Promise<void> {
  const data = {guild_id:task.guild,channel_id:channel.channel,message_id:messageId,created_at:created,jump_url:`https://discord.com/channels/${task.guild}/${channel.channel}/${messageId}`,deleted:true,deleted_at:iso(Date.now())};
  await env.DB.batch([
    fence(env,task,'INSERT OR IGNORE INTO cloud_cleanup(storage_key) SELECT storage_key FROM cloud_attachments WHERE guild=? AND message=? AND storage_key IS NOT NULL AND $FENCE',[task.guild,messageId]),
    fence(env,task,'DELETE FROM cloud_attachments WHERE guild=? AND message=? AND $FENCE',[task.guild,messageId]),
    fence(env,task,'UPDATE cloud_messages SET deleted=1,data=?,verified=? WHERE guild=? AND id=? AND $FENCE',[JSON.stringify(data),Date.now(),task.guild,messageId]),
  ]);
}
export async function exportRecord(env: Env, row: { guild: string; id: string; data: string; deleted: number }): Promise<unknown> {
  const attachments = row.deleted ? [] : (await env.DB.prepare('SELECT data,status,storage_key,attempts,reason FROM cloud_attachments WHERE guild=? AND message=? ORDER BY id').bind(row.guild,row.id).all<{data:string;status:string;storage_key:string|null;attempts:number;reason:string|null}>()).results.map(a=>({...JSON.parse(a.data),status:a.status,storage_key:a.storage_key,attempts:a.attempts,reason:a.reason}));
  return { schema_version: 2, ...JSON.parse(row.data), attachments };
}
