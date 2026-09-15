ALTER TABLE credentials ADD COLUMN email TEXT;
CREATE TABLE discord_profile_sync (
  guild_id TEXT PRIMARY KEY,
  bio_hash TEXT,
  synced_at INTEGER,
  error TEXT
);
