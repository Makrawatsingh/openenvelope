import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT,
  api_key_hash TEXT UNIQUE NOT NULL, is_admin INTEGER DEFAULT 0,
  settings TEXT DEFAULT '{}', last_digest_at INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'reserved', subject TEXT, recipients TEXT DEFAULT '[]',
  thread_id TEXT, message_id TEXT, campaign_id TEXT, contact_email TEXT, data TEXT,
  html TEXT, send_error TEXT,
  created_at INTEGER NOT NULL, sent_at INTEGER, remind_at INTEGER, reminder_sent INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0, first_open_at INTEGER, last_open_at INTEGER,
  self_view_until INTEGER DEFAULT 0, hot_alerted_at INTEGER DEFAULT 0,
  remind_mode TEXT DEFAULT 'no_open', replied_at INTEGER
);
CREATE INDEX IF NOT EXISTS emails_user ON emails(user_id, created_at);
CREATE INDEX IF NOT EXISTS emails_campaign ON emails(campaign_id);
CREATE TABLE IF NOT EXISTS links (
  email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  url TEXT NOT NULL, kind TEXT DEFAULT 'link', click_count INTEGER DEFAULT 0, PRIMARY KEY (email_id, idx)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, email_id TEXT, ref_id TEXT, contact_email TEXT, ts INTEGER NOT NULL,
  ip TEXT, ua TEXT, device TEXT, client TEXT, country TEXT, via_proxy INTEGER DEFAULT 0, meta TEXT
);
CREATE INDEX IF NOT EXISTS events_user ON events(user_id, id);
CREATE INDEX IF NOT EXISTS events_email ON events(email_id);
CREATE TABLE IF NOT EXISTS contacts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL, name TEXT,
  notes TEXT DEFAULT '', lists TEXT DEFAULT '[]', unsubscribed INTEGER DEFAULT 0, do_not_track INTEGER DEFAULT 0,
  bounced INTEGER DEFAULT 0, created_at INTEGER NOT NULL, last_activity_at INTEGER, PRIMARY KEY (user_id, email)
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT,
  subject_tpl TEXT, body_tpl TEXT, send_via TEXT DEFAULT 'gmail', status TEXT DEFAULT 'draft',
  schedule_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT, subject TEXT, body TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  name TEXT, mime TEXT, path TEXT NOT NULL, bytes INTEGER, sha256 TEXT, password_hash TEXT,
  expires_at INTEGER, watermark TEXT, allow_download INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_views (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, viewer TEXT,
  started_at INTEGER NOT NULL, last_ping_at INTEGER, total_seconds REAL DEFAULT 0, pages TEXT DEFAULT '{}',
  ip TEXT, ua TEXT
);
CREATE TABLE IF NOT EXISTS sign_requests (
  id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, signer_name TEXT, signer_email TEXT,
  status TEXT DEFAULT 'pending', created_at INTEGER NOT NULL, viewed_at INTEGER, signed_at INTEGER,
  signed_path TEXT, signed_sha256 TEXT, audit TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question TEXT, options TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE, option_idx INTEGER NOT NULL,
  voter TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (poll_id, voter)
);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

// Small helpers so route code stays readable.
export function q(db) {
  return {
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
  };
}
