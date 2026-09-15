import { bounds, type Task } from './model';
import { exportRecord, fence, progress } from './store';
export async function exportPage(env:Env,task:Task):Promise<void> {
  const p=JSON.parse(task.payload) as {from:string;to:string;created?:string;id?:string;part:number};
  const [start,end]=bounds(p.from,p.to);
  const rows=(await env.DB.prepare('SELECT guild,id,created,data,deleted FROM cloud_messages WHERE guild=? AND created>=? AND created<? AND (created>? OR (created=? AND id>?)) ORDER BY created,id LIMIT 50').bind(task.guild,start,end,p.created??'',p.created??'',p.id??'').all<{guild:string;id:string;created:string;data:string;deleted:number}>()).results;
  const lines=[];
  for(const row of rows)lines.push(JSON.stringify(await exportRecord(env,row))+'\n');
  const key=`guild/${task.guild}/exports/${task.id}/${p.part}/${task.generation}.jsonl`;
  await env.DB.prepare('INSERT OR IGNORE INTO cloud_cleanup(storage_key,due) VALUES(?,?)').bind(key,Date.now()+600_000).run();
  await env.MEDIA.put(key,lines.join(''),{httpMetadata:{contentType:'application/x-ndjson; charset=utf-8'}});
  const done=rows.length<50;
  await progress(env,task,{...p,part:p.part+1,created:rows.at(-1)?.created??p.created,id:rows.at(-1)?.id??p.id},done,[
    fence(env,task,'INSERT INTO cloud_export_parts(export_id,part,storage_key,records) SELECT ?,?,?,? WHERE $FENCE ON CONFLICT(export_id,part) DO NOTHING',[task.id,p.part,key,rows.length]),
    fence(env,task,'DELETE FROM cloud_cleanup WHERE storage_key=? AND EXISTS(SELECT 1 FROM cloud_export_parts WHERE export_id=? AND part=? AND storage_key=?) AND $FENCE',[key,task.id,p.part,key]),
    fence(env,task,'UPDATE cloud_exports SET status=?,parts=?,records=records+? WHERE id=? AND $FENCE',[done?'complete':'running',p.part+1,rows.length,task.id]),
  ]);
}
