import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions, Response as MockResponse } from 'miniflare';

test('agenda consumes actual D1 exportRecord output in Workers without changing Bot entrypoints', async () => {
  execSync('pnpm exec wrangler deploy tests/agenda-harness.ts --dry-run --outdir .test-dist/agenda', {stdio:'pipe'});
  let calls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules:true,scriptPath:'.test-dist/agenda/agenda-harness.js',compatibilityDate:'2026-09-15',
    compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
    outboundService: async request => {
      calls++;
      assert.equal(request.url,'https://api.openai.com/v1/responses');
      assert.equal(request.headers.get('Authorization'),'Bearer fake-openai');
      const body = await request.json() as any;
      const payload = JSON.parse(body.input[0].content[0].text);
      const source = payload.messages[0];
      assert.equal(source.content,'試験を完了した。');
      assert.equal(source.attachments[0].attachment_id,'A1');
      assert.ok(!JSON.stringify(body).includes('private-storage'));
      const point = {text:'試験を完了した。',sourceIds:[source.message_id],mediaIds:['A1']};
      return MockResponse.json({status:'completed',output:[{type:'message',content:[{type:'output_text',
        text:JSON.stringify({summary:[point],topics:[],discussions:[]})}]}]});
    },
  }));
  try {
    const db = await mf.getD1Database('DB');
    for (const file of (await readdir('migrations')).sort()) {
      for (const sql of (await readFile(`migrations/${file}`,'utf8')).split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
    }
    const fixture = JSON.parse(await readFile('examples/agenda-request.json','utf8'));
    const message = {...fixture.messages[0],content:'試験を完了した。'};
    await db.prepare('INSERT INTO cloud_messages(guild,id,channel,created,revision,data,deleted,verified,observed) VALUES(?,?,?,?,?,?,0,0,0)')
      .bind(message.guild_id,message.message_id,message.channel_id,message.created_at,message.created_at,JSON.stringify(message)).run();
    await db.prepare("INSERT INTO cloud_attachments(guild,id,message,channel,version,data,status,storage_key,attempts) VALUES(?,?,?,?,?,?,'stored',?,1)")
      .bind(message.guild_id,'400',message.message_id,message.channel_id,'fixture-v1',
        JSON.stringify({attachment_id:'400',filename:'test.png',content_type:'image/png'}),'private-storage/test').run();
    const response = await mf.dispatchFetch('http://localhost/agenda',{method:'POST',body:JSON.stringify(fixture)});
    assert.equal(response.status,200,await response.clone().text());
    const result = await response.json() as any;
    assert.equal(calls,1);
    assert.equal(result.media['400'].storage_key,'private-storage/test');
    assert.deepEqual(result.agenda.summary[0].sourceIds,[message.message_id]);
    assert.match(result.markdown,/今週の要点/);
  } finally { await mf.dispose(); }
});
