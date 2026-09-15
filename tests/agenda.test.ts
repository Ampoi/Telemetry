import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAgenda, prepare, validateAgenda, type Message, type Point, type Agenda } from '../src/agenda/index';
import { agendaDocsInput } from '../src/agenda/docs-input';
import { renderTemplate } from '../src/template';
import { agendaParts, agendaTextRequests } from '../src/debug-agenda';

const message = (overrides: Partial<Message> = {}): Message => ({ guild_id: '100', channel_id: '200', message_id: '300',
  created_at: '2026-09-14T01:00:00Z', content: '試験を完了。次回は結果を比較したい。', department: '開発',
  attachments: [{ attachment_id: '400', filename: '試験.png', storage_key: 'guild/100/messages/300/400', content_type: 'image/png' }], ...overrides });
const input = (messages = [message()]) => ({ project: '試験プロジェクト', meetingAt: '2026-09-15 18:00 JST',
  guildId: '100', from: '2026-09-14', to: '2026-09-15', messages });
const point = (overrides: Partial<Point> = {}): Point => ({ text: '試験を完了した。', sourceIds: ['300'], mediaIds: [], ...overrides });
const agenda = (): Agenda => ({ summary: [point()], topics: [{ department: '開発', title: '試験', previous: [],
  results: [point({ mediaIds: ['400'] })], insights: [], blockers: [], next: [] }], discussions: [] });
const response = (value: unknown = agenda(), extra: Record<string, unknown> = {}) => Response.json({ status: 'completed', output: [
  { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value, (key, value) =>
    key === 'sourceIds' ? value.map((id: string) => ({'300':'S1','301':'S2'}[id] ?? id)) :
    key === 'mediaIds' ? value.map((id: string) => id === '400' ? 'A1' : id) : value) }] }], usage: { input_tokens: 100, output_tokens: 50 }, ...extra });
const options = (fetch: typeof globalThis.fetch) => ({ apiKey: 'test-secret-never-real', model: 'gpt-5.6-luna', reasoningEffort: 'medium' as const, fetch });

test('JST half-open dates, deletion wins even over later records, latest edit retained', () => {
  const out = prepare(input([
    message({ message_id: '301', created_at: '2026-09-13T15:00:00Z', attachments: [] }),
    message({ message_id: '302', created_at: '2026-09-14T15:00:00Z', attachments: [] }),
    message({ message_id: '303', deleted: true }), message({ message_id: '303' }),
    message({ edited_at: '2026-09-14T04:00:00Z', content: '新しい内容' }), message(),
  ]));
  assert.deepEqual(out.messages.map(x => x.message_id), ['301', '300']);
  assert.equal(out.messages[1].content, '新しい内容');
});
test('invalid dates and cross-guild input rejected before API', () => {
  assert.throws(() => prepare({ ...input(), from: '2026-02-30' }), /INVALID_DATE/);
  assert.throws(() => prepare(input([message({ guild_id: '999' })])), /INVALID_MESSAGE/);
});
test('collector microsecond revisions do not roll back within one millisecond', () => {
  const newer = message({ edited_at: '2026-09-14T02:00:00.123456+00:00', collected_at: '2026-09-14T03:00:00Z', content: '最新' });
  const older = message({ edited_at: '2026-09-14T11:00:00.123455+09:00', collected_at: '2026-09-14T04:00:00Z', content: '古い履歴' });
  assert.equal(prepare(input([newer, older])).messages[0].content, '最新');
});
test('strict schema, fabricated references, wrong departments and media rejected', () => {
  const p = prepare(input());
  const a = agenda(); a.summary[0].sourceIds = ['999'];
  assert.throws(() => validateAgenda(a, p), /UNKNOWN_SOURCE/);
  const b = agenda(); b.topics[0].department = '架空部門';
  assert.throws(() => validateAgenda(b, p), /UNKNOWN_DEPARTMENT/);
  const c = agenda(); c.topics[0].results[0].mediaIds = ['999'];
  assert.throws(() => validateAgenda(c, p), /UNKNOWN_MEDIA/);
  assert.throws(() => validateAgenda({ ...agenda(), extra: true }, p), /INVALID_OUTPUT/);
  const d = agenda(); d.summary[0].text = 'https://untrusted.example';
  assert.throws(() => validateAgenda(d, p), /UNSAFE_OUTPUT_TEXT/);
});
test('Responses request separates source data, sends no storage paths, and returns fixed three-section document', async () => {
  let calls = 0;
  const result = await generateAgenda(input(), options(async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'manual');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    assert.equal(body.reasoning.effort, 'medium');
    const payload = JSON.parse(body.input[0].content[0].text);
    assert.equal(payload.messages[0].message_id, 'S1');
    assert.equal(payload.messages[0].attachments[0].attachment_id, 'A1');
    assert.ok(!String(init?.body).includes('guild/100/messages'));
    return response();
  }));
  assert.equal(calls, 1);
  assert.deepEqual(result.markdown.match(/^## .+$/gm), ['## 1. 今週の要点', '## 2. 部門・テーマ別の進捗', '## 3. 今日話し合うこと']);
  assert.match(result.markdown, /https:\/\/discord.com\/channels\/100\/200\/300/);
  assert.equal(result.media['400'].imageReviewed, false);
  assert.ok(result.markdown.indexOf('試験を完了した') < result.markdown.indexOf('添付：'));
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});
test('explicit image data is sent, private URLs are never fetched', async () => {
  const result = await generateAgenda({ ...input(), images: [{ attachmentId: '400', dataUrl: 'data:image/png;base64,YQ==' }] }, options(async (_, init) => {
    const content = JSON.parse(String(init?.body)).input[0].content;
    assert.equal(content.at(-1).type, 'input_image');
    return response();
  }));
  assert.equal(result.media['400'].imageReviewed, true);
  assert.throws(() => prepare({ ...input(), images: [{ attachmentId: '400', dataUrl: 'https://example.com/a.png' }] }), /INVALID_IMAGE/);
});
test('empty data produces no API calls', async () => {
  const result = await generateAgenda(input([]), options(() => assert.fail('unexpected request')));
  assert.equal(result.metadata.requestCount, 0); assert.ok(result.notes.includes('対象ログ内に報告なし'));
});

