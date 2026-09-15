import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMarkdown, contentRequests, documentId, renderTemplate } from '../src/template';
import { encrypt, decrypt, randomToken } from '../src/crypto';

test('Google Docs URL/IDを受け付け、別ホストや不正パスを拒否する', () => {
  assert.equal(documentId('https://docs.google.com/document/d/abcdef_12345/edit?tab=t.1'), 'abcdef_12345');
  assert.equal(documentId('https://docs.google.com/document/u/0/d/abcdef_12345/edit'), 'abcdef_12345');
  assert.equal(documentId('abcdef_12345'), 'abcdef_12345');
  for (const value of ['https://evil.example/document/d/abcdef_12345', 'https://docs.google.com.evil.example/document/d/abcdef_12345', 'https://docs.google.com/spreadsheets/d/abcdef_12345', 'bad']) assert.throws(() => documentId(value));
});

test('変数不足・不正値を拒否し、入力値を再展開しない', () => {
  assert.equal(renderTemplate('{{message}} {{number}}', { message: '{{secret}}', number: 12 }), '{{secret}} 12');
  assert.throws(() => renderTemplate('{{missing}}', {}), /missing/);
  assert.throws(() => renderTemplate('{{toString}}', {}), /toString/);
  assert.throws(() => renderTemplate('{{data}}', { data: {} }));
  assert.throws(() => renderTemplate('test\u0000', {}));
});

test('日本語と絵文字のUTF-16位置で新しいタブだけを書式設定する', () => {
  const compiled = compileMarkdown('# 作成 🚀\n\n- 確認済み\n');
  assert.equal(compiled.text, '作成 🚀\n\n確認済み\n');
  assert.equal(compiled.paragraphs[2].start, '作成 🚀\n\n'.length + 1);
  const requests = contentRequests('# 作成 🚀\n- 確認済み\n', 't.created');
  assert.deepEqual(requests[0], { insertText: { endOfSegmentLocation: { tabId: 't.created' }, text: '作成 🚀\n確認済み\n' } });
  assert.ok(JSON.stringify(requests[1]).includes('t.created'));
  assert.ok(JSON.stringify(requests[2]).includes('t.created'));
});

test('トークンを暗号化でき、別の鍵・改変された暗号文を拒否する', async () => {
  const secret = randomToken();
  const sealed = await encrypt('refresh-token-test-only', secret);
  assert.ok(!sealed.includes('refresh-token-test-only'));
  assert.equal(await decrypt(sealed, secret), 'refresh-token-test-only');
  await assert.rejects(decrypt(sealed, secret, 'discord:another-user'));
  await assert.rejects(decrypt(sealed, randomToken()));
  const pieces = sealed.split('.');
  pieces[2] = `${pieces[2][0] === 'A' ? 'B' : 'A'}${pieces[2].slice(1)}`;
  await assert.rejects(decrypt(pieces.join('.'), secret));
});

test('numbered citations work through the Docs API adapter without exposing URLs or interpreting other Markdown', () => {
  const markdown = '# 確認😀\n- 結果[¹²](https://discord.com/channels/1/2/3)／次[²](https://discord.com/channels/1/2/4)\n[普通](https://example.com)';
  const compiled = compileMarkdown(markdown);
  assert.equal(compiled.text, '確認😀\n結果12／次2\n[普通](https://example.com)\n');
  assert.deepEqual(compiled.citations.map(c => compiled.text.slice(c.start - 1, c.end - 1)), ['12', '2']);
  const styles = contentRequests(markdown, 't.cite').flatMap((r: any) => r.updateTextStyle ? [r.updateTextStyle] : []);
  assert.equal(styles.length, 2);
  assert.ok(styles.every(s => s.textStyle.baselineOffset === 'SUPERSCRIPT' && s.range.tabId === 't.cite'));
});
