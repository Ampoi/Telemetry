import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({ options: { 'oauth-client': { type: 'string' } } });
if (existsSync('.dev.vars') && !values['oauth-client']) {
  console.log('.dev.vars は作成済みです。既存の認証情報を保護するため上書きしません。Googleの値は .dev.vars を編集してください。');
} else {
  let clientId = 'replace-with-web-client-id.apps.googleusercontent.com';
  let clientSecret = 'replace-with-client-secret';
  if (values['oauth-client']) {
    const config = JSON.parse(readFileSync(values['oauth-client'], 'utf8'));
    if (!config.web?.client_id || !config.web?.client_secret) throw new Error('「ウェブアプリケーション」用のOAuthクライアントJSONを指定してください。');
    clientId = config.web.client_id;
    clientSecret = config.web.client_secret;
  }
  const existing = existsSync('.dev.vars') ? parseEnv(readFileSync('.dev.vars', 'utf8')) : {};
  const variables = {
    DEMO_API_KEY: randomBytes(32).toString('base64url'),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
    ...existing,
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
  };
  writeFileSync('.dev.vars', Object.entries(variables).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
  console.log('.dev.vars のGoogle認証設定を保存しました（既存のAPIキー・暗号化キーは保持します）。');
  if (!values['oauth-client']) console.log('.dev.vars の GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を設定してください。');
}
console.log('Google OAuthの承認済みリダイレクトURI: http://localhost:8787/auth/callback\n次に pnpm db:local と pnpm dev を実行してください。');
