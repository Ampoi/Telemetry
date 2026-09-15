import { AppError } from '../errors';
import { requireGuildManager } from '../discord-guild';
import type { CollectorInteraction } from '../collector-control';
import { config, id, jsonBody, bounds, type RemoteChannel } from './model';
import { discord } from './discord-rest';
import { startScans } from './collection';
import { dispatch } from './jobs';
import { publish } from './store';
import { ensureRecovery } from './recovery-wakeup';

export async function status(env:Env,guild:string):Promise<unknown> {
  const settings=await env.DB.prepare('SELECT config,started FROM cloud_guilds WHERE guild=?').bind(guild).first();
  if(!settings)throw new AppError(404,'収集対象が未設定です。管理CLIでconfigureを実行してください。');
  const channels=(await env.DB.prepare('SELECT channel,parent,name,scanned_until FROM cloud_channels WHERE guild=? ORDER BY channel').bind(guild).all()).results;
  const tasks=(await env.DB.prepare('SELECT id,channel,kind,status,attempts,failures,error,created,updated FROM cloud_tasks WHERE guild=? ORDER BY updated DESC LIMIT 30').bind(guild).all()).results;
  const messages=await env.DB.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(deleted),0) AS deleted FROM cloud_messages WHERE guild=?').bind(guild).first();
  const attachments=(await env.DB.prepare('SELECT status,COUNT(*) AS count FROM cloud_attachments WHERE guild=? GROUP BY status').bind(guild).all()).results;
  return {mode:'cloud-rest',schema_version:2,settings,channels,messages,attachments,tasks};
}
export async function cloudInteraction(interaction:CollectorInteraction,env:Env,ctx:ExecutionContext):Promise<Response> {
  const guild=requireGuildManager(interaction);
  const option=interaction.data?.options?.[0];
  if(!option || option.type!==1 || !['status','backfill'].includes(option.name))throw new AppError(400,'/telemetry status または backfill を指定してください。');
  let content:string;
  if(option.name==='status'){
    const result=await status(env,guild) as {messages:{total:number;deleted:number};tasks:{kind:string;status:string;error:string|null}[]};
    content=`Workers収集（REST）\n投稿: ${result.messages.total} / 削除記録: ${result.messages.deleted}\n${result.tasks.slice(0,8).map(t=>`${t.kind}: ${t.status}${t.error?` (${t.error})`:''}`).join('\n')}`;
  } else {
    const optionDays=option.options?.find(o=>o.name==='days'),days=optionDays?.value;
    if(optionDays?.type!==4 || typeof days!=='number' || !Number.isInteger(days) || days<1 || days>3650)throw new AppError(400,'daysは1〜3650の整数です。');
    const created=Number((BigInt(interaction.id)>>22n)+1420070400000n);
    if(created+14*60_000<=Date.now())throw new AppError(400,'コマンドの期限が切れました。');
    const previous=await env.DB.prepare('SELECT result FROM cloud_controls WHERE id=? AND guild=?').bind(interaction.id,guild).first<{result:string}>();
    if(previous)content=previous.result;
    else {
      await startScans(env,guild,days,interaction.id,ctx);
      content=`過去${days}日分の履歴取得を受け付けました。完了は /telemetry status で確認してください。`;
      await env.DB.prepare('INSERT OR IGNORE INTO cloud_controls(id,guild,result) VALUES(?,?,?)').bind(interaction.id,guild,content).run();
    }
  }
  return Response.json({type:4,data:{content:content.slice(0,2000),flags:64,allowed_mentions:{parse:[]}}});
}
export async function cloudApi(request:Request,env:Env):Promise<Response> {
  if(env.COLLECTION_MODE!=='cloud')throw new AppError(409,'COLLECTION_MODE=cloud が必要です。');
  const url=new URL(request.url),path=url.pathname.slice('/api/telemetry'.length);
  const guild=id(url.searchParams.get('guild'));
  if(path==='/config' && request.method==='PUT'){
    const cfg=config(await jsonBody(request));
    const bot=await discord<{id:string}>(env,'/users/@me');
    const channels:RemoteChannel[]=[];
    for(const target of cfg.channels){
      const remote=await discord<RemoteChannel>(env,`/channels/${target.id}`);
      if(remote.guild_id!==guild || ![0,5,15].includes(remote.type))throw new AppError(400,'同じサーバーのテキスト・アナウンス・フォーラムを指定してください。');
      channels.push(remote);
    }
    const busy=await env.DB.prepare("SELECT id FROM cloud_tasks WHERE guild=? AND status IN ('pending','running') LIMIT 1").bind(guild).first();
    if(busy)throw new AppError(409,'進行中のジョブが完了してから設定を変更してください。');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO cloud_guilds(guild,bot_id,config,started) VALUES(?,?,?,?) ON CONFLICT(guild) DO UPDATE SET bot_id=excluded.bot_id,config=excluded.config').bind(guild,id(bot.id),JSON.stringify(cfg),Date.now()),
      ...channels.map(channel=>env.DB.prepare('INSERT INTO cloud_channels(guild,channel,name,kind,department) VALUES(?,?,?,?,?) ON CONFLICT(guild,channel) DO UPDATE SET name=excluded.name,department=excluded.department').bind(guild,channel.id,channel.name,channel.type,cfg.channels.find(c=>c.id===channel.id)?.department??null)),
    ]);
    return Response.json({configured:true,guild,...cfg});
  }
  if(path==='/status' && request.method==='GET')return Response.json(await status(env,guild));
  if(path==='/backfill' && request.method==='POST'){
    const body=await jsonBody(request),days=body.days;
    if(typeof days!=='number'||!Number.isInteger(days)||days<1||days>3650)throw new AppError(400,'daysは1〜3650の整数です。');
    return Response.json({accepted:true,tasks:await startScans(env,guild,days)},{status:202});
  }
  if(path==='/scan' && request.method==='POST')return Response.json({accepted:true,tasks:await startScans(env,guild)},{status:202});
  if(path==='/retry-attachments' && request.method==='POST'){
    await ensureRecovery(env,guild);
    await env.DB.batch([
      env.DB.prepare("UPDATE cloud_tasks SET status='pending',failures=0,due=0 WHERE guild=? AND kind='attachment' AND status='failed'").bind(guild),
      env.DB.prepare("UPDATE cloud_attachments SET status='pending',reason=NULL,retry_start=attempts WHERE guild=? AND status='failed'").bind(guild),
    ]);
    await dispatch(env);return Response.json({accepted:true},{status:202});
  }
  if(path==='/exports' && request.method==='POST'){
    const body=await jsonBody(request);bounds(body.from,body.to);
    await status(env,guild);
    await ensureRecovery(env,guild);
    const exportId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO cloud_exports(id,guild,from_date,to_date,created) VALUES(?,?,?,?,?)').bind(exportId,guild,body.from,body.to,Date.now()),
      env.DB.prepare('INSERT INTO cloud_tasks(id,guild,kind,payload,created,updated) VALUES(?,?,?,?,?,?)').bind(exportId,guild,'export',JSON.stringify({from:body.from,to:body.to,part:0}),Date.now(),Date.now()),
    ]);
    await publish(env,exportId);
    return Response.json({id:exportId,status:'pending'},{status:202});
  }
  const exported=path.match(/^\/exports\/([a-f0-9-]{36})(?:\/parts\/(\d+))?$/);
  if(exported && request.method==='GET'){
    const row=await env.DB.prepare('SELECT * FROM cloud_exports WHERE id=? AND guild=?').bind(exported[1],guild).first<{status:string}>();
    if(!row)throw new AppError(404,'出力が見つかりません。');
    if(exported[2]===undefined)return Response.json(row);
    if(row.status!=='complete')throw new AppError(409,'出力はまだ完成していません。');
    const part=await env.DB.prepare('SELECT storage_key FROM cloud_export_parts WHERE export_id=? AND part=?').bind(exported[1],Number(exported[2])).first<{storage_key:string}>();
    if(!part)throw new AppError(404,'出力パートが見つかりません。');
    const object=await env.MEDIA.get(part.storage_key);if(!object)throw new AppError(404,'出力オブジェクトが見つかりません。');
    return new Response(object.body,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Content-Disposition':`attachment; filename="telemetry_${exported[1]}_${exported[2]}.jsonl"`}});
  }
  const media=path.match(/^\/attachments\/(\d{17,20})$/);
  if(media && request.method==='GET'){
    const row=await env.DB.prepare("SELECT storage_key FROM cloud_attachments WHERE guild=? AND id=? AND status='saved'").bind(guild,media[1]).first<{storage_key:string}>();
    if(!row)throw new AppError(404,'添付が見つかりません。');
    const object=await env.MEDIA.get(row.storage_key);if(!object)throw new AppError(404,'添付オブジェクトが見つかりません。');
    return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${media[1]}"`}});
  }
  throw new AppError(404,'Telemetry endpoint not found.');
}
