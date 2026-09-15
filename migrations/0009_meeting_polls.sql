CREATE TABLE meeting_polls (
  id TEXT PRIMARY KEY,
  guild TEXT NOT NULL,
  user TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX meeting_polls_guild ON meeting_polls(guild, created DESC);
CREATE TABLE meeting_oauth (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  poll TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE meeting_sessions (
  token_hash TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  name TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX meeting_sessions_expiry ON meeting_sessions(expires);
