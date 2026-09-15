import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { Miniflare,convertV4MiniflareOptions,Response as MockResponse } from 'miniflare';
import { config,bounds,iso,snowflake,type RemoteMessage,type Task } from '../src/cloud/model';
import { mediaUrl } from '../src/cloud/media';
const guild='456789012345678901',channel='567890123456789012',bot='123456789012345678',author='234567890123456789';
const key='cloud-test-key-with-at-least-32-characters';
let mf:Miniflare;
let messages:RemoteMessage[]=[];
let statusCode=200,errorCode=0,rateLimit=false;
let archivePages:{threads:unknown[];has_more:boolean}[]=[];
let archiveQueries:string[]=[];
let cdnStatus=200,cdnBytes=8;
let beforeCdn:(()=>Promise<void>)|undefined;
let beforeHistory:(()=>Promise<void>)|undefined;
let lastTask=0;
const now=Date.now();
function message(index:number,overrides:Partial<RemoteMessage>={}):RemoteMessage {
  const timestamp=now-1000*(index+1);
  return {id:(BigInt(snowflake(timestamp))+1n).toString(),channel_id:channel,content:`投稿${index}`,timestamp:new Date(timestamp).toISOString(),edited_timestamp:null,author:{id:author,username:'tester'},attachments:[],...overrides};
}
const request=(path:string,method='GET',body?:unknown)=>mf.dispatchFetch(`http://localhost:8787${path}`,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const api=(path:string,method='GET',body?:unknown)=>request(`/api/telemetry${path}?guild=${guild}`,method,body);
async function harness(path:string,body:unknown){const r=await request(`/test/${path}`,'POST',body);assert.equal(r.status,200,await r.clone().text());return r.json();}
async function db(){return mf.getD1Database('DB');}
async function newTask(kind='scan',payload:unknown={start:now-86400_000,end:now+1,before:snowflake(now+1),backfill:false},taskChannel:string|null=channel){
  const id=`task-${++lastTask}`;
  await (await db()).prepare('INSERT INTO cloud_tasks(id,guild,channel,kind,payload,created,updated) VALUES(?,?,?,?,?,?,?)').bind(id,guild,taskChannel,kind,JSON.stringify(payload),now,now).run();return id;
}
async function taskRow(id:string){return (await db()).prepare('SELECT * FROM cloud_tasks WHERE id=?').bind(id).first<Task&{status:string;error:string;due:number}>();}
async function run(id:string){await harness('run',{id});return taskRow(id);}
async function seed(m:RemoteMessage){
  const id=await newTask();const task=await harness('claim',{id}) as Task;
  await harness('save',{task,message:m,observed:Date.now()});await (await db()).prepare("UPDATE cloud_tasks SET status='done' WHERE id=?").bind(id).run();return task;
}
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,scriptPath:'.test-dist/cloud-harness.js',compatibilityDate:'2026-09-15',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],r2Buckets:['MEDIA'],queueProducers:{COLLECTION_JOBS:'test-collection',DISCORD_JOBS:'test-docs'},
    bindings:{APP_ORIGIN:'http://localhost:8787',DEMO_API_KEY:key,DISCORD_BOT_TOKEN:'fake-bot',COLLECTION_MODE:'cloud'},
    outboundService:async request=>{
      const u=new URL(request.url);
      if(u.hostname==='cdn.discordapp.com'){
        if(beforeCdn){const callback=beforeCdn;beforeCdn=undefined;await callback();}
        return new MockResponse(new Uint8Array(cdnBytes),{status:cdnStatus,headers:{'Content-Type':'image/png'}});
      }
      assert.equal(request.headers.get('Authorization'),'Bot fake-bot');
      if(u.pathname.endsWith('/users/@me'))return MockResponse.json({id:bot});
      if(u.pathname===`/api/v10/channels/${channel}`)return MockResponse.json({id:channel,guild_id:guild,name:'開発',type:0});
      if(u.pathname.endsWith('/threads/active'))return MockResponse.json({threads:[],has_more:false});
      if(u.pathname.includes('/threads/archived/')){archiveQueries.push(u.search);return MockResponse.json(archivePages.shift()??{threads:[],has_more:false});}
      if(rateLimit){rateLimit=false;return MockResponse.json({retry_after:2},{status:429});}
      if(statusCode!==200)return MockResponse.json({code:errorCode},{status:statusCode});
      if(u.pathname.endsWith('/messages')){
        if(beforeHistory){const callback=beforeHistory;beforeHistory=undefined;await callback();}
        const before=u.searchParams.get('before');return MockResponse.json(messages.filter(m=>!before||BigInt(m.id)<BigInt(before)).sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1).slice(0,100));
      }
      const found=messages.find(m=>u.pathname.endsWith(`/messages/${m.id}`));
      return found?MockResponse.json(found):MockResponse.json({code:10008},{status:404});
    },
  }));
  const database=await db();
  for(const file of (await readdir('migrations')).sort())for(const sql of (await readFile(`migrations/${file}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await database.prepare(sql).run();
  const r=await api('/config','PUT',{channels:[{id:channel,department:'開発'}]});assert.equal(r.status,200,r.status===200?'':await(await request(`/test/config?guild=${guild}`,'PUT',{channels:[{id:channel,department:'開発'}]})).text());
  await database.prepare('UPDATE cloud_guilds SET started=?').bind(now-86400_000).run();
});
after(async()=>{await mf?.dispose();});
test('cloud validators: strict IDs, JST dates, microseconds, CDN host',()=>{
  assert.throws(()=>config({channels:[{id:123}]}));assert.throws(()=>config({channels:[{id:channel},{id:channel}]}));
  assert.throws(()=>bounds('2026-02-30','2026-03-01'));assert.throws(()=>bounds('2026-03-01','2026-03-01'));
  assert.equal(bounds('2026-09-14','2026-09-16')[0],'2026-09-13T15:00:00.000000+00:00');
  assert.equal(iso('2026-09-14T01:02:03.123456+09:00'),'2026-09-13T16:02:03.123456+00:00');
  for(const url of ['http://cdn.discordapp.com/attachments/a','https://evil.example/attachments/a','https://user@cdn.discordapp.com/attachments/a','https://cdn.discordapp.com:99/attachments/a'])assert.throws(()=>mediaUrl(url));
});
test('cloud API requires management key and guild scoping',async()=>{
  assert.equal((await mf.dispatchFetch(`http://localhost:8787/api/telemetry/status?guild=${guild}`)).status,401);
  assert.equal((await request('/api/telemetry/status?guild=1')).status,400);
  assert.equal((await request('/api/telemetry/status?guild=999999999999999999')).status,404);
  const result=await api('/status');assert.equal(result.status,200);assert.equal(result.headers.get('Cache-Control'),'no-store');
});
test('pages persist before cursor advancement; duplicate deliveries and own bot are ignored',async()=>{
  messages=Array.from({length:105},(_,i)=>message(i));messages.push(message(200,{author:{id:bot,username:'self',bot:true}}));
  const id=await newTask();const first=await run(id);assert.equal(first!.status,'pending');
  assert.equal((await(await db()).prepare('SELECT COUNT(*) AS n FROM cloud_messages').first<{n:number}>())!.n,100);
  const second=await run(id);assert.equal(second!.status,'done');await run(id);
  assert.equal((await(await db()).prepare('SELECT COUNT(*) AS n FROM cloud_messages').first<{n:number}>())!.n,105);
  const cursor=await(await db()).prepare('SELECT scanned_until FROM cloud_channels WHERE channel=?').bind(channel).first<{scanned_until:number}>();assert.equal(cursor!.scanned_until,now+1);
});
test('atomic lease takeover fences stale writers and preserves newer microsecond edits',async()=>{
  const database=await db(),id=await newTask();
  const claims=await Promise.all([harness('claim',{id}),harness('claim',{id})]);assert.equal(claims.filter(Boolean).length,1);const stale=claims.find(Boolean) as Task;
  await database.prepare('UPDATE cloud_tasks SET lease_until=0 WHERE id=?').bind(id).run();const current=await harness('claim',{id}) as Task;assert.equal(current.generation,stale.generation+1);
  const revisionBase=new Date(now+60_000).toISOString().slice(0,19);
  const m=message(0,{content:'最新',edited_timestamp:`${revisionBase}.123456Z`});
  await harness('save',{task:current,message:m,observed:now+10});
  await harness('save',{task:stale,message:{...m,content:'古い世代',edited_timestamp:new Date(now+120_000).toISOString()},observed:now+20});
  await harness('save',{task:current,message:{...m,content:'古い編集',edited_timestamp:`${revisionBase}.123455Z`},observed:now+30});
  const row=await database.prepare('SELECT data FROM cloud_messages WHERE id=?').bind(m.id).first<{data:string}>();assert.equal(JSON.parse(row!.data).content,'最新');
  await database.prepare("UPDATE cloud_tasks SET status='done' WHERE id=?").bind(id).run();
});
test('429 preserves page and persists delayed retry without counting a failure',async()=>{
  rateLimit=true;const id=await newTask();const row=await run(id);assert.equal(row!.status,'pending');assert.equal(row!.failures,0);assert.ok(row!.due>Date.now());assert.equal(JSON.parse(row!.payload).before,snowflake(now+1));
  await(await db()).prepare("UPDATE cloud_tasks SET status='done' WHERE id=?").bind(id).run();
});
test('403 is not deletion; Unknown Message leaves an irreversible tombstone',async()=>{
  const m=message(0);const database=await db();await database.prepare('UPDATE cloud_messages SET verified=? WHERE id<>?').bind(Date.now()+10000,m.id).run();
  statusCode=403;errorCode=50001;
  const first=await newTask('verify',{start:iso(now-86400_000),cutoff:Date.now()+1});await run(first);
  assert.equal((await database.prepare('SELECT deleted FROM cloud_messages WHERE id=?').bind(m.id).first<{deleted:number}>())!.deleted,0);
  await database.prepare("UPDATE cloud_tasks SET status='done' WHERE id=?").bind(first).run();
  statusCode=404;errorCode=10008;const second=await newTask('verify',{start:iso(now-86400_000),cutoff:Date.now()+1});assert.equal((await run(second))!.status,'done');
  statusCode=200;errorCode=0;
  await seed({...m,content:'復活してはいけない',edited_timestamp:'2027-01-01T00:00:00Z'});
  const row=await database.prepare('SELECT deleted,data FROM cloud_messages WHERE id=?').bind(m.id).first<{deleted:number;data:string}>();assert.equal(row!.deleted,1);assert.equal(JSON.parse(row!.data).content,undefined);
});
test('archive pagination uses public timestamps and private snowflakes',async()=>{
  const t1='678901234567890123',t2='789012345678901234';archiveQueries=[];
  archivePages=[{threads:[{id:t1,parent_id:channel,name:'thread',type:11,thread_metadata:{archive_timestamp:'2026-09-01T00:00:00Z'}}],has_more:true},{threads:[],has_more:false},{threads:[{id:t2,parent_id:channel,name:'private',type:12}],has_more:true},{threads:[],has_more:false}];
  const id=await newTask('discover',{stage:'public',start:now-86400_000,end:now,backfill:true});
  for(let i=0;i<4;i++)await run(id);
  assert.equal((await taskRow(id))!.status,'done');assert.match(decodeURIComponent(archiveQueries[1]),/before=2026-09-01/);assert.match(archiveQueries[3],new RegExp(`before=${t2}`));
  const rows=(await(await db()).prepare("SELECT payload FROM cloud_tasks WHERE id LIKE ?").bind(`${id}:thread:%`).all<{payload:string}>()).results;assert.equal(rows.length,2);assert.equal(JSON.parse(rows[0].payload).backfill,true);
  await(await db()).prepare("UPDATE cloud_tasks SET status='done' WHERE id LIKE ?").bind(`${id}:thread:%`).run();
});
test('R2 media saves privately, enforces streamed size and survives a concurrent deletion',async()=>{
  const database=await db(),attachmentId='890123456789012345';
  const m=message(300,{attachments:[{id:attachmentId,filename:'image.png',content_type:'image/png',size:8,url:'https://cdn.discordapp.com/attachments/test/image.png'}]});
  await seed(m);messages=[m];
  const a=await database.prepare('SELECT version FROM cloud_attachments WHERE id=?').bind(attachmentId).first<{version:string}>();
  const taskId=await newTask('attachment',{id:attachmentId,version:a!.version});assert.equal((await run(taskId))!.status,'done');
  const saved=await database.prepare('SELECT status,storage_key FROM cloud_attachments WHERE id=?').bind(attachmentId).first<{status:string;storage_key:string}>();assert.equal(saved!.status,'saved');assert.ok(await harness('head',{key:saved!.storage_key}));assert.equal((await api(`/attachments/${attachmentId}`)).status,200);
  const tooLarge='890123456789012346';await seed({...m,id:message(301).id,attachments:[{...m.attachments[0],id:tooLarge}]});
  await database.prepare("UPDATE cloud_guilds SET config=json_set(config,'$.max_attachment_mib',1)").run();cdnBytes=1024**2+1;
  const largeVersion=await database.prepare('SELECT version FROM cloud_attachments WHERE id=?').bind(tooLarge).first<{version:string}>();await run(await newTask('attachment',{id:tooLarge,version:largeVersion!.version}));
  assert.equal((await database.prepare('SELECT status FROM cloud_attachments WHERE id=?').bind(tooLarge).first<{status:string}>())!.status,'too_large');cdnBytes=8;
  const raceId='890123456789012347',race={...m,id:message(302).id,attachments:[{...m.attachments[0],id:raceId}]};await seed(race);
  beforeCdn=async()=>{
    const deleteId=await newTask('verify');const task=await harness('claim',{id:deleteId});await harness('delete',{task,messageId:race.id,created:iso(race.timestamp)});await database.prepare("UPDATE cloud_tasks SET status='done' WHERE id=?").bind(deleteId).run();
  };
  const raceVersion=await database.prepare('SELECT version FROM cloud_attachments WHERE id=?').bind(raceId).first<{version:string}>();await run(await newTask('attachment',{id:raceId,version:raceVersion!.version}));
  assert.equal(await database.prepare('SELECT id FROM cloud_attachments WHERE id=?').bind(raceId).first(),null);
  await database.prepare('UPDATE cloud_cleanup SET due=0').run();await harness('cleanup',{});
  const objects=await harness('objects',{}) as {objects:{key:string}[]};assert.ok(!objects.objects.some(o=>o.key.includes(raceId)));
});
test('exports publish only complete parts, use schema v2 and authenticate guild access',async()=>{
  const result=await api('/exports','POST',{from:'2026-01-01',to:'2027-01-01'});assert.equal(result.status,202);const {id}=await result.json() as {id:string};
  assert.equal((await api(`/exports/${id}/parts/0`)).status,409);
  for(let i=0;i<10;i++){const row=await run(id);if(row!.status==='done')break;}
  const state=await(await api(`/exports/${id}`)).json() as {status:string;parts:number;records:number};assert.equal(state.status,'complete');assert.ok(state.parts>=3);
  let text='';for(let part=0;part<state.parts;part++)text+=await(await api(`/exports/${id}/parts/${part}`)).text();
  const records=text.trim().split('\n').map(v=>JSON.parse(v));assert.equal(records.length,state.records);assert.equal(new Set(records.map(r=>r.message_id)).size,records.length);
  assert.ok(records.every(r=>r.schema_version===2&&Array.isArray(r.attachments)));assert.ok(records.filter(r=>r.deleted).every(r=>r.content===undefined));
  assert.equal((await request(`/api/telemetry/exports/${id}/parts/0?guild=999999999999999999`)).status,404);
  const before=state.records;await run(id);assert.equal((await(await api(`/exports/${id}`)).json() as {records:number}).records,before);
});
test('real Queue delivery completes backfill and JSONL without a resident collector',async()=>{
  const queued=new Miniflare(convertV4MiniflareOptions({
    modules:true,scriptPath:'dist/index.js',compatibilityDate:'2026-09-15',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],r2Buckets:['MEDIA'],queueProducers:{COLLECTION_JOBS:'live-collection',DISCORD_JOBS:'live-docs'},
    queueConsumers:{'live-collection':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:2}},
    bindings:{APP_ORIGIN:'http://localhost:8787',DEMO_API_KEY:key,DISCORD_BOT_TOKEN:'fake-bot',COLLECTION_MODE:'cloud'},
    outboundService:async request=>{
      const u=new URL(request.url);
      if(u.pathname.endsWith('/users/@me'))return MockResponse.json({id:bot});
      if(u.pathname===`/api/v10/channels/${channel}`)return MockResponse.json({id:channel,guild_id:guild,name:'開発',type:0});
      if(u.pathname.includes('/threads/'))return MockResponse.json({threads:[],has_more:false});
      if(u.pathname.endsWith('/messages'))return MockResponse.json([message(5)]);
      throw new Error('UnexpectedMockRequest');
    },
  }));
  try {
    const database=await queued.getD1Database('DB');
    for(const file of (await readdir('migrations')).sort())for(const sql of (await readFile(`migrations/${file}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await database.prepare(sql).run();
    const call=(path:string,method='GET',body?:unknown)=>queued.dispatchFetch(`http://localhost:8787/api/telemetry${path}?guild=${guild}`,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    assert.equal((await call('/config','PUT',{channels:[{id:channel}]})).status,200);
    const accepted=await call('/backfill','POST',{days:7});assert.equal(accepted.status,202);const body=await accepted.json() as {tasks:string[]};assert.ok(body.tasks.length);
    async function waitFor(check:()=>Promise<boolean>){const deadline=Date.now()+10000;while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Queue did not complete');}
    await waitFor(async()=>!(await database.prepare("SELECT id FROM cloud_tasks WHERE status<>'done' LIMIT 1").first()));
    const producer=await queued.getQueueProducer('COLLECTION_JOBS');await producer.send({kind:'collection',id:body.tasks.find(id=>id.includes(':scan:'))});
    assert.equal((await database.prepare('SELECT COUNT(*) AS n FROM cloud_messages').first<{n:number}>())!.n,1);
    const exportResponse=await call('/exports','POST',{from:'2026-01-01',to:'2027-01-01'});assert.equal(exportResponse.status,202);
    const exported=await exportResponse.json() as {id:string};
    await waitFor(async()=>(await database.prepare('SELECT status FROM cloud_exports WHERE id=?').bind(exported.id).first<{status:string}>())?.status==='complete');
    const file=await call(`/exports/${exported.id}/parts/0`);assert.equal(file.status,200);assert.equal(JSON.parse((await file.text()).trim()).content,'投稿5');
  }finally{await queued.dispose();}
});
test('backfill acceptance is atomic across concurrent calls and persists outbox for Cron recovery',async()=>{
  const database=await db();
  const results=await Promise.all([api('/backfill','POST',{days:7}),api('/backfill','POST',{days:30})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[202,409]);
  const accepted=await results.find(r=>r.status===202)!.json() as {tasks:string[]};assert.ok(accepted.tasks.length);
  const active=(await database.prepare("SELECT id,kind,status FROM cloud_tasks WHERE status IN ('pending','running')").all<{id:string;kind:string;status:string}>()).results;
  assert.ok(active.every((row:{id:string})=>accepted.tasks.includes(row.id)));
  const id=accepted.tasks.find(id=>id.includes(':scan:'))!;
  const original=await harness('claim',{id}) as Task;
  await database.prepare('UPDATE cloud_tasks SET lease_until=0 WHERE id=?').bind(id).run();
  await harness('dispatch',{});
  const resumed=await harness('claim',{id}) as Task;assert.equal(resumed.generation,original.generation+1);
  await database.prepare("UPDATE cloud_tasks SET status='done'").run();
});
test('attachment retries keep HTTP attempt history and manual retry grants a fresh budget',async()=>{
  const database=await db(),aid='901234567890123456';
  const m=message(400,{attachments:[{id:aid,filename:'retry.png',content_type:'image/png',size:8,url:'https://cdn.discordapp.com/attachments/test/retry.png'}]});
  await seed(m);
  const a=await database.prepare('SELECT version FROM cloud_attachments WHERE id=?').bind(aid).first<{version:string}>();
  const taskId=`attachment:${guild}:${aid}:${a!.version}`;
  await database.prepare('INSERT INTO cloud_tasks(id,guild,channel,kind,payload,created,updated) VALUES(?,?,?,?,?,?,?)').bind(taskId,guild,channel,'attachment',JSON.stringify({id:aid,version:a!.version}),Date.now(),Date.now()).run();
  await database.prepare('UPDATE cloud_attachments SET attempts=4 WHERE id=?').bind(aid).run();
  assert.equal((await run(taskId))!.status,'failed');
  assert.equal((await api('/retry-attachments','POST',{})).status,202);
  messages=[m];assert.equal((await run(taskId))!.status,'done');
  const row=await database.prepare('SELECT status,attempts,retry_start FROM cloud_attachments WHERE id=?').bind(aid).first<{status:string;attempts:number;retry_start:number}>();
  assert.equal(row!.status,'saved');assert.equal(row!.attempts,5);assert.equal(row!.retry_start,4);
});
test('newly discovered threads recover from guild start rather than only the overlap window',async()=>{
  const thread='678901234567890124';
  archivePages=[{threads:[{id:thread,parent_id:channel,name:'missed thread',type:11}],has_more:false}];
  const id=await newTask('discover',{stage:'public',start:now-1000,end:now,backfill:false});
  await run(id);
  const child=await(await db()).prepare('SELECT payload FROM cloud_tasks WHERE id=?').bind(`${id}:thread:${thread}`).first<{payload:string}>();
  assert.equal(JSON.parse(child!.payload).start,now-86400_000);
  await(await db()).prepare("UPDATE cloud_tasks SET status='done' WHERE id=? OR id=?").bind(id,`${id}:thread:${thread}`).run();
});
