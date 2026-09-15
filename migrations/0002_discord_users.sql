ALTER TABLE auth_requests ADD COLUMN owner TEXT NOT NULL DEFAULT 'default';
CREATE TABLE credentials_by_user (
  id TEXT PRIMARY KEY,
  encrypted_refresh_token TEXT NOT NULL,
  connected_at INTEGER NOT NULL
);
INSERT INTO credentials_by_user SELECT * FROM credentials;
DROP TABLE credentials;
ALTER TABLE credentials_by_user RENAME TO credentials;
-- Preserve CLI operation history while namespacing future Discord operations.
UPDATE operations SET id = 'default:' || id;
