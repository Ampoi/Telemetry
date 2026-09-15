CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  state_hash TEXT UNIQUE,
  browser_hash TEXT,
  verifier TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  encrypted_refresh_token TEXT NOT NULL,
  connected_at INTEGER NOT NULL
);
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL
);
