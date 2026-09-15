import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions, Response as MockResponse } from 'miniflare';
import { hash } from '../src/crypto';
import { commonSlot, windowStart, DAY, SLOT, type PollState } from '../src/meeting-poll-model';
import { discordCommands } from '../src/discord-commands';
const guild='456789012345678901', owner='234567890123456789', guest='234567890123456780', outsider='234567890123456781';
const origin='http://localhost:8787';
let mf:Miniflare, serial=100n, notifications:any[]=[];
const tokens:Record<string,string>={[owner]:'owner-session',[guest]:'guest-session',[outsider]:'outsider-session'};
async function create(){
  const id=(150000000000000000n+serial++).toString();
  const input={id,guild,user:owner,channel:'567890123456789012',document:'document_123456789',created:Date.now()};
  await (await mf.getD1Database('DB')).prepare('INSERT INTO meeting_polls(id,guild,user,created) VALUES(?,?,?,?)').bind(id,guild,owner,input.created).run();
  assert.equal((await mf.dispatchFetch(origin+'/test/poll',{method:'POST',body:JSON.stringify({input})})).status,200);
  return id;
}
async function call(id:string,path:string,user=owner,body?:unknown,extra:Record<string,string>={}){
  return mf.dispatchFetch(`${origin}/mtg/polls/${id}/${path}`,{method:body===undefined?'GET':'POST',headers:{Cookie:`mtg_session=${tokens[user]??''}`,Origin:origin,'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function configure(id:string){const r=await call(id,'configure',owner,{members:[guest],duration:60,title:'Weekly <script>'});assert.equal(r.status,200,await r.clone().text());return r.json() as Promise<any>}
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({name:'poll-test',modules:true,scriptPath:'.test-dist/cloud-harness.js',compatibilityDate:'2026-09-15',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],r2Buckets:['MEDIA'],queueProducers:{DISCORD_JOBS:'docs',COLLECTION_JOBS:'collection'},
    durableObjects:{MEETING_POLLS:{className:'MeetingPoll',useSQLite:true},MEETINGS:{className:'TestMeetingScheduler',useSQLite:true},COLLECTION_RECOVERY:{className:'CollectionRecovery',useSQLite:true}},
    bindings:{APP_ORIGIN:origin,DISCORD_CLIENT_SECRET:'fake-secret',DISCORD_APPLICATION_ID:'123456789012345678',DISCORD_BOT_TOKEN:'fake-bot',COLLECTION_MODE:'cloud'},
    outboundService:async request=>{
      const u=new URL(request.url);
      assert.equal(u.hostname,'discord.com');
      if(u.pathname==='/api/oauth2/token'){
        const form=new URLSearchParams(await request.text());assert.equal(form.get('client_secret'),'fake-secret');assert.equal(form.get('redirect_uri'),origin+'/mtg/login/callback');
        return MockResponse.json({access_token:'fake-access',scope:'identify'});
      }
      if(u.pathname==='/api/v10/users/@me'){assert.equal(request.headers.get('Authorization'),'Bearer fake-access');return MockResponse.json({id:guest,username:'Guest'});}
      if(u.pathname===`/api/v10/guilds/${guild}`)return MockResponse.json({owner_id:owner});
      if(u.pathname.startsWith(`/api/v10/guilds/${guild}/members/`)){
        const id=u.pathname.split('/').at(-1)!;
        return Object.hasOwn(tokens,id)?MockResponse.json({user:{id,username:id===owner?'Host':'Member'},roles:[]}):MockResponse.json({code:10007},{status:404});
      }
      if(request.method==='POST'){notifications.push(await request.json());return MockResponse.json({id:'987654321012345678'});}
      if(u.pathname==='/api/v10/channels/567890123456789012')return MockResponse.json({guild_id:guild});
      assert.fail(u.pathname);
    },
  }));
  const db=await mf.getD1Database('DB');
  for(const f of (await readdir('migrations')).sort())for(const sql of (await readFile(`migrations/${f}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  for(const [user,token]of Object.entries(tokens))await db.prepare('INSERT INTO meeting_sessions(token_hash,user,name,expires) VALUES(?,?,?,?)').bind(await hash(token),user,'Member',Date.now()+DAY).run();
});
after(async()=>{await mf?.dispose()});
test('no schedule arguments and five JST days centered on seven days from now',()=>{
  const command=discordCommands.find(c=>c.name==='mtg')!.options!.find(c=>c.name==='schedule')!;
  assert.equal('options' in command,false);
  assert.equal(windowStart(Date.parse('2026-09-14T16:00:00Z')),Date.parse('2026-09-20T00:00:00+09:00'));
});
test('overlap waits for everyone, requires contiguous slots, prefers middle day and never crosses midnight',()=>{
  const p={start:windowStart(Date.now()),duration:60,members:[{id:owner,name:'Host'},{id:guest,name:'Guest'}],answers:{[owner]:[0,1,96,97]}} as unknown as PollState;
  assert.equal(commonSlot(p,Date.now()),undefined);
  p.answers[guest]=[0,1,96,97];assert.equal(commonSlot(p,Date.now()),p.start+96*SLOT);
  p.answers[owner]=p.answers[guest]=[47,48];assert.equal(commonSlot(p,Date.now()),undefined);
  p.answers[owner]=p.answers[guest]=[96,98];assert.equal(commonSlot(p,Date.now()),undefined);
  p.answers[owner]=p.answers[guest]=[];assert.equal(commonSlot(p,Date.now()),undefined);
});
test('login page exposes no data; authentication, CSRF, guild and participant scope are enforced',async()=>{
  const id=await create();
  const page=await mf.dispatchFetch(origin+'/mtg/polls/'+id);assert.equal(page.status,200);assert.match(page.headers.get('Content-Security-Policy')!,/nonce-/);assert.ok(!(await page.text()).includes('Weekly <script>'));
  assert.equal((await call(id,'data','unknown')).status,401);
  assert.equal((await call(id,'data',outsider)).status,403);
  assert.equal((await call(id,'configure',guest,{members:[owner],duration:60,title:'spoof'})).status,403);
  assert.equal((await call(id,'configure',owner,{members:[guest],duration:60,title:'spoof'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await call(id,'configure',owner,{members:['999999999999999999'],duration:60,title:'bad member'})).status,403);
  await configure(id);
  assert.equal((await call(id,'answer',outsider,{slots:[0,1]})).status,403);
  assert.equal((await call(id,'answer',guest,{slots:[-1]})).status,400);
  assert.equal((await call(id,'answer',guest,{slots:[0.5]})).status,400);
  assert.equal((await call(id,'configure',owner,{members:[outsider],duration:60,title:'change'})).status,409);
  assert.equal((await call(id,'cancel',guest,{})).status,403);
});
test('OAuth state is cookie-bound and single use; sessions store hashes and logout revokes',async()=>{
  const id=await create();await configure(id);
  const start=await mf.dispatchFetch(`${origin}/mtg/login?poll=${id}`,{redirect:'manual'});assert.equal(start.status,302);
  const url=new URL(start.headers.get('Location')!),state=url.searchParams.get('state')!,cookie=start.headers.get('Set-Cookie')!.split(';')[0];
  assert.equal(url.searchParams.get('scope'),'identify');
  const callback=`${origin}/mtg/login/callback?state=${state}&code=test-code`;
  assert.equal((await mf.dispatchFetch(callback,{redirect:'manual'})).status,400);
  const ok=await mf.dispatchFetch(callback,{headers:{Cookie:cookie},redirect:'manual'});assert.equal(ok.status,303);
  assert.equal((await mf.dispatchFetch(callback,{headers:{Cookie:cookie},redirect:'manual'})).status,400);
  const cookies=ok.headers.getSetCookie();const auth=cookies.find(c=>c.startsWith('mtg_session='))!.split(';')[0];
  assert.ok(cookies.every(c=>c.includes('HttpOnly')&&c.includes('SameSite=Lax')));
  const rows=await(await mf.getD1Database('DB')).prepare('SELECT token_hash FROM meeting_sessions').all();assert.ok(rows.results.every((r:any)=>r.token_hash!==auth.split('=')[1]));
  assert.equal((await mf.dispatchFetch(`${origin}/mtg/polls/${id}/data`,{headers:{Cookie:auth}})).status,200);
  assert.equal((await mf.dispatchFetch(`${origin}/mtg/logout`,{method:'POST',headers:{Cookie:auth,Origin:origin}})).status,200);
  assert.equal((await mf.dispatchFetch(`${origin}/mtg/polls/${id}/data`,{headers:{Cookie:auth}})).status,401);
});
test('empty answers remain open and are editable; simultaneous overlap books once and freezes answers',async()=>{
  const id=await create();await configure(id);
  await call(id,'answer',owner,{slots:[]});await call(id,'answer',guest,{slots:[114,115]});
  assert.equal((await(await call(id,'data')).json() as any).status,'open');
  const results=await Promise.all([call(id,'answer',owner,{slots:[114,115],user:guest}),call(id,'answer',owner,{slots:[114,115]})]);
  assert.ok(results.some(r=>r.status===200));
  let data:any;
  for(let i=0;i<150;i++){data=await(await call(id,'data')).json();if(data.status==='confirmed')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(data.status,'confirmed');assert.equal(data.meetingAt,data.start+114*SLOT);
  assert.equal((await call(id,'answer',guest,{slots:[]})).status,409);
  const db=await mf.getD1Database('DB');const row=await db.prepare('SELECT * FROM meeting_reservations WHERE id=?').bind(id).first<any>();
  assert.equal(row.meeting_at,data.meetingAt);assert.equal(row.run_at,data.meetingAt-3600_000);
  const status=await mf.dispatchFetch(origin+'/test/meeting/summary',{method:'POST',body:JSON.stringify({id,guild})});assert.equal((await status.json() as any).status,'scheduled');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM meeting_reservations WHERE id=?').bind(id).first<any>()).n,1);
});
test('owner cancellation prevents further answers and no reservation is created',async()=>{
  const id=await create();await configure(id);
  assert.equal((await call(id,'cancel',owner,{})).status,200);
  assert.equal((await call(id,'answer',guest,{slots:[114,115]})).status,409);
  assert.equal(await(await mf.getD1Database('DB')).prepare('SELECT id FROM meeting_reservations WHERE id=?').bind(id).first(),null);
});
