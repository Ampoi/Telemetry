CREATE TABLE collector_commands (
  id TEXT PRIMARY KEY,
  guild TEXT NOT NULL,
  user TEXT NOT NULL,
  kind TEXT NOT NULL,
  days INTEGER,
  encrypted TEXT NOT NULL,
  expires INTEGER NOT NULL,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX collector_commands_pending ON collector_commands(guild, delivered, expires);
