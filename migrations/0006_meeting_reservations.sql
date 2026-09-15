-- The Durable Object is authoritative for execution and cancellation.
-- D1 indexes reservations by guild for the Discord status command.
CREATE TABLE meeting_reservations (
  id TEXT PRIMARY KEY,
  guild TEXT NOT NULL,
  user TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  document TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX meeting_reservations_guild ON meeting_reservations(guild, run_at DESC);
