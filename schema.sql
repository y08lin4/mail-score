CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  recipient_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  received_at INTEGER,
  analyzed_at INTEGER,
  object_key TEXT,
  envelope_from TEXT,
  subject TEXT,
  report_json TEXT
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status, expires_at);
