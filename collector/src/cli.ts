import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { RunLock, Store } from './store.ts';
import { exportJsonl } from './export.ts';
import { Collector } from './bot.ts';
import { safeError } from './model.ts';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: 'string', default: 'config.yaml' }, env: { type: 'string', default: '.env' }, from: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean' } } });
  const command = positionals[0];
  if (values.help || !command) { console.log('pnpm collector run|status|export|retry-attachments [--config config.yaml] [--env .env]\nexport --from YYYY-MM-DD --to YYYY-MM-DD（JST、終了日は含まない）\nパスの基準はcollector/。共有アプリのコマンド登録はルートのpnpm discord:registerを使用。'); return; }
  if (positionals.length !== 1 || !['run', 'status', 'export', 'retry-attachments'].includes(command)) throw new Error('未知のコマンドです。--helpを確認してください');
  const config = loadConfig(resolve(values.config), resolve(values.env), command === 'run');
  const lock = ['run', 'retry-attachments'].includes(command) ? new RunLock(config.database) : undefined;
  let store: Store | undefined;
  try {
    store = new Store(config.database, config.guild);
    if (command === 'status') console.log(JSON.stringify(store.status(), null, 2));
    else if (command === 'export') { if (!values.from || !values.to) throw new Error('--from/--toを指定してください'); console.log(JSON.stringify(exportJsonl(store, values.from, values.to, config.exports))); }
    else if (command === 'retry-attachments') { store.retryAttachments(); console.log('失敗した添付を再試行待ちに戻しました。runで再開します。'); }
    else {
      const bot = new Collector(config, store);
      let stop!: () => void;
      const stopped = new Promise<void>(r => { stop = r; });
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try { await bot.start(); await stopped; } finally { await bot.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
  } finally { store?.close(); lock?.close(); }
}
main().catch(error => {
  // Only explicitly authored local validation errors are printable; third-party errors may include tokens.
  const text = error instanceof Error && /[\u3040-\u30ff\u3400-\u9fff]/.test(error.message) ? error.message : safeError(error);
  console.error(text); process.exitCode = 1;
});
