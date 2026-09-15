import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistory, zipJson } from '../scripts/import-meeting-history';
import { agendaMessages } from '../src/debug-agenda';
import { sourceInput } from '../src/meeting-source';
const guild='1451490986520744020',channel='1513492693794160770';
const message={id:'1513492743790264320',channel_id:channel,timestamp:'2026-06-08T10:39:49.455000+00:00',edited_timestamp:null,content:'最初の内容',author:{id:'993875870626361374',username:'tester'},attachments:[]};
const backup=(messages:any[],sourceGuild=guild)=>({schema_version:1,channels:[{channel:{id:channel,guild_id:sourceGuild,name:'構造',type:0},messages}]});
test('archive identity cannot overwrite the meeting query window', () => {
  assert.deepEqual(sourceInput({ archive: 'r1', sourceGuild: guild, project: 'R-1', rangeFrom: 1, rangeTo: 9999999999999 }),
    { sourceArchive: 'r1', sourceGuild: guild, projectName: 'R-1' });
});
test('history import merges duplicate IDs, retains newest microsecond edit and rejects mixed guilds',()=>{
  const latest={...message,content:'最新の内容',edited_timestamp:'2026-06-09T00:00:00.000002Z'};
  const old={...latest,content:'古い編集',edited_timestamp:'2026-06-09T00:00:00.000001Z'};
  const result=mergeHistory([backup([message,latest]),backup([old,message])]);
  assert.equal(result.posts.length,1);assert.equal(result.posts[0].content,'最新の内容');assert.equal(result.guild,guild);
  assert.throws(()=>mergeHistory([backup([message]),backup([message],'1535965236136251462')]),/MultipleSourceGuilds/);
  assert.throws(()=>zipJson(Buffer.alloc(22)),/InvalidZip/);
});
test('long historical attachment names fit agenda input without losing their source ID',()=>{
  const result=mergeHistory([backup([{...message,attachments:[{id:'1535575825783595050',filename:'長'.repeat(350),url:'https://cdn.discordapp.com/a',size:10}]}])]);
  const a=agendaMessages(result.posts,guild)[0].attachments![0];
  assert.equal(a.filename!.length,300);assert.equal(a.attachment_id,'1535575825783595050');
  assert.equal(result.posts[0].attachments[0].filename.length,350);
});
