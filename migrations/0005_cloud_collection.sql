-- Cloud storage is independent of the local collector schema.
CREATE TABLE cloud_guilds (
  guild TEXT PRIMARY KEY, bot_id TEXT NOT NULL, config TEXT NOT NULL, started INTEGER NOT NULL
);
CREATE TABLE cloud_channels (
  guild TEXT NOT NULL, channel TEXT NOT NULL, parent TEXT, name TEXT NOT NULL,
  kind INTEGER NOT NULL, department TEXT, scanned_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(guild, channel), FOREIGN KEY(guild) REFERENCES cloud_guilds(guild)
);
CREATE TABLE cloud_tasks (
  id TEXT PRIMARY KEY, guild TEXT NOT NULL, channel TEXT, kind TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', generation INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
  FOREIGN KEY(guild) REFERENCES cloud_guilds(guild)
);
CREATE UNIQUE INDEX cloud_task_active ON cloud_tasks(guild, channel, kind)
  WHERE status IN ('pending','running') AND kind IN ('scan','discover','verify');
CREATE INDEX cloud_task_due ON cloud_tasks(status,due,lease_until);
CREATE TABLE cloud_messages (
  guild TEXT NOT NULL, id TEXT NOT NULL, channel TEXT NOT NULL, created TEXT NOT NULL,
  revision TEXT NOT NULL, observed INTEGER NOT NULL, data TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(guild,id)
);
CREATE INDEX cloud_message_export ON cloud_messages(guild,created,id);
CREATE INDEX cloud_message_verify ON cloud_messages(guild,channel,deleted,verified,created);
CREATE TABLE cloud_attachments (
  guild TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL, channel TEXT NOT NULL,
  data TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  storage_key TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_start INTEGER NOT NULL DEFAULT 0, reason TEXT,
  PRIMARY KEY(guild,id), FOREIGN KEY(guild,message) REFERENCES cloud_messages(guild,id)
);
CREATE INDEX cloud_attachment_pending ON cloud_attachments(status,guild);
CREATE TABLE cloud_cleanup (storage_key TEXT PRIMARY KEY);
CREATE TABLE cloud_exports (
  id TEXT PRIMARY KEY, guild TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', parts INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
CREATE TABLE cloud_export_parts (
  export_id TEXT NOT NULL, part INTEGER NOT NULL, storage_key TEXT NOT NULL, records INTEGER NOT NULL,
  PRIMARY KEY(export_id,part), FOREIGN KEY(export_id) REFERENCES cloud_exports(id)
);
CREATE TABLE cloud_controls (
  id TEXT PRIMARY KEY, guild TEXT NOT NULL, result TEXT NOT NULL
);
ALTER TABLE cloud_cleanup ADD COLUMN due INTEGER NOT NULL DEFAULT 0;
