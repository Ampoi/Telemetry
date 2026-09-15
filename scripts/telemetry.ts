import { parseArgs } from 'node:util';
import { loadEnvFile } from 'node:process';
import { readFile, open, rename, unlink, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const help=`Telemetry Workers CLI
pnpm run telemetry configure --guild ID --config examples/cloud-config.json
pnpm run telemetry status --guild ID
pnpm run telemetry scan --guild ID
pnpm run telemetry backfill --guild ID --days 30
pnpm run telemetry retry-attachments --guild ID
pnpm run telemetry export --guild ID --from 2026-09-14 --to 2026-09-16 [--out exports]
pnpm run telemetry download --guild ID --id EXPORT_ID [--out exports]
--base-url https://your-worker.example （リモートではDEMO_API_KEYを環境変数に設定）
exportはジョブIDを表示して最大5分待機します。未完了ならdownloadで後から取得できます。`;
async function main(){
  const {values:v,positionals}=parseArgs({allowPositionals:true,options:{guild:{type:'string'},config:{type:'string'},days:{type:'string'},from:{type:'string'},to:{type:'string'},out:{type:'string'},id:{type:'string'},'base-url':{type:'string'},help:{type:'boolean'}}});
  const command=positionals[0];if(v.help||!command){console.log(help);return;}
  if(!['configure','status','scan','backfill','retry-attachments','export','download'].includes(command)||positionals.length!==1)throw new Error(help);
  if(!v.guild || !/^\d{17,20}$/.test(v.guild))throw new Error('--guildにDiscordサーバーIDを指定してください。');
  const base=new URL(v['base-url']??process.env.DEMO_BASE_URL??'http://localhost:8787');
  if(base.href!==`${base.origin}/` || (base.protocol!=='https:' && !(base.protocol==='http:'&&base.hostname==='localhost'&&base.port==='8787')))throw new Error('--base-urlはHTTPS originまたはhttp://localhost:8787です。');
  if(base.hostname==='localhost')try{loadEnvFile('.dev.vars');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const apiKey=process.env.DEMO_API_KEY;if(!apiKey)throw new Error('DEMO_API_KEYを設定してください。');
  async function request(path:string,method='GET',body?:unknown){
    const response=await fetch(new URL(`/api/telemetry${path}?guild=${v.guild}`,base),{method,headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(90_000)});
    if(!response.ok){const e=await response.json() as {error?:string};throw new Error(e.error??`HTTP ${response.status}`);}return response;
  }
  const api=async(path:string,method='GET',body?:unknown)=> (await request(path,method,body)).json();
  if(command==='configure'){if(!v.config)throw new Error('--configが必要です。');console.log(await api('/config','PUT',JSON.parse(await readFile(v.config,'utf8'))));return;}
  if(command==='status'){console.log(JSON.stringify(await api('/status'),null,2));return;}
  if(['scan','backfill','retry-attachments'].includes(command)){console.log(await api(`/${command}`,'POST',command==='backfill'?{days:Number(v.days)}:{}));return;}
  let exportId=v.id;
  if(command==='export'){
    const result=await api('/exports','POST',{from:v.from,to:v.to}) as {id:string};exportId=result.id;
    console.log(`出力ジョブ: ${exportId}`);
  }
  if(!exportId || !/^[a-f\d-]{36}$/.test(exportId))throw new Error('--idに出力ジョブIDを指定してください。');
  const deadline=Date.now()+300_000;
  let state:{status:string;parts:number;from_date:string;to_date:string};
  while(true){
    state=await api(`/exports/${exportId}`) as typeof state;
    if(state.status==='complete')break;
    if(state.status==='failed')throw new Error('出力が失敗しました。statusで詳細を確認してください。');
    if(Date.now()>=deadline){console.log(`処理継続中。pnpm run telemetry download --guild ${v.guild} --id ${exportId} で後から取得できます。`);return;}
    await sleep(2000);
  }
  const directory=resolve(v.out??'exports');await mkdir(directory,{recursive:true});
  const path=resolve(directory,`telemetry_${state.from_date}_${state.to_date}_${randomUUID()}.jsonl`),temporary=path+'.part';
  const file=await open(temporary,'wx',0o600);
  try{
    for(let part=0;part<state.parts;part++){
      const response=await request(`/exports/${exportId}/parts/${part}`);
      if(!response.body)throw new Error('EmptyExport');
      for await(const chunk of response.body){let offset=0;while(offset<chunk.length){const {bytesWritten}=await file.write(chunk,offset,chunk.length-offset);offset+=bytesWritten;}}
    }
    await file.sync();await file.close();await rename(temporary,path);
  }catch(error){await file.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw error;}
  console.log(path);
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Telemetry CLI failed');process.exitCode=1;});
