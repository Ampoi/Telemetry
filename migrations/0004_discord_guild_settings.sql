-- URLs belong to a Discord server. Existing personal credentials stay private.
-- each server must explicitly connect its Google account again.
CREATE TABLE discord_guild_settings (
  guild_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Old login links have no server context and must not complete after migration.
UPDATE auth_requests SET status = 'failed', verifier = ''
WHERE owner LIKE 'discord:%' AND status IN ('pending', 'authorizing', 'exchanging');
