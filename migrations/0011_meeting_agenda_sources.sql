-- Imported history stays separate from live collection and keeps its real guild.
CREATE TABLE meeting_agenda_archives (
  id TEXT PRIMARY KEY, source_guild TEXT NOT NULL, project TEXT NOT NULL,
  range_from INTEGER NOT NULL, range_to INTEGER NOT NULL, imported INTEGER NOT NULL
);
CREATE TABLE meeting_agenda_posts (
  archive TEXT NOT NULL, id TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(archive,id), FOREIGN KEY(archive) REFERENCES meeting_agenda_archives(id)
);
CREATE TABLE meeting_agenda_sources (
  guild TEXT PRIMARY KEY, archive TEXT NOT NULL,
  FOREIGN KEY(archive) REFERENCES meeting_agenda_archives(id)
);
