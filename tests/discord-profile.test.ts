import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicationDescription, profileBio } from '../src/discord-profile';

test('プロフィールは未接続・旧接続・保存先だけの設定を区別する', () => {
  assert.match(profileBio({ connected: false, email: null, documentUrl: null }), /Google: 設定されてないです.*\nDocs: 設定されてないです/);
  assert.match(profileBio({ connected: true, email: null, documentUrl: null }), /接続済み・メール未取得/);
  const url = 'https://docs.google.com/document/d/test_document_12345/edit';
  assert.equal(profileBio({ connected: true, email: 'user@example.com', documentUrl: url }), `Google: user@example.com\nDocs: ${url}`);
  assert.ok(profileBio({ connected: false, email: 'stale@example.com', documentUrl: url }).includes(url));
  assert.ok(!profileBio({ connected: false, email: 'stale@example.com', documentUrl: url }).includes('stale@example.com'));
});

test('共通プロフィールは空にせず未設定を明示し、接続済みならサーバー内の確認先へ案内する', () => {
  assert.ok(applicationDescription(false).startsWith('設定されてないです\n'));
  assert.ok(!applicationDescription(true).includes('設定されてないです'));
  assert.match(applicationDescription(true), /\/document/);
});

test('長すぎる情報を途中で切らず、完全な情報を表示できるコマンドへ案内する', () => {
  const bio = profileBio({ connected: true, email: 'a'.repeat(150) + '@example.com', documentUrl: 'https://docs.google.com/document/d/' + 'b'.repeat(200) + '/edit' });
  assert.ok(bio.length <= 190);
  assert.match(bio, /\/document/);
  assert.ok(!bio.includes('https://docs.google.com/document/d/'));
});
