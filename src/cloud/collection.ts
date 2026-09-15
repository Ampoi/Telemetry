import { AppError } from '../errors';
import { discord, DiscordError } from './discord-rest';
import { config, included, iso, snowflake, type Task, type Guild, type Channel, type RemoteChannel, type RemoteMessage } from './model';
import { context, publish, fence, progress, saveMessage, tombstone } from './store';
import { ensureRecovery } from './recovery-wakeup';

export async function startScans(env: Env, guildId: string, days?: number, requestId?: string, ctx?: ExecutionContext): Promise<string[]> {
  const guild = await env.DB.prepare('SELECT * FROM cloud_guilds WHERE guild=?').bind(guildId).first<Guild>();
  if (!guild) throw new AppError(400, '先に管理CLIで収集対象を設定してください。');
  await ensureRecovery(env,guildId);
  const cfg = config(JSON.parse(guild.config));
  const channels = (await env.DB.prepare('SELECT * FROM cloud_channels WHERE guild=?').bind(guildId).all<Channel>()).results;
  const now = Date.now(), runId = requestId ?? crypto.randomUUID();
  const plans: {id:string;channel:string;kind:Task['kind'];payload:unknown}[] = [];
  const add = (channel:string,kind:Task['kind'],payload:unknown) => plans.push({id:`${runId}:${kind}:${channel}`,channel,kind,payload});
  for (const channel of channels) {
    if (!cfg.channels.some(c=>c.id===(channel.parent??channel.channel))) continue;
    if (!channel.parent) add(channel.channel,'discover',{stage:'active',start:days===undefined?Math.max(guild.started,now-cfg.overlap_hours*3600_000):now-days*86400_000,end:now,backfill:days!==undefined});
    if (channel.kind===15) continue;
    const start=days===undefined?Math.max(guild.started,(channel.scanned_until||now)-cfg.overlap_hours*3600_000):now-days*86400_000;
    add(channel.channel,'scan',{start,end:now,before:snowflake(now),backfill:days!==undefined});
    if (days===undefined) add(channel.channel,'verify',{start:iso(now-cfg.verify_days*86400_000),cutoff:now-cfg.verify_interval_minutes*60_000});
  }
  const statements:D1PreparedStatement[]=[];
  if (days!==undefined) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO cloud_controls(id,guild,result) SELECT ?,?,?
    WHERE NOT EXISTS(SELECT 1 FROM cloud_tasks WHERE guild=? AND kind IN ('scan','discover') AND status IN ('pending','running'))`)
    .bind(runId,guildId,`過去${days}日分の履歴取得を受け付けました。完了は /telemetry status で確認してください。`,guildId));
  for (const plan of plans) statements.push(env.DB.prepare('INSERT OR IGNORE INTO cloud_tasks(id,guild,channel,kind,payload,created,updated) SELECT ?,?,?,?,?,?,?'+(days===undefined?'':' WHERE EXISTS(SELECT 1 FROM cloud_controls WHERE id=? AND guild=?)'))
    .bind(plan.id,guildId,plan.channel,plan.kind,JSON.stringify(plan.payload),now,now,...(days===undefined?[]:[runId,guildId])));
  // Acceptance and every per-channel task commit in one transaction. Concurrent
  // backfills either reuse this request or fail before accepting any channels.
  if(statements.length)await env.DB.batch(statements);
  if(days!==undefined && !await env.DB.prepare('SELECT id FROM cloud_controls WHERE id=? AND guild=?').bind(runId,guildId).first())throw new AppError(409,'履歴取得が進行中です。statusで完了を確認してから再実行してください。');
  const tasks=(await env.DB.prepare('SELECT id FROM cloud_tasks WHERE id LIKE ?').bind(`${runId}:%`).all<{id:string}>()).results;
  const sending=Promise.all(tasks.map(task=>publish(env,task.id)));
  if(ctx)ctx.waitUntil(sending);else await sending;
  return tasks.map(t=>t.id);
}

export async function scan(env: Env, task: Task): Promise<void> {
  const { guild,channel } = await context(env,task), cfg = config(JSON.parse(guild.config));
  const p = JSON.parse(task.payload) as { start:number;end:number;before:string;backfill:boolean };
  const observed = Date.now();
  const messages = await discord<RemoteMessage[]>(env,`/channels/${channel.channel}/messages?limit=100&before=${p.before}`);
  for (const m of messages) {
    if (m.channel_id !== channel.channel) throw new Error('ChannelMismatch');
    const timestamp = new Date(m.timestamp).getTime();
    if (timestamp>=p.start && timestamp<p.end && included(m,guild,cfg)) await saveMessage(env,task,channel,m,observed);
  }
  const smallest = messages.reduce((min,m)=>BigInt(m.id)<BigInt(min)?m.id:min,p.before);
  const done = messages.length<100 || messages.some(m=>new Date(m.timestamp).getTime()<p.start);
  if (!done && BigInt(smallest)>=BigInt(p.before)) throw new Error('PaginationStalled');
  const extra = done && !p.backfill ? [fence(env,task,'UPDATE cloud_channels SET scanned_until=MAX(scanned_until,?) WHERE guild=? AND channel=? AND $FENCE',[p.end,task.guild,channel.channel])] : [];
  await progress(env,task,{...p,before:smallest},done,extra);
}
export async function discover(env: Env, task: Task): Promise<void> {
  const {guild,channel} = await context(env,task);
  const cfg=config(JSON.parse(guild.config));
  const p = JSON.parse(task.payload) as {stage:'active'|'public'|'private';before?:string;start:number;end:number;backfill:boolean};
  const path = p.stage === 'active' ? `/guilds/${task.guild}/threads/active` : p.stage==='public' ? `/channels/${channel.channel}/threads/archived/public?limit=100` : `/channels/${channel.channel}/users/@me/threads/archived/private?limit=100`;
  const page = await discord<{threads:RemoteChannel[];has_more?:boolean}>(env,path+(p.before?`&before=${encodeURIComponent(p.before)}`:''));
  const threads = page.threads.filter(c=>c.parent_id===channel.channel && [10,11,12].includes(c.type));
  for (const thread of threads) {
    const known=await env.DB.prepare('SELECT scanned_until FROM cloud_channels WHERE guild=? AND channel=?').bind(task.guild,thread.id).first<{scanned_until:number}>();
    await fence(env,task,`INSERT INTO cloud_channels(guild,channel,parent,name,kind,department) SELECT ?,?,?,?,?,? WHERE $FENCE
      ON CONFLICT(guild,channel) DO UPDATE SET name=excluded.name,department=excluded.department`,[task.guild,thread.id,channel.channel,thread.name,thread.type,channel.department]).run();
    // Outbox child creation is fenced and atomic with its parent generation.
    const id = `${task.id}:thread:${thread.id}`;
    const start = p.backfill?p.start:Math.max(guild.started,(known?.scanned_until||guild.started)-cfg.overlap_hours*3600_000);
    await fence(env,task,'INSERT OR IGNORE INTO cloud_tasks(id,guild,channel,kind,payload,created,updated) SELECT ?,?,?,?,?,?,? WHERE $FENCE',[id,task.guild,thread.id,'scan',JSON.stringify({start,end:p.end,before:snowflake(p.end),backfill:p.backfill}),Date.now(),Date.now()]).run();
  }
  // Joined private archive pagination uses a thread snowflake, public archives a timestamp.
  const last = page.threads.at(-1);
  if (p.stage!=='active' && page.has_more) {
    const before = p.stage==='private'?last?.id:last?.thread_metadata?.archive_timestamp;
    if (!before || before===p.before) throw new Error('ThreadPaginationStalled');
    await progress(env,task,{...p,before},false); return;
  }
  const next = p.stage==='active'?'public':'private';
  const done = p.stage==='private' || (p.stage==='public' && channel.kind!==0);
  await progress(env,task,{...p,stage:next,before:undefined},done);
}
export async function verify(env: Env, task: Task): Promise<void> {
  const {guild,channel} = await context(env,task), cfg = config(JSON.parse(guild.config));
  const p = JSON.parse(task.payload) as {start:string;cutoff:number};
  const rows = (await env.DB.prepare('SELECT id,created FROM cloud_messages WHERE guild=? AND channel=? AND deleted=0 AND created>=? AND verified<? ORDER BY verified,id LIMIT 10').bind(task.guild,channel.channel,p.start,p.cutoff).all<{id:string;created:string}>()).results;
  for (const row of rows) {
    const observed = Date.now();
    try {
      const m = await discord<RemoteMessage>(env,`/channels/${channel.channel}/messages/${row.id}`);
      if (m.id!==row.id || m.channel_id!==channel.channel) throw new Error('MessageMismatch');
      if (included(m,guild,cfg)) await saveMessage(env,task,channel,m,observed);
      await fence(env,task,'UPDATE cloud_messages SET verified=? WHERE guild=? AND id=? AND $FENCE',[observed,task.guild,row.id]).run();
    } catch(error) {
      if (error instanceof DiscordError && error.httpStatus===404 && error.code===10008) await tombstone(env,task,channel,row.id,row.created);
      else throw error; // 403, unknown channel, etc. are never deletions.
    }
  }
  await progress(env,task,p,rows.length<10);
}
