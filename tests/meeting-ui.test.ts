import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { meetingPage } from '../src/meeting-page';

test('generated shadcn shell supplies every interactive DOM target and keeps nonce CSP', async () => {
  const response = meetingPage('1549254118382641213');
  const html = await response.text();
  const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/)!;
  assert.ok(script);
  new Script(script[2]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const [, id] of script[2].matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(id), `Missing UI target: ${id}`);
  assert.match(response.headers.get('Content-Security-Policy')!, new RegExp(`script-src 'nonce-${script[1]}'`));
  assert.ok(html.includes(`/mtg/login?poll=1549254118382641213`));
  assert.ok(!html.includes('__POLL_ID__'));
  assert.ok(!html.includes('<script src='));
});
