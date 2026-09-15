-- Pin redeliveries to the originally selected meeting, even after a newer MTG.
CREATE TABLE meeting_done_requests (
  id TEXT PRIMARY KEY,
  guild TEXT NOT NULL,
  meeting_id TEXT NOT NULL
);
