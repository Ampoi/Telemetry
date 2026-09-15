import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { documentId, renderTemplate, compileMarkdown } from '../src/template';

const help = `Google Docs タブ作成デモ

pnpm demo auth                       認証URLを開き、Google連携する
pnpm demo status                     接続情報を確認する
pnpm demo run --doc <URLまたはID>     未接続なら認証し、デバッグ用タブを作る
pnpm demo tabs --doc <URLまたはID>    タブ一覧を見る
pnpm demo preview                    テンプレートをローカルで確認する
pnpm demo logout                     保存した認証情報を削除する

オプション:
  --title <名前>           タブ名（省略時は作成日時）
  --template <file.md>      Markdownテンプレート（省略時 templates/debug.md）
  --data <file.json>        差し込む変数（createdAt/runId/messageを上書き可）
  --request-id <ID>         重複実行を防ぐID（省略時UUID）
  --base-url <URL>          WorkersのURL（省略時 http://localhost:8787）
  --no-open                ブラウザを自動で開かずURLだけ表示

リモート用のAPIキーは環境変数 DEMO_API_KEY に設定してください。
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    doc: { type: 'string' }, title: { type: 'string' }, template: { type: 'string' }, data: { type: 'string' },
    'request-id': { type: 'string' }, 'base-url': { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(help); return; }
  if (!['auth', 'status', 'run', 'tabs', 'preview', 'logout'].includes(command) || positionals.length > 1) throw new Error(help);
  const base = new URL(values['base-url'] ?? process.env.DEMO_BASE_URL ?? 'http://localhost:8787');
  if (base.href !== `${base.origin}/` || (base.protocol !== 'https:' && !(base.protocol === 'http:' && base.hostname === 'localhost'))) throw new Error('--base-urlはHTTPSオリジンまたは http://localhost:8787 を指定してください。');
  // Only load local credentials for localhost, never silently send them to a remote host.
  if (base.hostname === 'localhost') {
    try { loadEnvFile('.dev.vars'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const apiKey = process.env.DEMO_API_KEY;
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!apiKey) throw new Error('ローカルでは pnpm setup、リモートでは DEMO_API_KEY を設定してください。');
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000), redirect: 'error',
      });
    } catch { throw new Error(`Workerに接続できません（${base.origin}）。pnpm dev の起動またはデプロイ先を確認してください。run中の通信断では、再実行前にドキュメントの状態を確認してください。`); }
    const result = await response.json() as T & { error?: string; details?: unknown };
    if (!response.ok) throw new Error(`${result.error ?? `HTTP ${response.status}`}${result.details ? `\n${JSON.stringify(result.details, null, 2)}` : ''}`);
    return result;
  }
  async function authenticate() {
    const login = await api<{ id: string; url: string; expiresIn: number }>('/api/auth', 'POST');
    const loginUrl = new URL(login.url);
    if (loginUrl.origin !== base.origin || loginUrl.pathname !== '/auth/start') throw new Error('認証URLが指定Workerと一致しません。APP_ORIGINを確認してください。');
    console.log(`次のURLを開いてGoogleドキュメントの編集を許可してください（10分間有効）。\n${login.url}`);
    if (!values['no-open']) {
      const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', login.url] : [login.url];
      const child = spawn(program, args, { stdio: 'ignore', detached: true });
      child.on('error', () => console.log('上のURLを手動で開いてください。'));
      child.unref();
    }
    const deadline = Date.now() + login.expiresIn * 1000;
    while (Date.now() < deadline) {
      const { status } = await api<{ status: string }>(`/api/auth/${login.id}`);
      if (status === 'complete') { console.log('Google認証が完了しました。'); return; }
      if (status === 'failed' || status === 'expired') throw new Error('認証がキャンセルされたか期限切れです。pnpm demo auth を再実行してください。');
      await sleep(1500);
    }
    throw new Error('認証の待機時間が終了しました。pnpm demo auth を再実行してください。');
  }
  if (command === 'auth') { await authenticate(); return; }
  if (command === 'status') { console.log(JSON.stringify(await api('/api/status'), null, 2)); return; }
  if (command === 'logout') { await api('/api/auth', 'DELETE'); console.log('Workerに保存した認証情報を削除しました。Google側の許可も取り消す場合はGoogleアカウントの接続管理から解除してください。'); return; }
  if (command === 'tabs') {
    if (!values.doc) throw new Error('--doc <GoogleドキュメントのURLまたはID> が必要です。');
    console.log(JSON.stringify(await api(`/api/tabs?document=${encodeURIComponent(documentId(values.doc))}`), null, 2)); return;
  }
  if (command === 'run' && !values.doc) throw new Error('--doc <GoogleドキュメントのURLまたはID> が必要です。');
  const id = command === 'run' ? documentId(values.doc!) : '';
  const template = await readFile(values.template ?? new URL('../templates/debug.md', import.meta.url), 'utf8');
  const extra: unknown = values.data ? JSON.parse(await readFile(values.data, 'utf8')) : {};
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('--dataはJSONオブジェクトにしてください。');
  const requestId = values['request-id'] ?? randomUUID();
  const data = { createdAt: new Date().toISOString(), runId: requestId, message: 'Google Docs APIからの書き込みテストです。', ...extra };
  const rendered = renderTemplate(template, data);
  if (command === 'preview') { console.log(compileMarkdown(rendered).text); return; }
  const { connected } = await api<{ connected: boolean }>('/api/status');
  if (!connected) await authenticate();
  console.log(`実行ID: ${requestId}`);
  const result = await api<{ url: string; tabId: string }>('/api/tabs', 'POST', {
    document: id, title: values.title ?? `デバッグ ${data.createdAt}`, template, data, requestId,
  });
  console.log(`タブを作成し、テンプレートを入力しました。\n${result.url}`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : '実行に失敗しました。'); process.exitCode = 1; });
