CREATE TABLE IF NOT EXISTS trackers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_code TEXT NOT NULL,
  to_name TEXT NOT NULL,
  to_code TEXT NOT NULL,
  dates_json TEXT NOT NULL,
  types_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  tracker_id INTEGER NOT NULL,
  travel_date TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (tracker_id, travel_date, fingerprint)
);

CREATE TABLE IF NOT EXISTS user_states (
  chat_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trackers_active_checked ON trackers(active, last_checked_at);
CREATE INDEX IF NOT EXISTS idx_trackers_chat_active ON trackers(chat_id, active);
