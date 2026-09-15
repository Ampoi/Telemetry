import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';

async function main() {
  const { values } = parseArgs({ options: { guild: { type: 'string' }, 'base-url': { type: 'string' }, 'env-file': { type: 'string' }, status: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('pnpm run discord:profile --guild SERVER_ID --base-url https://your-worker.example [--env-file .dev.vars] [--status]\nDEMO_API_KEYを環境変数または指定したenvファイルで設定してください。既定ではプロフィール更新を受付し、--statusでは現在の接続と同期状況を表示します。');
    return;
  }
  if (!values.guild || !/^\d{17,20}$/.test(values.guild)) throw new Error('--guildにサーバーIDを指定してください。');
  const fileEnv = values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {};
  const env = { ...fileEnv, ...process.env };
  const base = new URL(values['base-url'] ?? env.APP_ORIGIN ?? 'http://localhost:8787');
  if (base.href !== `${base.origin}/` || (base.protocol !== 'https:' && base.origin !== 'http://localhost:8787')) throw new Error('--base-urlはHTTPS originまたはhttp://localhost:8787です。');
  if (!env.DEMO_API_KEY) throw new Error('DEMO_API_KEYを設定してください。');
  const response = await fetch(`${base.origin}/api/discord/profile?guild=${values.guild}`, {
    method: values.status ? 'GET' : 'POST', headers: { Authorization: `Bearer ${env.DEMO_API_KEY}` },
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`プロフィールAPI: HTTP ${response.status}`);
  console.log(await response.json());
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'プロフィール更新に失敗しました。'); process.exitCode = 1; });
