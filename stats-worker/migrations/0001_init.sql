-- Dobby opt-in stats. No IP, no header, no free text: every column is a value from src/stats-schema.ts.
CREATE TABLE IF NOT EXISTS events (
  day     TEXT NOT NULL,
  install TEXT NOT NULL,
  name    TEXT NOT NULL,
  props   TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS events_once ON events (day, install, name, props);
CREATE INDEX IF NOT EXISTS events_name_day ON events (name, day);

CREATE TABLE IF NOT EXISTS crashes (
  day     TEXT NOT NULL,
  install TEXT NOT NULL,
  kind    TEXT NOT NULL,
  "where" TEXT NOT NULL,
  command TEXT NOT NULL,
  code    TEXT,
  v       TEXT NOT NULL,
  os      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crashes_day ON crashes (day);
CREATE INDEX IF NOT EXISTS crashes_kind ON crashes (kind, "where");

CREATE TABLE IF NOT EXISTS quota (
  day     TEXT NOT NULL,
  install TEXT NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  crashes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, install)
);
