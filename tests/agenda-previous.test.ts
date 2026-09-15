import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAgenda, prepare, validateAgenda, type Input } from '../src/agenda/index';
import { minutesText } from '../src/meeting-minutes';
import { agendaParts } from '../src/debug-agenda';

const input: Input = { project: 'R-1', meetingAt: '2026-06-28', guildId: '100', from: '2026-06-21', to: '2026-06-28', messages: [],
  previousMinutes: '決定：手持ちのネジで進める。Todo：太郎が消費電流を測る。期限6月27日。',
  previousMinutesUrl: 'https://docs.google.com/document/d/test_document_123/edit?tab=t.previous' };
const options = { apiKey: 'test-key', model: 'test-model' };
const result = (source: string) => ({ summary: [], topics: [{ department: '前回MTG', title: '固定と電流測定',
  previous: [{ text: '手持ちのネジで進めると決定済み。太郎の消費電流測定（期限6月27日）は進捗未確認。', sourceIds: [source], mediaIds: [] }],
  results: [], insights: [], blockers: [], next: [] }], discussions: [] });
const response = (agenda: unknown) => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(agenda) }] }] });
const extracted = () => ({ items: [{ kind: 'todo', text: '消費電流を測る', member: '太郎', deadline: '6月27日', evidence: input.previousMinutes }] });

test('previous minutes are independent evidence even without new Discord reports', async () => {
  let calls = 0;
  const output = await generateAgenda(input, { ...options, fetch: async (_, init) => {
    calls++;
    const request = JSON.parse(String(init?.body)), payload = JSON.parse(request.input[0].content[0].text);
    if (request.text.format.name === 'agenda_previous_minutes') return response(extracted());
    assert.equal(payload.previousMinutes.content, input.previousMinutes);
    assert.deepEqual(payload.messages, []);
    assert.match(request.instructions, /進捗未確認/);
    return response(result(payload.previousMinutes.items[0].message_id));
  } });
  assert.equal(calls, 2);
  assert.equal(output.metadata.previousMinutesUsed, true);
  assert.deepEqual(output.agenda.topics[0].previous[0].sourceIds, ['previous-minutes:1']);
  assert.match(output.markdown, /\[¹\]\(https:\/\/docs.google.com/);
  assert.match(agendaParts(output, []).map(p => p.value).join(''), /\[¹\]\(https:\/\/docs.google.com/);
  assert.throws(() => validateAgenda(result('previous-minutes'), prepare({ ...input, previousMinutes: '' })), /UNKNOWN_SOURCE/);
});

test('saved tab reader uses appended minutes, nested tables and renamed tab; ignores other tabs', () => {
  const document = { tabs: [
    { tabProperties: { tabId: 'other' }, documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: '別会議の内容' } }] } }] } } },
    { childTabs: [{ tabProperties: { tabId: 'saved' }, documentTab: { body: { content: [
      { paragraph: { elements: [{ textRun: { content: 'アジェンダ\n' } }] } },
      { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: '決定：購入を取り消す。\n' } }] } }] }] }] } },
    ] } } }] },
  ] };
  assert.equal(minutesText(document, 'saved'), 'アジェンダ\n決定：購入を取り消す。');
  assert.throws(() => minutesText(document, 'missing'), /タブが見つかりません/);
});

test('minutes references survive chunking and final merge with fresh aliases', async () => {
  let calls = 0;
  const messages = ['1', '2'].map(message_id => ({ guild_id: '100', channel_id: '200', message_id,
    created_at: '2026-06-22T00:00:00Z', content: 'あ'.repeat(4000) }));
  const output = await generateAgenda({ ...input, messages }, { ...options, chunkCharacters: 5000, fetch: async (_, init) => {
    calls++;
    const request = JSON.parse(String(init?.body)), payload = JSON.parse(request.input[0].content[0].text);
    if (request.text.format.name === 'agenda_previous_minutes') return response(extracted());
    assert.equal(payload.previousMinutes.content, input.previousMinutes);
    return response(result(payload.previousMinutes.items[0].message_id));
  } });
  assert.equal(calls, 4);
  assert.equal(output.agenda.topics[0].previous[0].sourceIds[0], 'previous-minutes:1');
});

test('untrusted minutes URLs and oversized text are rejected before any request', () => {
  assert.throws(() => prepare({ ...input, previousMinutesUrl: 'https://evil.example' }), /INVALID_MINUTES_URL/);
  assert.throws(() => prepare({ ...input, previousMinutes: 'a'.repeat(100001) }), /PREVIOUS_MINUTES_TOO_LARGE/);
});

test('omitted commitments are preserved, with original owners and deadlines and no guessed completion', async()=>{
  const output=await generateAgenda(input,{...options,fetch:async(_,init)=>{
    const request=JSON.parse(String(init?.body));
    return response(request.text.format.name==='agenda_previous_minutes'?extracted():{summary:[],topics:[],discussions:[]});
  }});
  assert.equal(output.metadata.previousItemCount,1);
  assert.match(output.markdown,/太郎/);assert.match(output.markdown,/6月27日/);assert.match(output.markdown,/照合が必要/);
  assert.match(output.markdown,/\[¹\]\(https:\/\/docs.google.com/);
});

test('invented minutes evidence fails before agenda generation; request cap includes extraction',async()=>{
  let calls=0;
  await assert.rejects(generateAgenda(input,{...options,fetch:async()=>{
    calls++;return response({items:[{...extracted().items[0],evidence:'架空の決定事項'}]});
  }}),/UNSUPPORTED_MINUTES_ITEM/);
  assert.equal(calls,1);
  await assert.rejects(generateAgenda(input,{...options,maxRequests:1,fetch:async()=>assert.fail('must not spend')}),/REQUEST_LIMIT/);
});

test('generated theme labels resolve to cited configured departments without inventing a department',async()=>{
  const messages=[{guild_id:'100',channel_id:'200',message_id:'301',created_at:'2026-06-22T00:00:00Z',content:'電装試験',department:'times_kotaro'}];
  const output=await generateAgenda({...input,messages,previousMinutes:undefined,previousMinutesUrl:undefined},{...options,fetch:async()=>{
    const a=result('S1');a.topics[0].department='電装';return response(a);
  }});
  assert.equal(output.agenda.topics[0].department,'times_kotaro');
});
