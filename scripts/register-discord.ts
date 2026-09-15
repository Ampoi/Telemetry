import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { discordCommands } from '../src/discord-commands';

async function main() {
  const { values } = parseArgs({ options: {
    guild: { type: 'string' }, global: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'collector-only': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('--collector-only: 収集専用アプリでは /telemetry だけ登録します。共有アプリでは省略してください。');
    console.log('pnpm discord:register [--guild SERVER_ID | --global] [--dry-run]\n.env.discord に DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN を設定してください。\n既定はグローバル登録です。開発者が一度登録すれば、招待先で /auth・/document・/create・/telemetry・/mtg が利用できます。\n--guild は特定サーバーだけで試す場合に指定します。その他のコマンドは削除しません。');
    return;
  }
  if (values.global && values.guild) throw new Error('--global と --guild は同時に指定できません。');
  let fileEnv: Record<string, string | undefined> = {};
  try { fileEnv = parseEnv(await readFile('.env.discord', 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const env = { ...fileEnv, ...process.env };
  const application = env.DISCORD_APPLICATION_ID;
  const guild = values.guild;
  const commands = discordCommands.filter(command => !values['collector-only'] || command.name === 'telemetry').map(command => ({ ...command, ...(guild === undefined ? { integration_types: [0], contexts: [0] } : {}) }));
  if (guild !== undefined && !/^\d{17,20}$/.test(guild)) throw new Error('--guildにはサーバーIDを指定してください。');
  if (values['dry-run']) { console.log(JSON.stringify({ scope: guild ? 'guild' : 'global', commands }, null, 2)); return; }
  if (!application || !/^\d{17,20}$/.test(application)) throw new Error('DISCORD_APPLICATION_IDを設定してください。');
  if (!env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKENを設定してください。');
  const path = `applications/${application}${guild ? `/guilds/${guild}` : ''}/commands`;
  for (const command of commands) {
    const response = await fetch(`https://discord.com/api/v10/${path}`, {
      method: 'POST', headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`/${command.name} の登録に失敗しました（HTTP ${response.status}）。Application ID・Bot Token・サーバーへのインストールを確認してください。`);
    console.log(`/${command.name} を${guild ? '指定サーバー' : 'グローバル'}に登録しました。`);
  }
  if (!guild) console.log('以後、招待先ごとの登録操作は不要です。下のURLからサーバーへ招待してください。');
  console.log(`インストールURL: https://discord.com/oauth2/authorize?client_id=${application}&scope=bot%20applications.commands&permissions=0${guild ? `&guild_id=${guild}` : ''}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'コマンド登録に失敗しました。'); process.exitCode = 1; });
