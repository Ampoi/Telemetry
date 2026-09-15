import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions, Response as MockResponse } from 'miniflare';
import { encrypt } from '../src/crypto';
import { docsText, jst, jstTime, splitText, type MeetingInput } from '../src/meeting-model';
import { snowflake, type RemoteMessage } from '../src/cloud/model';
import { DEBUG_WEEK, debugWindow, agendaTextRequests } from '../src/debug-agenda';

const guild = '456789012345678901', user = '234567890123456789', bot = '123456789012345678';
const root = '567890123456789012', forum = '567890123456789013', hidden = '567890123456789014';
const active = '678901234567890123', archived = '678901234567890124', privateThread = '678901234567890125';
const document = 'meeting_document_12345', key = Buffer.alloc(32, 2).toString('base64url');
const apiKey = 'meeting-test-api-key-32-characters-long';
const keys = generateKeyPairSync('ed25519');
let mf: Miniflare, sequence = 0n;
let cutoff: number, messages: RemoteMessage[], writes: {requests:Record<string,any>[]}[], replies: string[];
let historyPaths: string[], imageStatus: number, textStatus: number, addStatus: number, rateOnce: boolean, revoked: boolean, contentIntent: boolean;
let notifications: any[], notifyStatus: number, summaryStatus: number, summaryInputs: any[];
const newId = () => ((BigInt(Date.now() - 1420070400000) << 22n) + ++sequence).toString();
function message(channel: string, at: number, text: string, extra: Partial<RemoteMessage> = {}): RemoteMessage {
  return {id:(BigInt(snowflake(at)) + ++sequence).toString(),channel_id:channel,timestamp:new Date(at).toISOString(),edited_timestamp:null,content:text,author:{id:user,username:'tester'},attachments:[],...extra};
}
async function harness(action: string, id: string, extra: Record<string,unknown> = {}, targetGuild = guild) {
  const r = await mf.dispatchFetch(`http://localhost:8787/test/meeting/${action}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,guild:targetGuild,...extra})});
  assert.equal(r.status,200,await r.clone().text());return r.json() as Promise<any>;
}
async function book(title = '予約テスト') {
  const input: MeetingInput = {id:newId(),guild,user,runAt:Date.now()+3600_000,title,document};
  const status = await harness('book',input.id,{input});assert.equal(status.status,'scheduled');return input;
}
async function finish(id: string) {
  for(let i=0;i<100;i++){
    const s=await harness('step',id);
    if(['complete','failed','needs_review','cancelled','notification_failed','notification_review'].includes(s.status))return s;
  }
  assert.fail('Meeting did not complete');
}
function interaction(action: string, options: {name:string;type:number;value:string}[] = []) {
  return {id:newId(),type:2,application_id:bot,token:'test-reply',guild_id:guild,channel_id:root,member:{user:{id:user},permissions:'32'},data:{name:'mtg',options:[{name:action,type:1,options}]}};
}
async function signed(payload: unknown) {
  const body=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000));
  return mf.dispatchFetch('http://localhost:8787/discord/interactions',{method:'POST',headers:{'Content-Type':'application/json','X-Signature-Timestamp':timestamp,'X-Signature-Ed25519':sign(null,Buffer.from(timestamp+body),keys.privateKey).toString('hex')},body});
}
async function waitReply(n: number) {
  for(let i=0;i<100;i++){if(replies.length>n)return replies.at(-1)!;await new Promise(r=>setTimeout(r,10));}
  assert.fail('No deferred reply');
}
before(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({
    name:'meeting-test',modules:true,scriptPath:'.test-dist/cloud-harness.js',compatibilityDate:'2026-09-15',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],r2Buckets:['MEDIA'],queueProducers:{DISCORD_JOBS:'meeting-docs',COLLECTION_JOBS:'meeting-collection'},
    durableObjects:{MEETING_POLLS:{className:'MeetingPoll',useSQLite:true},MEETINGS:{className:'TestMeetingScheduler',useSQLite:true},COLLECTION_RECOVERY:{className:'CollectionRecovery',useSQLite:true}},
    bindings:{OPENAI_API_KEY:'fake-openai',MTG_SUMMARY_MODEL:'test-model',APP_ORIGIN:'http://localhost:8787',DEMO_API_KEY:apiKey,COLLECTION_MODE:'cloud',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-secret',TOKEN_ENCRYPTION_KEY:key,DISCORD_BOT_TOKEN:'fake-bot',DISCORD_APPLICATION_ID:bot,DISCORD_PUBLIC_KEY:Buffer.from(keys.publicKey.export({format:'jwk'}).x!,'base64url').toString('hex')},
    outboundService:async request=>{
      const u=new URL(request.url);
      if(u.hostname==='api.openai.com'){
        const input = await request.json() as any; summaryInputs.push(input);
        if (input.text.format.name === 'weekly_agenda') {
          const payload = JSON.parse(input.input[0].content[0].text);
          const first = payload.messages[0];
          const point = { text: '構造試験の結果を確認する。', sourceIds: [first.message_id], mediaIds: first.attachments.map((a:any) => a.attachment_id) };
          return summaryStatus === 200 ? MockResponse.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:[point],topics:[],discussions:[]})}]}]}) : MockResponse.json({error:{}},{status:summaryStatus});
        }
        return summaryStatus===200 ? MockResponse.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({lines:['進捗の確認 @everyone','課題の相談 @here','次の対応 <@123456789012345678>']})}]}]}) : MockResponse.json({error:{}},{status:summaryStatus});
      }
      if(u.hostname==='cdn.discordapp.com') return new MockResponse(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ2cAAAAASUVORK5CYII=','base64'),{headers:{'Content-Type':'image/png'}});
      if(u.hostname==='oauth2.googleapis.com')return MockResponse.json({access_token:'test-access',expires_in:3600});
      if(u.hostname==='docs.googleapis.com'){
        assert.equal(u.pathname,`/v1/documents/${document}:batchUpdate`);
        const body=await request.json() as {requests:Record<string,any>[]};writes.push(body);
        if(body.requests[0].addDocumentTab)return addStatus===200?MockResponse.json({replies:[{addDocumentTab:{tabProperties:{tabId:'t.meeting'}}}]}):MockResponse.json({error:{}},{status:addStatus});
        if(body.requests[0].insertInlineImage)return imageStatus===200?MockResponse.json({replies:[{}]}):MockResponse.json({error:{}},{status:imageStatus});
        return textStatus===200?MockResponse.json({replies:body.requests.map(()=>({}))}):MockResponse.json({error:{}},{status:textStatus});
      }
      assert.equal(u.hostname,'discord.com');
      if(request.method==='PATCH'){const body=await request.json() as {content:string;allowed_mentions:{parse:string[]}};assert.deepEqual(body.allowed_mentions,{parse:[]});replies.push(body.content);return MockResponse.json({id:'reply'});}
      assert.equal(request.headers.get('Authorization'),'Bot fake-bot');
      if(request.method==='POST') {
        assert.equal(u.pathname,`/api/v10/channels/${root}/messages`);
        notifications.push(await request.json());
        assert.ok(writes.some(w=>w.requests.some(r=>r.insertText)),'notify only after document writes');
        return notifyStatus===200 ? MockResponse.json({id:'123456789012345679',mention_everyone:true}) : MockResponse.json({retry_after:2},{status:notifyStatus});
      }
      if(u.pathname===`/api/v10/channels/${root}`)return MockResponse.json({id:root,guild_id:guild,type:0,name:'一般'});
      if(u.pathname==='/api/v10/applications/@me')return MockResponse.json({flags:contentIntent?1<<19:0});
      if(u.pathname===`/api/v10/guilds/${guild}`)return MockResponse.json({owner_id:revoked?'999999999999999999':user});
      if(u.pathname===`/api/v10/guilds/${guild}/members/${user}`)return MockResponse.json({roles:[]});
      if(u.pathname===`/api/v10/guilds/${guild}/roles`)return MockResponse.json([{id:guild,permissions:'0'}]);
      if(u.pathname===`/api/v10/guilds/${guild}/channels`)return MockResponse.json([{id:root,name:'一般',type:0,guild_id:guild},{id:forum,name:'フォーラム',type:15,guild_id:guild},{id:hidden,name:'非公開',type:0,guild_id:guild}]);
      if(u.pathname.includes(hidden))return MockResponse.json({code:50001},{status:403});
      historyPaths.push(u.pathname+u.search);
      if(rateOnce){rateOnce=false;return MockResponse.json({retry_after:3},{status:429});}
      if(u.pathname.endsWith('/threads/active'))return MockResponse.json({threads:[{id:active,name:'進行中スレッド',parent_id:root,type:11}],has_more:false});
      if(u.pathname.endsWith('/threads/archived/public'))return MockResponse.json({threads:u.searchParams.has('before')?[]:[{id:archived,name:'過去スレッド',parent_id:forum,type:11,thread_metadata:{archive_timestamp:'2020-01-01T00:00:00Z'}}],has_more:!u.searchParams.has('before')});
      if(u.pathname.endsWith('/threads/archived/private'))return MockResponse.json({threads:u.searchParams.has('before')?[]:[{id:privateThread,name:'参加済み非公開',parent_id:root,type:12,thread_metadata:{archive_timestamp:'2020-01-01T00:00:00Z'}}],has_more:!u.searchParams.has('before')});
      const scan=u.pathname.match(/\/channels\/(\d+)\/messages$/);
      if(scan){const before=u.searchParams.get('before');return MockResponse.json(messages.filter(m=>m.channel_id===scan[1]&&(!before||BigInt(m.id)<BigInt(before))).sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1).slice(0,100));}
      const found=messages.find(m=>u.pathname===`/api/v10/channels/${m.channel_id}/messages/${m.id}`);
      return found?MockResponse.json(found):MockResponse.json({code:10008},{status:404});
    },
  }));
  const db=await mf.getD1Database('DB');
  for(const f of (await readdir('migrations')).sort())for(const sql of (await readFile(`migrations/${f}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  await db.prepare('INSERT INTO credentials(id,encrypted_refresh_token,connected_at) VALUES(?,?,?)').bind(`discord:guild:${guild}`,await encrypt('test-refresh',key,`discord:guild:${guild}`),Date.now()).run();
  await db.prepare('INSERT INTO discord_guild_settings(guild_id,document_id,updated_by,updated_at) VALUES(?,?,?,?)').bind(guild,document,user,Date.now()).run();
});
after(async()=>{await mf?.dispose();});
beforeEach(()=>{
  cutoff=Date.now()-1000;messages=[message(root,Date.parse('2020-01-01T00:00:00Z'),'6年以上前の投稿 {{raw}}\n# この記号を残す')];
  writes=[];replies=[];historyPaths=[];imageStatus=textStatus=addStatus=200;rateOnce=revoked=false;contentIntent=true;
  notifications=[];summaryInputs=[];notifyStatus=summaryStatus=200;
});

