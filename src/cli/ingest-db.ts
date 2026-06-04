import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

/**
 * Initializes and returns a SQLite database with the v1 capture contract schema.
 * Applies additive migrations for existing databases.
 */
export function getIngestDb(dbPath: string): Database {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);

  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        session_source TEXT,
        permission_mode TEXT,
        transcript_path TEXT,
        git_root TEXT,
        git_branch TEXT,
        git_commit TEXT,
        git_dirty INTEGER,
        git_remote_url TEXT,
        stop_hook_active INTEGER,
        git_end_branch TEXT,
        git_end_commit TEXT,
        git_end_dirty INTEGER,
        changed_files_json TEXT
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        turn_id TEXT,
        FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_tool_calls (
        call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_args TEXT,
        output TEXT,
        status TEXT,
        start_time INTEGER,
        end_time INTEGER,
        duration_ms INTEGER,
        inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        turn_id TEXT,
        exit_code INTEGER,
        truncation_meta TEXT,
        FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_permission_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        turn_id TEXT,
        permission_mode TEXT,
        agent_id TEXT,
        agent_type TEXT,
        timestamp INTEGER NOT NULL,
        inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_compact_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        turn_id TEXT,
        reason TEXT,
        timestamp INTEGER NOT NULL,
        inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS codex_subagent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        subagent_id TEXT,
        parent_turn_id TEXT,
        agent_type TEXT,
        timestamp INTEGER NOT NULL,
        inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
      );
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_codex_messages_session ON codex_messages(session_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_codex_tool_calls_session ON codex_tool_calls(session_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_codex_permission_requests_session ON codex_permission_requests(session_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_codex_compact_events_session ON codex_compact_events(session_id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_codex_subagent_events_session ON codex_subagent_events(session_id);`);
  })();

  migrateAdditive(db);

  return db;
}

const VALID_TABLES = new Set([
  "codex_sessions",
  "codex_messages",
  "codex_tool_calls",
  "codex_permission_requests",
  "codex_compact_events",
  "codex_subagent_events",
]);

const VALID_COLUMNS = new Set([
  "session_source",
  "permission_mode",
  "transcript_path",
  "git_root",
  "git_branch",
  "git_commit",
  "git_dirty",
  "git_remote_url",
  "stop_hook_active",
  "git_end_branch",
  "git_end_commit",
  "git_end_dirty",
  "changed_files_json",
  "turn_id",
  "exit_code",
  "truncation_meta",
]);

const VALID_TYPES = new Set(["TEXT", "INTEGER"]);

function columnExists(db: Database, table: string, column: string): boolean {
  if (!VALID_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

function tableExists(db: Database, table: string): boolean {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").all(table) as { name: string }[];
  return rows.length > 0;
}

function migrateAdditive(db: Database): void {
  db.transaction(() => {
    const addColumn = (table: string, column: string, type: string) => {
      if (!VALID_TABLES.has(table)) {
        throw new Error(`Invalid table name: ${table}`);
      }
      if (!VALID_COLUMNS.has(column)) {
        throw new Error(`Invalid column name: ${column}`);
      }
      if (!VALID_TYPES.has(type)) {
        throw new Error(`Invalid column type: ${type}`);
      }
      if (!columnExists(db, table, column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
      }
    };

    addColumn("codex_sessions", "session_source", "TEXT");
    addColumn("codex_sessions", "permission_mode", "TEXT");
    addColumn("codex_sessions", "transcript_path", "TEXT");
    addColumn("codex_sessions", "git_root", "TEXT");
    addColumn("codex_sessions", "git_branch", "TEXT");
    addColumn("codex_sessions", "git_commit", "TEXT");
    addColumn("codex_sessions", "git_dirty", "INTEGER");
    addColumn("codex_sessions", "git_remote_url", "TEXT");
    addColumn("codex_sessions", "stop_hook_active", "INTEGER");
    addColumn("codex_sessions", "git_end_branch", "TEXT");
    addColumn("codex_sessions", "git_end_commit", "TEXT");
    addColumn("codex_sessions", "git_end_dirty", "INTEGER");
    addColumn("codex_sessions", "changed_files_json", "TEXT");

    addColumn("codex_messages", "turn_id", "TEXT");

    addColumn("codex_tool_calls", "turn_id", "TEXT");
    addColumn("codex_tool_calls", "exit_code", "INTEGER");
    addColumn("codex_tool_calls", "truncation_meta", "TEXT");

    if (!tableExists(db, "codex_permission_requests")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS codex_permission_requests (
          request_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tool_name TEXT,
          tool_input TEXT,
          turn_id TEXT,
          permission_mode TEXT,
          agent_id TEXT,
          agent_type TEXT,
          timestamp INTEGER NOT NULL,
          inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_codex_permission_requests_session ON codex_permission_requests(session_id);`);
    }

    if (!tableExists(db, "codex_compact_events")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS codex_compact_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          turn_id TEXT,
          reason TEXT,
          timestamp INTEGER NOT NULL,
          inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_codex_compact_events_session ON codex_compact_events(session_id);`);
    }

    if (!tableExists(db, "codex_subagent_events")) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS codex_subagent_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          subagent_id TEXT,
          parent_turn_id TEXT,
          agent_type TEXT,
          timestamp INTEGER NOT NULL,
          inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_codex_subagent_events_session ON codex_subagent_events(session_id);`);
    }
  })();
}
