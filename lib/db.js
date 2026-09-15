// Base de datos local SQLite (self-hosted, sin servicios externos).
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";

if (!existsSync("data")) mkdirSync("data", { recursive: true });

const db = new Database("data/pdfstudio.db");
db.pragma("journal_mode = WAL");

// Migraciones (idempotentes).
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

export default db;