test('strict JST datetime, impossible dates, raw text and UTF-16 chunk boundaries',()=>{
  assert.equal(jstTime('2026-09-16 09:30'),Date.parse('2026-09-16T00:30:00Z'));
  for(const v of ['2026-02-30 12:00','2026-09-16 24:00','2026-09-16','2026-09-16 9:00'])assert.throws(()=>jstTime(v));
  const value='a'.repeat(11999)+'😀'+'b'.repeat(20000);const parts=splitText(value);assert.equal(parts.join(''),value);assert.ok(parts.every(p=>p.length<=12000));assert.ok(!/[\ud800-\udbff]$/.test(parts[0]));
  assert.equal(docsText('a\r\nb\u0000'),'a\nb�');
});
test('booking persists the exact alarm, survives eviction, and never runs early',async()=>{
  const input=await book();assert.equal(await harness('alarm',input.id),input.runAt);
  await mf.unsafeEvictDurableObject('meeting-test','TestMeetingScheduler',{name:`${guild}:${input.id}`});
  assert.equal((await harness('summary',input.id)).status,'scheduled');
  assert.equal((await harness('step',input.id)).status,'scheduled');assert.equal(historyPaths.length,0);assert.equal(writes.length,0);
  assert.equal((await harness('book',input.id,{input})).status,'scheduled');
  assert.equal((await harness('cancel',input.id)).status,'cancelled');assert.equal(await harness('alarm',input.id),null);
  assert.equal((await harness('book',input.id,{input})).status,'cancelled');assert.equal(await harness('alarm',input.id),null);
});
test('collects all old history, pages all thread kinds, orders >50k text and embeds images with video links in one tab',async()=>{
  const at=Date.parse('2020-01-02T00:00:00Z');
  messages=Array.from({length:101},(_,i)=>message(root,at+i*1000,`順序${String(i).padStart(3,'0')} ${'本文'.repeat(400)}`));
  messages.push(message(active,at-1000,'アクティブスレッド'),message(archived,at-2000,'公開アーカイブ'),message(privateThread,at-3000,'非公開アーカイブ'));
  messages.push(message(root,cutoff+60_000,'未来の投稿は除外'),message(root,at-4000,'自分のBotは除外',{author:{id:bot,username:'bot'}}));
  messages[0].attachments=[{id:'890123456789012345',filename:'photo.png',content_type:'image/png',size:100,url:'https://cdn.discordapp.com/attachments/a/photo.png'},{id:'890123456789012346',filename:'movie.mp4',content_type:'video/mp4',size:100,url:'https://cdn.discordapp.com/attachments/a/movie.mp4'}];
  const input=await book();await harness('due',input.id,{runAt:cutoff});const result=await finish(input.id);
  assert.equal(result.status,'complete');assert.equal(result.posts,104);assert.ok(result.skipped>0);
  assert.equal(writes.filter(w=>w.requests[0].addDocumentTab).length,1);
  const text=writes.flatMap(w=>w.requests.filter(r=>r.insertText).map(r=>r.insertText.text)).join('');
  assert.ok(text.length>50_000);assert.ok(text.indexOf('非公開アーカイブ')<text.indexOf('順序000'));assert.ok(text.indexOf('順序000')<text.indexOf('順序100'));
  assert.ok(!text.includes('未来の投稿は除外'));assert.ok(!text.includes('自分のBotは除外'));assert.match(text,/movie.mp4/);
  assert.equal(writes.filter(w=>w.requests[0].insertInlineImage).length,1);
  for(const w of writes)for(const r of w.requests){if(r.insertText)assert.equal(r.insertText.endOfSegmentLocation.tabId,'t.meeting');if(r.insertInlineImage)assert.equal(r.insertInlineImage.endOfSegmentLocation.tabId,'t.meeting');if(r.updateTextStyle)assert.equal(r.updateTextStyle.range.tabId,'t.meeting');}
  assert.ok(historyPaths.some(p=>p.includes('/archived/private?')&&p.includes(`before=${privateThread}`)));
  assert.ok(historyPaths.some(p=>p.includes('/archived/public?')&&p.includes('before=2020')));
  const count=writes.length;await harness('step',input.id);assert.equal(writes.length,count);
});
test('Discord rate limits retain progress; raw Markdown is not reinterpreted',async()=>{
  rateOnce=true;const input=await book();await harness('due',input.id,{runAt:cutoff});const first=await harness('step',input.id);assert.equal(first.status,'collecting');assert.equal(writes.length,0);
  const result=await finish(input.id);assert.equal(result.status,'complete');
  const text=writes.flatMap(w=>w.requests.filter(r=>r.insertText).map(r=>r.insertText.text)).join('');assert.match(text,/\{\{raw\}\}\n# この記号を残す/);
});
test('unsupported Google image request keeps links and completes without retrying the image',async()=>{
  imageStatus=400;messages[0].attachments=[{id:'890123456789012345',filename:'large.png',content_type:'image/png',size:100,url:'https://cdn.discordapp.com/attachments/a/large.png'}];
  const input=await book();await harness('due',input.id,{runAt:cutoff});const result=await finish(input.id);
  assert.equal(result.status,'complete');assert.equal(result.imageFallbacks,1);assert.equal(writes.filter(w=>w.requests[0].insertInlineImage).length,1);
});
test('uncertain Google content writes stop with the known tab URL and are never repeated',async()=>{
  textStatus=503;const input=await book();await harness('due',input.id,{runAt:cutoff});const result=await finish(input.id);
  assert.equal(result.status,'needs_review');assert.match(result.url,/tab=t.meeting/);
  const n=writes.length;await harness('step',input.id);assert.equal(writes.length,n);
});
test('uncertain tab creation never creates a second tab',async()=>{
  addStatus=503;const input=await book();await harness('due',input.id,{runAt:cutoff});assert.equal((await finish(input.id)).status,'needs_review');
  await harness('step',input.id);assert.equal(writes.length,1);
});
test('revoked manager permissions stop before collection or Google writes',async()=>{
  revoked=true;const input=await book();await harness('due',input.id,{runAt:cutoff});assert.equal((await finish(input.id)).status,'failed');assert.equal(writes.length,0);assert.equal(historyPaths.length,0);
});
test('missing Message Content Intent fails instead of silently creating an empty archive',async()=>{
  contentIntent=false;const input=await book();await harness('due',input.id,{runAt:cutoff});const result=await finish(input.id);assert.equal(result.status,'failed');assert.match(result.error,/Message Content Intent/);assert.equal(writes.length,0);
});
test('signed /mtg rejects DMs and non-managers, persists reservations, isolates guilds and cancels',async()=>{
  const payload=interaction('schedule');
  for(const p of [{...payload,guild_id:undefined},{...payload,member:{user:{id:user},permissions:'0'}}]){
    const r=await signed(p);const b=await r.json() as any;assert.equal(b.type,4);assert.match(b.data.content,/サーバー/);
  }
  const r=await signed(payload);assert.equal((await r.json() as any).type,5);
  assert.match(await waitReply(0),/日程調整を作成/);
  const input: MeetingInput = {id:payload.id,guild,user,runAt:Date.now()+3600_000,title:'テスト',document};
  await harness('book',payload.id,{input});
  await (await mf.getD1Database('DB')).prepare('INSERT INTO meeting_reservations(id,guild,user,run_at,title,document,created) VALUES(?,?,?,?,?,?,?)').bind(payload.id,guild,user,input.runAt,input.title,document,Date.now()).run();
  const row=await(await mf.getD1Database('DB')).prepare('SELECT guild,document FROM meeting_reservations WHERE id=?').bind(payload.id).first();assert.deepEqual(row,{guild,document});
  const n=replies.length;await signed({...interaction('status',[{name:'id',type:3,value:payload.id}]),guild_id:'999999999999999999'});assert.match(await waitReply(n),/見つかりません/);
  const n2=replies.length;await signed(interaction('cancel',[{name:'id',type:3,value:payload.id}]));assert.match(await waitReply(n2),/取消済み/);
});
test('no Cron schedules remain in production configuration',async()=>{
  const source=await readFile('wrangler.jsonc','utf8');assert.match(source,/"crons":\s*\[\]/);
});

async function notificationBooking() {
  const meetingAt=Date.now()+7200_000;
  const input: MeetingInput={id:newId(),guild,user,runAt:meetingAt-3600_000,meetingAt,channel:root,title:'定例 @everyone',document};
  await harness('book',input.id,{input});return input;
}
test('new meeting starts one hour before MTG and notifies once with three inert summary lines after Docs completion',async()=>{
  const input=await notificationBooking();
  assert.equal(await harness('alarm',input.id),input.meetingAt!-3600_000);
  assert.equal((await harness('step',input.id)).status,'scheduled');assert.equal(notifications.length,0);
  await harness('due',input.id,{runAt:cutoff});
  const result=await finish(input.id);assert.equal(result.status,'complete');
  assert.equal(notifications.length,1);const sent=notifications[0];
  assert.deepEqual(sent.allowed_mentions,{parse:['everyone']});assert.equal(sent.nonce,input.id);assert.equal(sent.enforce_nonce,true);
  assert.equal(sent.content.match(/@everyone/g).length,1);assert.ok(!sent.content.includes('@here'));
  assert.ok(sent.content.includes(jst(input.meetingAt!)));assert.ok(sent.content.includes(result.url));
  assert.equal(sent.content.split('\n').filter((x:string)=>x.startsWith('・')).length,3);assert.ok(sent.content.length<=2000);
  assert.ok(summaryInputs.length>0);assert.equal(summaryInputs[0].store,false);
  await harness('step',input.id);assert.equal(notifications.length,1);
});
test('empty history sends an honest three-line notice without calling AI',async()=>{
  messages=[];const input=await notificationBooking();await harness('due',input.id,{runAt:cutoff});
  assert.equal((await finish(input.id)).status,'complete');assert.equal(summaryInputs.length,0);assert.match(notifications[0].content,/議題を抽出できません/);
});
test('summary failure preserves the finished document and sends no everyone notification',async()=>{
  summaryStatus=401;const input=await notificationBooking();await harness('due',input.id,{runAt:cutoff});
  const result=await finish(input.id);assert.equal(result.status,'notification_failed');assert.ok(result.url);assert.equal(notifications.length,0);
  assert.equal(writes.filter(w=>w.requests[0].addDocumentTab).length,1);
});
test('uncertain notification stops without duplicate mentions or document recreation',async()=>{
  notifyStatus=503;const input=await notificationBooking();await harness('due',input.id,{runAt:cutoff});
  assert.equal((await finish(input.id)).status,'notification_review');assert.equal(notifications.length,1);
  await harness('step',input.id);assert.equal(notifications.length,1);assert.equal(writes.filter(w=>w.requests[0].addDocumentTab).length,1);
});
test('notification rate limit retries only the notification, while forbidden stops',async()=>{
  notifyStatus=429;const input=await notificationBooking();await harness('due',input.id,{runAt:cutoff});
  for(let i=0;i<100&&!notifications.length;i++)await harness('step',input.id);
  assert.equal(notifications.length,1);const count=writes.length;
  notifyStatus=200;assert.equal((await finish(input.id)).status,'complete');assert.equal(writes.length,count);
  notifyStatus=403;const other=await notificationBooking();await harness('due',other.id,{runAt:cutoff});
  assert.equal((await finish(other.id)).status,'notification_failed');const n=notifications.length;
  await harness('step',other.id);assert.equal(notifications.length,n);
});
test('signed poll creation is idempotent and legacy datetime arguments are rejected',async()=>{
  const payload=interaction('schedule');
  await signed(payload);assert.match(await waitReply(0),/日程調整を作成/);
  const db=await mf.getD1Database('DB');
  const row=await db.prepare('SELECT created FROM meeting_polls WHERE id=?').bind(payload.id).first<any>();
  const n=replies.length;await signed(payload);await waitReply(n);
  assert.equal((await db.prepare('SELECT created FROM meeting_polls WHERE id=?').bind(payload.id).first<any>()).created,row.created);
  assert.equal(await db.prepare('SELECT id FROM meeting_reservations WHERE id=?').bind(payload.id).first(),null);
  const n2=replies.length;await signed(interaction('schedule',[{name:'datetime',type:3,value:jst(Date.now()+1800_000)}]));
  assert.match(await waitReply(n2),/引数なし/);
});

test('debug executes the rolling week with Luna medium, reviewed images and no notification; replay creates one tab',async()=>{
  const payload=interaction('debug');
  const end=Number((BigInt(payload.id)>>22n)+1420070400000n),start=end-DEBUG_WEEK;
  messages=[message(root,start-1,'期間外'),message(root,start,'開始境界の構造試験'),message(root,end-1,'終了直前'),message(root,end,'終了境界は除外')];
  messages[1].attachments=[{id:'890123456789012345',filename:'photo.png',content_type:'image/png',size:100,url:'https://cdn.discordapp.com/attachments/a/photo.png'}];
  assert.equal((await(await signed(payload)).json() as any).type,5);
  assert.match(await waitReply(0),/Luna|gpt-5.6-luna/);
  const result=await finish(payload.id);
  assert.equal(result.status,'complete');assert.equal(result.posts,2);
  assert.equal(result.rangeFrom,start);assert.equal(result.rangeTo,end);
  assert.equal(result.model,'gpt-5.6-luna');assert.equal(result.reasoningEffort,'medium');
  assert.equal(summaryInputs.length,1);assert.equal(summaryInputs[0].model,'gpt-5.6-luna');assert.deepEqual(summaryInputs[0].reasoning,{effort:'medium'});
  assert.ok(summaryInputs[0].input[0].content.some((c:any)=>c.type==='input_image'));
  const apiText=JSON.stringify(summaryInputs);assert.ok(!apiText.includes('期間外'));assert.ok(!apiText.includes('終了境界は除外'));
  assert.equal(notifications.length,0);assert.equal(result.reviewedImages,1);
  assert.equal(writes.filter(w=>w.requests[0].addDocumentTab).length,1);
  assert.equal(writes.filter(w=>w.requests[0].insertInlineImage).length,1);
  const written=writes.flatMap(w=>w.requests.filter(r=>r.insertText).map(r=>r.insertText.text)).join('');
  for(const heading of ['1. 今週のまとめ','2. 部門・テーマごとの進捗','3. 今日話し合うこと'])assert.ok(written.includes(heading));
  assert.ok(!written.includes('##'));assert.ok(writes.some(w=>w.requests.some(r=>r.updateParagraphStyle)));
  const n=replies.length;await signed(payload);await waitReply(n);await harness('step',payload.id);
  assert.equal(summaryInputs.length,1);assert.equal(writes.filter(w=>w.requests[0].addDocumentTab).length,1);
  const n2=replies.length;await signed(interaction('status',[{name:'id',type:3,value:payload.id}]));
  const status=await waitReply(n2);assert.match(status,/medium/);assert.match(status,/tab=t.meeting/);
});

test('debug stops AI failure before Docs and never automatically pays for a retry',async()=>{
  summaryStatus=503; const payload=interaction('debug');
  messages=[message(root,Date.now()-3600_000,'電装試験')];
  await signed(payload);await waitReply(0);const result=await finish(payload.id);
  assert.equal(result.status,'failed');assert.match(result.error,/OPENAI_HTTP_503/);
  assert.equal(summaryInputs.length,1);assert.equal(writes.length,0);
  await harness('step',payload.id);assert.equal(summaryInputs.length,1);
});

test('debug empty period, permission denial and arbitrary options never generate a document',async()=>{
  let payload=interaction('debug');messages=[];
  await signed(payload);await waitReply(0);assert.equal((await finish(payload.id)).status,'failed');assert.equal(writes.length,0);assert.equal(summaryInputs.length,0);
  payload=interaction('debug');
  const r=await signed({...payload,member:{user:{id:user},permissions:'0'}});assert.match((await r.json() as any).data.content,/サーバー/);
  const n=replies.length;await signed(interaction('debug',[{name:'model',type:3,value:'other'}]));assert.match(await waitReply(n),/引数なし/);
});

test('debug window and Markdown styles preserve UTF-16 offsets after images',()=>{
  assert.deepEqual(debugWindow(1800000000000),{rangeFrom:1800000000000-DEBUG_WEEK,rangeTo:1800000000000});
  const {text,requests}=agendaTextRequests('## 電装😀\n- 試験\n','t.debug',42);
  assert.equal((requests[1].updateParagraphStyle as any).range.startIndex,42);
  assert.ok(text.includes('電装😀'));assert.ok(requests.every(r=>!JSON.stringify(r).includes('t.meeting')));
});

test('debug resumes persisted AI output after eviction without generating again',async()=>{
  const payload=interaction('debug');messages=[message(root,Date.now()-3600_000,'構造試験')];
  await signed(payload);await waitReply(0);
  let s:any;
  for(let i=0;i<80;i++){s=await harness('step',payload.id);if(s.status==='adding')break;}
  assert.equal(s.status,'adding');assert.equal(summaryInputs.length,1);assert.equal(writes.length,0);
  await mf.unsafeEvictDurableObject('meeting-test','TestMeetingScheduler',{name:`${guild}:${payload.id}`});
  assert.equal((await finish(payload.id)).status,'complete');assert.equal(summaryInputs.length,1);
  assert.equal(writes.filter(w=>w.requests[0].addDocumentTab).length,1);
});
