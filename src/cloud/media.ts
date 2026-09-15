import { AppError } from '../errors';
import { discord, DiscordError } from './discord-rest';
import { config, type Task, type RemoteMessage } from './model';
import { context, fence, progress, saveMessage, tombstone } from './store';

interface AttachmentRow { guild:string;id:string;message:string;channel:string;data:string;version:string;status:string;attempts:number;retry_start:number }
interface AttachmentData { attachment_id:string;filename:string;content_type:string|null;size:number;url:string }
export function mediaUrl(value: string): string {
  let url: URL; try { url=new URL(value); } catch { throw new AppError(400,'InvalidCdnUrl'); }
  if (url.protocol!=='https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname) || url.username || url.password || url.port || !url.pathname.startsWith('/attachments/') || /%2e|%2f|%5c/i.test(url.pathname)) throw new AppError(400,'InvalidCdnUrl');
  return url.href;
}
// Each upload holds at most one 5 MiB part. R2 multipart accepts bounded chunks even
// when the origin response does not have a known Content-Length.
export async function upload(env: Env,key:string,response:Response,maxBytes:number): Promise<void> {
  if (!response.body) throw new Error('EmptyMedia');
  const expected=response.headers.get('Content-Length');
  if (expected!==null && (!/^\d+$/.test(expected) || Number(expected)>maxBytes)) { await response.body.cancel(); throw new AppError(413,'MediaTooLarge'); }
  const multipart=await env.MEDIA.createMultipartUpload(key,{httpMetadata:{contentType:response.headers.get('Content-Type')??'application/octet-stream'}});
  const reader=response.body.getReader(), parts:R2UploadedPart[]=[];
  let buffer=new Uint8Array(5*1024**2), used=0, received=0;
  try {
    while(true) {
      const {done,value}=await reader.read(); if(done)break;
      received+=value.byteLength; if(received>maxBytes)throw new AppError(413,'MediaTooLarge');
      let offset=0;
      while(offset<value.byteLength) {
        const n=Math.min(buffer.byteLength-used,value.byteLength-offset); buffer.set(value.subarray(offset,offset+n),used); used+=n;offset+=n;
        if(used===buffer.byteLength) {parts.push(await multipart.uploadPart(parts.length+1,buffer));buffer=new Uint8Array(buffer.byteLength);used=0;}
      }
    }
    if(expected!==null && received!==Number(expected))throw new Error('IncompleteMedia');
    if(used)parts.push(await multipart.uploadPart(parts.length+1,buffer.subarray(0,used)));
    if(!parts.length)throw new Error('EmptyMedia');
    await multipart.complete(parts);
  } catch(error) { await reader.cancel().catch(()=>{});await multipart.abort().catch(()=>{});throw error; }
}
export async function attachment(env:Env,task:Task):Promise<void> {
  const p=JSON.parse(task.payload) as {id:string;version:string};
  const row=await env.DB.prepare('SELECT * FROM cloud_attachments WHERE guild=? AND id=? AND version=?').bind(task.guild,p.id,p.version).first<AttachmentRow>();
  if(!row || row.status!=='pending'){await progress(env,task,p,true);return;}
  const {guild,channel}=await context(env,task),cfg=config(JSON.parse(guild.config));
  let data=JSON.parse(row.data) as AttachmentData;
  const status=async(value:string,reason:string|null=null)=> {
    await progress(env,task,p,true,[fence(env,task,'UPDATE cloud_attachments SET status=?,reason=? WHERE guild=? AND id=? AND version=? AND $FENCE',[value,reason,task.guild,p.id,p.version])]);
  };
  if(row.attempts-row.retry_start>=4)throw new Error('CdnAttemptsExhausted');
  if(!data.content_type?.match(/^(image|video)\//)){await status('not_media');return;}
  if(data.size>cfg.max_attachment_mib*1024**2){await status('too_large');return;}
  const fetchMedia=async()=>{
    const url=mediaUrl(data.url);
    const attempt=await fence(env,task,'UPDATE cloud_attachments SET attempts=attempts+1 WHERE guild=? AND id=? AND version=? AND attempts<retry_start+4 AND $FENCE RETURNING attempts',[task.guild,p.id,p.version]).first();
    if(!attempt)throw new Error('CdnAttemptsExhausted');
    return fetch(url,{redirect:'manual',signal:AbortSignal.timeout(60_000)});
  };
  let response=await fetchMedia();
  if(response.status===403 || response.status===404){
    await response.body?.cancel();
    let message:RemoteMessage;
    try { message=await discord<RemoteMessage>(env,`/channels/${row.channel}/messages/${row.message}`); }
    catch(error){
      if(error instanceof DiscordError && error.httpStatus===404 && error.code===10008){
        const old=await env.DB.prepare('SELECT created FROM cloud_messages WHERE guild=? AND id=?').bind(task.guild,row.message).first<{created:string}>();
        if(old)await tombstone(env,task,channel,row.message,old.created);
        await progress(env,task,p,true);return;
      }
      throw error;
    }
    await saveMessage(env,task,channel,message,Date.now());
    const fresh=await env.DB.prepare('SELECT data FROM cloud_attachments WHERE guild=? AND id=? AND version=?').bind(task.guild,p.id,p.version).first<{data:string}>();
    if(!fresh){await progress(env,task,p,true);return;}
    data=JSON.parse(fresh.data);response=await fetchMedia();
  }
  if(!response.ok){await response.body?.cancel();throw new Error(`CdnHTTP${response.status}`);}
  const key=`guild/${task.guild}/messages/${row.message}/${row.id}/${task.id}/${task.generation}`;
  // Provisional cleanup survives process death. Grace exceeds the upload lease.
  await env.DB.prepare('INSERT OR IGNORE INTO cloud_cleanup(storage_key,due) VALUES(?,?)').bind(key,Date.now()+600_000).run();
  try {await upload(env,key,response,cfg.max_attachment_mib*1024**2);} catch(error){if(error instanceof AppError && error.status===413){await status('too_large');return;}throw error;}
  await env.DB.batch([
    fence(env,task,"UPDATE cloud_attachments SET status='saved',storage_key=?,reason=NULL WHERE guild=? AND id=? AND version=? AND status='pending' AND EXISTS(SELECT 1 FROM cloud_messages WHERE guild=? AND id=? AND deleted=0) AND $FENCE",[key,task.guild,p.id,p.version,task.guild,row.message]),
    fence(env,task,'DELETE FROM cloud_cleanup WHERE storage_key=? AND EXISTS(SELECT 1 FROM cloud_attachments WHERE guild=? AND id=? AND storage_key=?) AND $FENCE',[key,task.guild,p.id,key]),
  ]);
  await progress(env,task,p,true);
}
export async function cleanup(env:Env,guild?:string):Promise<void> {
  const rows=(await env.DB.prepare('SELECT storage_key FROM cloud_cleanup WHERE due<=?'+(guild?' AND storage_key LIKE ?':'')+' LIMIT 50').bind(Date.now(),...(guild?[`guild/${guild}/%`]:[])).all<{storage_key:string}>()).results;
  for(const row of rows){await env.MEDIA.delete(row.storage_key);await env.DB.prepare('DELETE FROM cloud_cleanup WHERE storage_key=? AND due<=?').bind(row.storage_key,Date.now()).run();}
}
