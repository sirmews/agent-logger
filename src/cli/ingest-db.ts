import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

/**
 * Initializes and returns a SQLite database connection for Codex ingesting.
 * Recursively creates parent directories of dbPath if they do not exist.
 * Executes WAL pragma, enables foreign keys, sets a busy timeout, and provisions tables.
 */
export function getIngestDb(dbPath: string): Database {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Set SQLite pragmas & busy timeout
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");

  // Provision schema tables within a transaction for safety and reliability
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_sessions (
        session_id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        agent_name TEXT,
        model_provider TEXT,
        model_id TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        finish_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_tool_calls (
        call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_args TEXT, -- JSON-stringified payload
        output TEXT,     -- Truncated to 200KB max
        status TEXT,     -- 'pending' | 'completed' | 'error'
        start_time INTEGER,
        end_time INTEGER,
        duration_ms INTEGER,
        inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_codex_messages_session ON codex_messages(session_id);
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_codex_tool_calls_session ON codex_tool_calls(session_id);
    `);
  })();

  return db;
}
