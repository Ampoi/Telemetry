export async function ensureRecovery(env: Env, guild: string): Promise<void> {
  await env.COLLECTION_RECOVERY.getByName(guild).arm(guild);
}
