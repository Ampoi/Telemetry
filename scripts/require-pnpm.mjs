const agent = process.env.npm_config_user_agent ?? '';
if (!/^pnpm\//.test(agent)) {
  console.error('このプロジェクトはpnpm必須です。pnpm install を使用してください。');
  process.exit(1);
}
