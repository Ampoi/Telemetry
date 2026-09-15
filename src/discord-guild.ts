import { AppError } from './errors';

export function guildOwner(guildId: string): string {
  return `discord:guild:${guildId}`;
}

export function requireGuildManager(interaction: { guild_id?: string; member?: { permissions?: string; user?: { id: string } } }): string {
  const guild = interaction.guild_id;
  if (!guild || !/^\d{17,20}$/.test(guild) || !interaction.member?.user) {
    throw new AppError(403, 'このコマンドはDiscordサーバー内で実行してください。');
  }
  const permissions = interaction.member.permissions ?? '';
  if (!/^\d+$/.test(permissions) || (BigInt(permissions) & (32n | 8n)) === 0n) {
    throw new AppError(403, 'Google連携の認証・ドキュメント設定・作成にはサーバー管理権限が必要です。');
  }
  return guild;
}
