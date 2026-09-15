CREATE TABLE guild_meeting_settings (
  guild_id TEXT PRIMARY KEY,
  center_days INTEGER NOT NULL DEFAULT 7 CHECK(center_days BETWEEN 1 AND 365),
  radius_days INTEGER NOT NULL DEFAULT 2 CHECK(radius_days BETWEEN 0 AND 14),
  channel_id TEXT,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(center_days-radius_days >= 1 AND center_days+radius_days <= 365)
);