test('new template preserves evidence and decisions while omitting empty fields and generation notes in both outputs', async () => {
  const a = agenda();
  a.summary = [point({text:'成果：荷重20 Nで試験を完了した。'})];
  a.topics[0].blockers = [point({text:'追加試験の要否を確認する。→ 議題①'})];
  a.discussions = [{title:'追加試験を実施するか',question:[point({text:'追加試験の実施要否を決める。'})],
    background:[point({text:'開発・試験の結果を参照。'})],options:[point({text:'投稿者の案は同条件での再試験。'})],
    people:[point({text:'@開発'})],deadline:[],materials:[]}];
  const result = await generateAgenda({...input(),coverageNotes:['生成内部メモ']},options(async()=>response(a)));
  assert.equal(result.templateVersion,'weekly-agenda-v2');
  const md = result.markdown;
  assert.match(md,/開催日時：2026-09-15 18:00 JST/);
  assert.match(md,/- \*\*成果：\*\* 荷重20 N/);
  assert.match(md,/### 議題① 追加試験を実施するか/);
  assert.equal(md.match(/\*\*判断材料：\*\*/g)?.length,1);
  assert.match(md,/\*\*関係者：\*\* @開発/);
  const parts=agendaParts(result,[]), written=parts.map(p=>p.value).join('');
  for (const body of [md,written]) {
    for (const unwanted of ['生成内部メモ','対象ログ内に記載なし','不足情報：','判断期限：','予定 → 現状：','生成用ルール']) assert.ok(!body.includes(unwanted),unwanted);
    assert.ok(body.includes('→ 議題①'));
    assert.ok(body.includes('https://discord.com/channels/100/200/300'));
    assert.ok(body.includes('荷重20 N'));
  }
  const styled=agendaTextRequests('- 成果：荷重20 N\n関係者：@開発／判断期限：要確認\n','t.agenda',42);
  const bold=styled.requests.flatMap((r:any)=>r.updateTextStyle?.textStyle.bold?[r.updateTextStyle.range]:[]);
  assert.deepEqual(bold.map((r:any)=>styled.text.slice(r.startIndex-42,r.endIndex-42)),['成果：','関係者：','判断期限：']);
});
test('provider failures are bounded and do not echo secret bodies', async () => {
  await assert.rejects(generateAgenda(input(), options(async () => new Response(null, { status: 302, headers: { Location: 'https://example.com' } }))), /OPENAI_HTTP_302/);
  await assert.rejects(generateAgenda(input(), options(async () => new Response('secret', { status: 401 }))), /OPENAI_HTTP_401/);
  await assert.rejects(generateAgenda(input(), options(async () => response(agenda(), { status: 'incomplete' }))), /OPENAI_INCOMPLETE/);
  await assert.rejects(generateAgenda(input(), options(async () => response(agenda(), { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }))), /OPENAI_REFUSAL/);
  await assert.rejects(generateAgenda(input(), options(async () => { throw new Error('secret'); })), /OPENAI_NETWORK_ERROR/);
});

test('duplicate citations are normalized but absent or invented evidence is still rejected', async () => {
  const a=agenda();a.summary[0].sourceIds=['300','300'];
  const result=await generateAgenda(input(),options(async()=>response(a)));
  assert.deepEqual(result.agenda.summary[0].sourceIds,['300']);
  a.summary[0].sourceIds=[];
  await assert.rejects(generateAgenda(input(),options(async()=>response(a))),/UNSUPPORTED_POINT/);
  a.summary[0].sourceIds=['999'];
  await assert.rejects(generateAgenda(input(),options(async()=>response(a))),/UNKNOWN_SOURCE/);
});
test('request limit rejects large workloads before spending', async () => {
  const messages = Array.from({ length: 4 }, (_, i) => message({ message_id: String(500 + i), attachments: [], content: 'a'.repeat(4000) }));
  await assert.rejects(generateAgenda(input(messages), { ...options(() => assert.fail('unexpected request')), chunkCharacters: 5000, maxRequests: 2 }), /REQUEST_LIMIT/);
});
test('multi-chunk input preserves source IDs through merge', async () => {
  const messages = [message({ content: 'a'.repeat(4000) }), message({ message_id: '301', attachments: [], content: 'b'.repeat(4000) })];
  let count = 0;
  const result = await generateAgenda(input(messages), { ...options(async (_, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).input[0].content[0].text);
    count++;
    if (payload.messages) return response({ summary: [point({ sourceIds: [payload.messages[0].message_id] })], topics: [], discussions: [] });
    assert.equal(payload.drafts.length, 2);
    return response({ summary: [point({ sourceIds: ['300', '301'] })], topics: [], discussions: [] });
  }), chunkCharacters: 5000 });
  assert.equal(count, 3); assert.deepEqual(result.agenda.summary[0].sourceIds, ['300', '301']);
});
test('Docs adapter uses existing API contract and never re-expands generated text', () => {
  const result = agendaDocsInput({title:'週次会議',markdown:'# 結果\n{{do_not_expand}}'},
    {document:'https://docs.google.com/document/d/abcdef_12345/edit',requestId:'agenda-test-0001'});
  assert.equal(result.document,'abcdef_12345');
  assert.equal(renderTemplate(result.template,result.data),'# 結果\n{{do_not_expand}}');
  assert.throws(()=>agendaDocsInput({title:'週次',markdown:'a'.repeat(50001)},{document:'abcdef_12345',requestId:'agenda-test-0001'}));
  assert.throws(()=>agendaDocsInput({title:'週次',markdown:'本文'},{document:'abcdef_12345',requestId:'bad'}));
});

