import { AppError } from '../errors';
import { DiscordError } from './discord-rest';
import { attachment } from './media';
import { scan, discover, verify } from './collection';
import { exportPage } from './export';
import { claim, enqueue, fence, publish } from './store';
import type { QueueJob, Task } from './model';
import { ensureRecovery } from './recovery-wakeup';

export async function dispatch(env:Env,guild?:string):Promise<void> {
  const now=Date.now();
  const pending=(await env.DB.prepare("SELECT id FROM cloud_tasks WHERE (status='pending' OR (status='running' AND lease_until<=?)) AND due<=?"+(guild?' AND guild=?':'')+" ORDER BY updated LIMIT 100").bind(now,now,...(guild?[guild]:[])).all<{id:string}>()).results;
  if(pending.length)await env.COLLECTION_JOBS.sendBatch(pending.map(row=>({body:{kind:'collection',id:row.id}})));
  const media=(await env.DB.prepare("SELECT guild,id,channel,version FROM cloud_attachments WHERE status='pending'"+(guild?' AND guild=?':'')+" ORDER BY attempts,id LIMIT 50").bind(...(guild?[guild]:[])).all<{guild:string;id:string;channel:string;version:string}>()).results;
  for(const row of media)await enqueue(env,row.guild,row.channel,'attachment',{id:row.id,version:row.version},`attachment:${row.guild}:${row.id}:${row.version}`);
}
export async function consume(batch:MessageBatch<QueueJob>,env:Env):Promise<void> {
  for(const message of batch.messages){
    let task:Task|null=null;
    try {
      if(message.body.kind!=='collection' || typeof message.body.id!=='string'){message.ack();continue;}
      const owner=await env.DB.prepare('SELECT guild FROM cloud_tasks WHERE id=?').bind(message.body.id).first<{guild:string}>();
      if(owner)await ensureRecovery(env,owner.guild);
      task=await claim(env,message.body.id);
      if(!task){message.ack();continue;}
      if(task.kind==='scan')await scan(env,task);
      else if(task.kind==='discover')await discover(env,task);
      else if(task.kind==='verify')await verify(env,task);
      else if(task.kind==='attachment')await attachment(env,task);
      else if(task.kind==='export')await exportPage(env,task);
      else throw new Error('UnknownTask');
      message.ack();
    } catch(error){
      if(!task){message.retry({delaySeconds:30});continue;}
      const rate=error instanceof DiscordError && error.status===429;
      const failures=rate?task.failures:task.failures+1;
      const failed=failures>=(task.kind==='attachment'?4:6) || (error instanceof Error && error.message==='CdnAttemptsExhausted');
      const delay=rate?error.retryAfter:Math.min(300,5*2**failures);
      const safe=error instanceof AppError?error.message: error instanceof Error && /^[A-Za-z0-9]+$/.test(error.message)?error.message:'CollectionError';
      const extra=[];
      if(failed && task.kind==='attachment'){
        const p=JSON.parse(task.payload) as {id:string;version:string};
        extra.push(fence(env,task,"UPDATE cloud_attachments SET status='failed',reason=? WHERE guild=? AND id=? AND version=? AND status='pending' AND $FENCE",[safe,task.guild,p.id,p.version]));
      }
      if(failed && task.kind==='export')extra.push(fence(env,task,"UPDATE cloud_exports SET status='failed' WHERE id=? AND $FENCE",[task.id]));
      await env.DB.batch([...extra,fence(env,task,'UPDATE cloud_tasks SET status=?,failures=?,due=?,lease_until=0,error=?,updated=? WHERE id=? AND $FENCE',[failed?'failed':'pending',failures,Date.now()+delay*1000,safe,Date.now(),task.id])]);
      // Persist the retry first; the guild alarm recovers if this send fails.
      if(!failed)await publish(env,task.id,Math.min(43200,delay));
      message.ack();
    }
  }
}