test('API reference aliases reject unknown IDs and restore long original IDs', async () => {
  const original = '1532954331618476072';
  const result = await generateAgenda(input([message({message_id:original,reply_to_message_id:'999999999999999999'})]), options(async (_, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).input[0].content[0].text);
    assert.equal(payload.messages[0].message_id, 'S1');
    assert.equal(payload.messages[0].reply_to_message_id, null);
    return response({summary:[point({sourceIds:['S1'],mediaIds:['A1']})],topics:[],discussions:[]});
  }));
  assert.deepEqual(result.agenda.summary[0].sourceIds,[original]);
  assert.deepEqual(result.agenda.summary[0].mediaIds,['400']);
  await assert.rejects(generateAgenda(input(), options(async () => response({summary:[point({sourceIds:['S999']})],topics:[],discussions:[]}))), /UNKNOWN_SOURCE/);
});

test('referencing an attachment cites its actual containing post too', async () => {
  const result = await generateAgenda(input([message(),message({message_id:'301',attachments:[]})]),options(async()=>
    response({summary:[point({sourceIds:['S2'],mediaIds:['A1']})],topics:[],discussions:[]})));
  assert.deepEqual(result.agenda.summary[0].sourceIds,['301','300']);
});

test('a supported department topic can include another department blocker', () => {
  const prepared = prepare(input([message(),message({message_id:'301',department:'電装',attachments:[]})]));
  const value = agenda();
  value.topics[0].blockers=[point({text:'電装側から接続不良の報告。',sourceIds:['301']})];
  assert.equal(validateAgenda(value,prepared).topics[0].department,'開発');
  value.topics[0].results=[];
  assert.throws(()=>validateAgenda(value,prepared),/UNKNOWN_DEPARTMENT/);
});
