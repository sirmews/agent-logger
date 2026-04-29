/**
 * OpenCode Communication Logger Plugin
 *
 * Captures session lifecycle, message turns, tool calls, and metadata into
 * a local SQLite database for offline analysis and SFT training-data export.
 */

import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "fs";

const DEFAULT_DB_PATH = resolve(
  join(homedir(), ".local", "share", "opencode", "communication-logs.db"),
);
const DEFAULT_DB_PATH_HUMAN = "~/.local/share/opencode/communication-logs.db";
const DB_PATH = resolveDbPath();
const SCHEMA_VERSION = 3;
const DB_DIR_MODE = 0o700;
const DB_FILE_MODE = 0o600;
const DEFAULT_QUALITY_PROFILE = "default";
const QUALITY_CANDIDATE_MULTIPLIER = 4;
const MIN_QUALITY_CANDIDATES = 80;

type QualityProfile = {
  name: string;
  minimumTurns: number;
  allowNoToolTasks: boolean;
  weights: {
    efficiency: number;
    taskSuccess: number;
    toolQuality: number;
    conversationDepth: number;
    toolDiversity: number;
    systemContext: number;
  };
};

const QUALITY_PROFILES: Record<string, QualityProfile> = {
  default: {
    name: "default",
    minimumTurns: 2,
    allowNoToolTasks: true,
    weights: {
      efficiency: 0.35,
      taskSuccess: 0.24,
      toolQuality: 0.22,
      conversationDepth: 0.12,
      toolDiversity: 0.04,
      systemContext: 0.03,
    },
  },
  conservative: {
    name: "conservative",
    minimumTurns: 3,
    allowNoToolTasks: false,
    weights: {
      efficiency: 0.28,
      taskSuccess: 0.32,
      toolQuality: 0.22,
      conversationDepth: 0.12,
      toolDiversity: 0.04,
      systemContext: 0.02,
    },
  },
  permissive: {
    name: "permissive",
    minimumTurns: 1,
    allowNoToolTasks: true,
    weights: {
      efficiency: 0.15,
      taskSuccess: 0.2,
      toolQuality: 0.2,
      conversationDepth: 0.1,
      toolDiversity: 0.05,
      systemContext: 0.01,
    },
  },
};

type QualitySignal = {
  efficiencyScore: number;
  taskSuccess: boolean;
  toolTotal: number;
  toolCompleted: number;
  toolErrors: number;
  toolDurationMs: number;
  uniqueToolCount: number;
  userMessages: number;
  assistantMessages: number;
  hasSystemPrompt: boolean;
};

/**
 * Resolves the database path from environment variables.
 * @param env - The process environment.
 * @returns The absolute path to the SQLite database.
 */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.AGENT_LOGGER_DB_PATH ??
      env.COMMUNICATION_LOGGER_DB_PATH ??
      env.OPENCODE_COMMUNICATION_LOGGER_DB_PATH ??
      DEFAULT_DB_PATH,
  );
}

type SecretPattern = {
  kind: string;
  regex: RegExp;
};

const SECRET_PATTERNS_MINIMAL: SecretPattern[] = [
  { kind: "OPENAI_KEY", regex: /sk-[A-Za-z0-9]{20,}/g },
  { kind: "JWT", regex: /eyJ[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+/g },
];

const SECRET_PATTERNS_STANDARD: SecretPattern[] = [
  ...SECRET_PATTERNS_MINIMAL,
  { kind: "BEARER", regex: /Bearer\s+[A-Za-z0-9._-]+/gi },
  { kind: "AWS", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "GITHUB", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { kind: "GOOGLE", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

const SECRET_PATTERNS_STRICT: SecretPattern[] = [
  ...SECRET_PATTERNS_STANDARD,
  { kind: "UUID", regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
  { kind: "GENERIC_HASH", regex: /\b[a-f0-9]{32,}\b/gi },
];

/**
 * Returns the list of tiered redaction patterns based on the current preset.
 * @returns An array of secret patterns.
 */
export function getBuiltinRedactionPatterns(): SecretPattern[] {
  const preset = (process.env.AGENT_LOGGER_REDACTION_PRESET || "standard").toLowerCase();
  switch (preset) {
    case "minimal":
      return SECRET_PATTERNS_MINIMAL;
    case "strict":
      return SECRET_PATTERNS_STRICT;
    case "standard":
    default:
      return SECRET_PATTERNS_STANDARD;
  }
}

/**
 * Parses extra redaction patterns from a semicolon-separated string.
 * @param raw - The raw string of patterns.
 * @returns An array of parsed secret patterns.
 */
export function getExtraRedactionPatterns(raw?: string): SecretPattern[] {
  if (!raw) return [];
  return parseExtraRedactionPatterns(raw).patterns;
}

/**
 * Parses and validates extra redaction patterns.
 * @param raw - The raw string of patterns.
 * @returns An object containing valid patterns and invalid ones.
 */
export function parseExtraRedactionPatterns(raw?: string): {
  patterns: SecretPattern[];
  invalidPatterns: string[];
} {
  if (!raw) return { patterns: [], invalidPatterns: [] };

  const additions: SecretPattern[] = [];
  const invalidPatterns: string[] = [];
  for (const pattern of raw.split(";")) {
    const patternText = pattern.trim();
    if (!patternText) continue;
    try {
      additions.push({
        kind: "CUSTOM",
        regex: new RegExp(patternText, "g"),
      });
    } catch {
      invalidPatterns.push(patternText);
    }
  }

  return { patterns: additions, invalidPatterns };
}

function ensureDatabaseStorage(dbPath: string): void {
  const dbDir = dirname(dbPath);
  try {
    mkdirSync(dbDir, { recursive: true, mode: DB_DIR_MODE });
    chmodSync(dbDir, DB_DIR_MODE);
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code !== "EEXIST") {
      throw new Error(`Failed to prepare DB directory ${dbPath}: ${String(error)}`);
    }
  }

  try {
    if (!existsSync(dbPath)) {
      const fd = openSync(dbPath, "wx", DB_FILE_MODE);
      closeSync(fd);
      return;
    }
    chmodSync(dbPath, DB_FILE_MODE);
  } catch (error) {
    const e = error as { code?: string } | undefined;
    if (e?.code === "EEXIST") {
      chmodSync(dbPath, DB_FILE_MODE);
      return;
    }
    if (e?.code === "EACCES") {
      throw new Error(
        `Cannot secure DB file ${dbPath}; check file ownership and permissions`,
      );
    }
    throw new Error(`Failed to prepare DB file ${dbPath}: ${String(error)}`);
  }
}

function openDb(dbPath: string = DB_PATH): Database {
  ensureDatabaseStorage(dbPath);
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF"); // we tolerate orphan rows on prune
  return db;
}

function migrate(db: Database): void {
  const runMigrations = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
      | { v: number | null }
      | undefined;
    const current = row?.v ?? 0;

    if (current < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          project_name TEXT,
          directory TEXT,
          agent TEXT,
          model_provider TEXT,
          model_id TEXT,
          system_prompt TEXT,
          title TEXT,
          start_time INTEGER NOT NULL,
          end_time INTEGER,
          last_status TEXT,
          lifecycle TEXT NOT NULL DEFAULT 'created',
          finish_reason TEXT,
          total_cost REAL DEFAULT 0,
          total_input_tokens INTEGER DEFAULT 0,
          total_output_tokens INTEGER DEFAULT 0,
          total_reasoning_tokens INTEGER DEFAULT 0,
          total_messages INTEGER DEFAULT 0,
          total_tool_calls INTEGER DEFAULT 0,
          error_count INTEGER DEFAULT 0,
          last_error JSON,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          agent TEXT,
          model_provider TEXT,
          model_id TEXT,
          parent_message_id TEXT,
          finish_reason TEXT,
          cost REAL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_tokens INTEGER,
          cache_read INTEGER,
          cache_write INTEGER,
          created_ts INTEGER,
          completed_ts INTEGER,
          error_payload JSON,
          raw_info JSON,
          inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS message_parts (
          part_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          part_type TEXT NOT NULL,
          seq INTEGER,
          text TEXT,
          tool_name TEXT,
          tool_call_id TEXT,
          tool_status TEXT,
          tool_input JSON,
          tool_output TEXT,
          tool_error TEXT,
          tool_metadata JSON,
          start_ts INTEGER,
          end_ts INTEGER,
          raw_part JSON,
          updated_ts INTEGER,
          inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS tool_call_hooks (
          call_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          args JSON,
          output TEXT,
          metadata JSON,
          title TEXT,
          start_ts INTEGER,
          end_ts INTEGER,
          duration_ms INTEGER,
          inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS chat_params (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          agent TEXT,
          model_provider TEXT,
          model_id TEXT,
          temperature REAL,
          top_p REAL,
          top_k INTEGER,
          max_output_tokens INTEGER,
          options JSON,
          timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS permissions (
          permission_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          permission_type TEXT,
          patterns JSON,
          metadata JSON,
          message_id TEXT,
          call_id TEXT,
          status TEXT NOT NULL,
          asked_ts INTEGER,
          replied_ts INTEGER
        );

        CREATE TABLE IF NOT EXISTS file_edits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS commands (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          message_id TEXT,
          command_name TEXT NOT NULL,
          arguments TEXT,
          timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS training_examples (
          session_id TEXT PRIMARY KEY,
          task_success INTEGER,
          has_error INTEGER,
          efficiency_score REAL,
          total_duration_ms INTEGER,
          tool_count INTEGER,
          tool_names JSON,
          finish_reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session       ON messages(session_id, created_ts);
        CREATE INDEX IF NOT EXISTS idx_message_parts_message  ON message_parts(message_id);
        CREATE INDEX IF NOT EXISTS idx_message_parts_session  ON message_parts(session_id);
        CREATE INDEX IF NOT EXISTS idx_message_parts_tool_call ON message_parts(tool_call_id);
        CREATE INDEX IF NOT EXISTS idx_tool_hooks_session     ON tool_call_hooks(session_id, start_ts);
        CREATE INDEX IF NOT EXISTS idx_chat_params_session    ON chat_params(session_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_permissions_session    ON permissions(session_id);
        CREATE INDEX IF NOT EXISTS idx_commands_session       ON commands(session_id);
        CREATE INDEX IF NOT EXISTS idx_training_efficiency    ON training_examples(efficiency_score);
        CREATE INDEX IF NOT EXISTS idx_training_success       ON training_examples(task_success);
      `);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    }

    if (current < 2) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_diffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          additions INTEGER DEFAULT 0,
          deletions INTEGER DEFAULT 0,
          status TEXT,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_diffs_session ON session_diffs(session_id);
      `);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(2);
    }

    if (current < 3) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_quality (
          session_id TEXT NOT NULL,
          profile_name TEXT NOT NULL,
          quality_score REAL NOT NULL,
          quality_profile TEXT NOT NULL,
          quality_components JSON NOT NULL,
          quality_blockers JSON,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (session_id, profile_name),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_quality_profile_score ON session_quality(profile_name, quality_score);
        CREATE INDEX IF NOT EXISTS idx_session_quality_session ON session_quality(session_id);
      `);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(3);
    }
  });

  runMigrations();
}

const MAX_TOOL_OUTPUT_BYTES = 200_000;

function truncateString(s: string | null | undefined, max = MAX_TOOL_OUTPUT_BYTES): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n\n---TRUNCATED---";
}

function jsonOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function safeStr(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Retrieves a quality profile by name, or the default profile if not found.
 * @param profileName - The name of the profile to retrieve.
 * @returns The quality profile configuration.
 */
export function getQualityProfile(profileName?: string): QualityProfile {
  const normalized = normalizeQualityProfile(profileName);
  return QUALITY_PROFILES[normalized];
}

function normalizeQualityProfile(profileName?: string): string {
  const requested = profileName?.trim().toLowerCase();
  if (requested && QUALITY_PROFILES[requested]) return requested;

  const envProfile = process.env.AGENT_LOGGER_QUALITY_PROFILE?.trim().toLowerCase();
  if (envProfile && QUALITY_PROFILES[envProfile]) return envProfile;

  return DEFAULT_QUALITY_PROFILE;
}

/**
 * Evaluates a session against a quality rubric to determine its suitability for a training corpus.
 * @param signal - The quality signals extracted from the session.
 * @param profileName - The name of the profile to use for evaluation.
 * @returns The evaluation results including score, components, and blockers.
 */
export function evaluateSessionForCorpusQuality(
  signal: QualitySignal,
  profileName?: string,
): {
  profileName: string;
  score: number;
  components: {
    efficiency: number;
    taskSuccess: number;
    toolQuality: number;
    conversationDepth: number;
    toolDiversity: number;
    systemContext: number;
    penalty: number;
  };
  blockers: string[];
  rationale: string;
} {
  const profile = getQualityProfile(profileName);
  const blockers: string[] = [];

  const turnCount = signal.userMessages + signal.assistantMessages;
  if (turnCount < profile.minimumTurns) {
    blockers.push(`conversation_too_short_${turnCount}`);
  }
  if (!profile.allowNoToolTasks && signal.toolTotal === 0) {
    blockers.push("tool_calls_expected");
  }

  const efficiencySignal = signal.efficiencyScore;
  const taskSignal = signal.taskSuccess ? 1 : 0.25;

  const toolCompletionRate =
    signal.toolTotal === 0
      ? profile.allowNoToolTasks
        ? 0.9
        : 0
      : signal.toolCompleted / signal.toolTotal;
  const toolErrorRate = signal.toolTotal === 0 ? 0 : signal.toolErrors / signal.toolTotal;
  const qualityToolSignal = toolCompletionRate * (1 - Math.min(toolErrorRate, 0.85));

  const avgToolDurationMs = signal.toolTotal === 0 ? 0 : signal.toolDurationMs / signal.toolTotal;
  let durationSignal = 1;
  if (avgToolDurationMs > 120_000) durationSignal = 0.35;
  else if (avgToolDurationMs > 60_000) durationSignal = 0.55;
  else if (avgToolDurationMs > 20_000) durationSignal = 0.7;
  else if (avgToolDurationMs > 10_000) durationSignal = 0.85;

  const conversationSignal = Math.min(1, (turnCount + 1) / 4);
  const diversitySignal = Math.min(1, (signal.uniqueToolCount + 1) / 4);
  const contextSignal = signal.hasSystemPrompt ? 1 : 0.75;

  const penalty = blockers.length === 0 ? 1 : Math.max(0.35, 1 - 0.12 * blockers.length);

  const components = {
    efficiency: efficiencySignal * profile.weights.efficiency,
    taskSuccess: taskSignal * profile.weights.taskSuccess,
    toolQuality: qualityToolSignal * durationSignal * profile.weights.toolQuality,
    conversationDepth: conversationSignal * profile.weights.conversationDepth,
    toolDiversity: diversitySignal * profile.weights.toolDiversity,
    systemContext: contextSignal * profile.weights.systemContext,
    penalty,
  };

  const score = Math.max(
    0.01,
    Math.min(
      1,
      Object.entries(components).reduce((sum, entry) => {
        const [key, value] = entry;
        return key === "penalty" ? sum : sum + value;
      }, 0) * penalty,
    ),
  );

  const rationale = [
    `profile=${profile.name}`,
    `turns=${turnCount}`,
    `tools=${signal.toolTotal}`,
    `tool_errors=${signal.toolErrors}`,
    `task_success=${signal.taskSuccess}`,
    `score=${score.toFixed(3)}`,
  ].join(";");

  return {
    profileName: profile.name,
    score,
    components,
    blockers,
    rationale,
  };
}

function getRedactionPatterns(): SecretPattern[] {
  const extra = process.env.AGENT_LOGGER_EXTRA_REDACTION_PATTERNS;
  const additions = getExtraRedactionPatterns(extra);
  const base = getBuiltinRedactionPatterns();
  if (!additions.length) return base;
  return [...base, ...additions];
}

export type RedactionState = {
  seen: Map<string, string>;
  counters: Record<string, number>;
};

/**
 * Initializes a new redaction state.
 * @returns An empty redaction state.
 */
export function createRedactionState(): RedactionState {
  return {
    seen: new Map(),
    counters: {},
  };
}

/**
 * Redacts secrets from a payload using the provided patterns and state.
 * @param value - The payload to redact.
 * @param state - The current redaction state (for deterministic mapping).
 * @param patterns - The patterns to apply.
 * @returns The redacted payload.
 */
export function redactPayloadForExport(
  value: unknown,
  state: RedactionState,
  patterns: SecretPattern[],
): unknown {
  return redactPayload(value, state, patterns);
}

function redactString(
  input: string,
  state: RedactionState,
  patterns: SecretPattern[],
): string {
  let output = input;
  for (const pattern of patterns) {
    output = output.replace(pattern.regex, (match) => {
      const key = `${pattern.kind}:${match}`;
      let masked = state.seen.get(key);
      if (!masked) {
        const next = (state.counters[pattern.kind] ?? 0) + 1;
        state.counters[pattern.kind] = next;
        masked = `<<REDACTED_${pattern.kind}_${String(next).padStart(3, "0")}>>`;
        state.seen.set(key, masked);
      }
      return masked;
    });
  }
  return output;
}

function redactPayload(
  value: unknown,
  state: RedactionState,
  patterns: SecretPattern[],
): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value, state, patterns);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value.map((item) => redactPayload(item, state, patterns));
  if (typeof value === "object") {
    const entries = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entries)) {
      out[k] = redactPayload(v, state, patterns);
    }
    return out;
  }
  return value;
}

/**
 * Heuristic efficiency score calculation.
 */
export function computeEfficiency(stats: {
  total: number;
  completed: number;
  errors: number;
  totalDurationMs: number;
}): number {
  if (stats.total === 0) return 0.5;

  const successRate = stats.completed / stats.total;
  const errorPenalty = (stats.errors / stats.total) * 0.5;

  const avgDurationMs = stats.totalDurationMs / stats.total;
  let durationScore = 1.0;
  if (avgDurationMs > 30000) durationScore = 0.2;
  else if (avgDurationMs > 15000) durationScore = 0.5;
  else if (avgDurationMs > 5000) durationScore = 0.8;

  const raw = successRate * 0.6 + durationScore * 0.3 - errorPenalty;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Reconstructs a full conversation from message and part rows.
 */
export function buildConversation(
  db: Database,
  sessionID: string,
  systemPrompt: string | null,
): {
  messages: any[];
} {
  const msgs = db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_ts ASC")
    .all(sessionID) as any[];
  const parts = db
    .prepare("SELECT * FROM message_parts WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionID) as any[];

  const messages: any[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const m of msgs) {
    const mParts = parts.filter((p) => p.message_id === m.message_id);
    const contentParts: any[] = [];
    const toolCalls: any[] = [];

    for (const p of mParts) {
      if (p.part_type === "text") {
        contentParts.push({ type: "text", text: p.text });
      } else if (p.part_type === "tool") {
        toolCalls.push({
          id: p.tool_call_id,
          type: "function",
          function: {
            name: p.tool_name,
            arguments: p.tool_input || "{}",
          },
        });
      }
    }

    if (m.role === "assistant") {
      messages.push({
        role: "assistant",
        content: contentParts.length === 1 ? contentParts[0].text : contentParts,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      for (const p of mParts.filter((p) => p.part_type === "tool")) {
        messages.push({
          role: "tool",
          tool_call_id: p.tool_call_id,
          content: p.tool_output || p.tool_error || "",
        });
      }
    } else {
      messages.push({
        role: m.role,
        content: contentParts.length === 1 ? contentParts[0].text : contentParts,
      });
    }
  }

  return { messages };
}

/**
 * Main plugin entry point for CommunicationLogger.
 */
export const CommunicationLoggerPlugin: Plugin = async ({
  directory,
  client,
}: PluginInput) => {
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  migrate(db);

  const projectName = directory.split("/").filter(Boolean).pop() || "unknown";

  const dbWriteMode = (process.env.AGENT_LOGGER_DB_WRITE_MODE || "sync").toLowerCase();
  const rawThreshold = process.env.AGENT_LOGGER_DB_LATENCY_THRESHOLD_MS;
  const dbLatencyThresholdMs = rawThreshold ? (parseInt(rawThreshold, 10) || 50) : 50;

  const log = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ) =>
    client.app.log({
      body: { service: "communication-logger", level, message, extra },
    });

  const instrument = <T>(name: string, fn: () => T): T => {
    if (dbWriteMode !== "sync") return fn();
    const start = performance.now();
    const result = fn();
    const duration = performance.now() - start;
    if (duration > dbLatencyThresholdMs) {
      void log("debug", "Slow DB write detected", {
        operation: name,
        duration_ms: Math.round(duration),
        threshold_ms: dbLatencyThresholdMs,
      });
    }
    return result;
  };

  await log("info", "Communication logger plugin loaded", {
    project: projectName,
    directory,
    dbPath: dbPath,
    schemaVersion: SCHEMA_VERSION,
    dbWriteMode,
  });
  if (dbPath !== DEFAULT_DB_PATH) {
    await log("warn", "Using override database path via environment variable", {
      dbPath,
      defaultDbPath: DEFAULT_DB_PATH_HUMAN,
    });
  }

  const stmt = {
    upsertSession: db.prepare(`
      INSERT INTO sessions (session_id, project_name, directory, title, start_time, lifecycle)
      VALUES (?, ?, ?, ?, ?, 'created')
      ON CONFLICT(session_id) DO UPDATE SET
        project_name = excluded.project_name,
        directory    = excluded.directory,
        title        = COALESCE(excluded.title, sessions.title),
        updated_at   = CURRENT_TIMESTAMP
    `),
    setSessionStatus: db.prepare(`
      UPDATE sessions SET last_status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?
    `),
    setSessionLifecycle: db.prepare(`
      UPDATE sessions SET lifecycle = ?, end_time = COALESCE(?, end_time), updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `),
    bumpSessionError: db.prepare(`
      UPDATE sessions SET error_count = COALESCE(error_count, 0) + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `),
    setSessionSystemPrompt: db.prepare(`
      UPDATE sessions SET system_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?
    `),

    upsertMessage: db.prepare(`
      INSERT INTO messages (
        message_id, session_id, role, agent,
        model_provider, model_id, parent_message_id, finish_reason,
        cost, input_tokens, output_tokens, reasoning_tokens,
        cache_read, cache_write, created_ts, completed_ts,
        error_payload, raw_info
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        role              = excluded.role,
        agent             = COALESCE(excluded.agent, messages.agent),
        model_provider    = COALESCE(excluded.model_provider, messages.model_provider),
        model_id          = COALESCE(excluded.model_id, messages.model_id),
        parent_message_id = COALESCE(excluded.parent_message_id, messages.parent_message_id),
        finish_reason     = COALESCE(excluded.finish_reason, messages.finish_reason),
        cost              = COALESCE(excluded.cost, messages.cost),
        input_tokens      = COALESCE(excluded.input_tokens, messages.input_tokens),
        output_tokens     = COALESCE(excluded.output_tokens, messages.output_tokens),
        reasoning_tokens  = COALESCE(excluded.reasoning_tokens, messages.reasoning_tokens),
        cache_read        = COALESCE(excluded.cache_read, messages.cache_read),
        cache_write       = COALESCE(excluded.cache_write, messages.cache_write),
        completed_ts      = COALESCE(excluded.completed_ts, messages.completed_ts),
        error_payload     = COALESCE(excluded.error_payload, messages.error_payload),
        raw_info          = excluded.raw_info,
        updated_at        = CURRENT_TIMESTAMP
    `),

    upsertPart: db.prepare(`
      INSERT INTO message_parts (
        part_id, message_id, session_id, part_type,
        text, tool_name, tool_call_id, tool_status,
        tool_input, tool_output, tool_error, tool_metadata,
        start_ts, end_ts, raw_part, updated_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(part_id) DO UPDATE SET
        part_type     = excluded.part_type,
        text          = COALESCE(excluded.text, message_parts.text),
        tool_name     = COALESCE(excluded.tool_name, message_parts.tool_name),
        tool_call_id  = COALESCE(excluded.tool_call_id, message_parts.tool_call_id),
        tool_status   = COALESCE(excluded.tool_status, message_parts.tool_status),
        tool_input    = COALESCE(excluded.tool_input, message_parts.tool_input),
        tool_output   = COALESCE(excluded.tool_output, message_parts.tool_output),
        tool_error    = COALESCE(excluded.tool_error, message_parts.tool_error),
        tool_metadata = COALESCE(excluded.tool_metadata, message_parts.tool_metadata),
        start_ts      = COALESCE(excluded.start_ts, message_parts.start_ts),
        end_ts        = COALESCE(excluded.end_ts, message_parts.end_ts),
        raw_part      = excluded.raw_part,
        updated_ts    = excluded.updated_ts
    `),

    insertToolHookBefore: db.prepare(`
      INSERT INTO tool_call_hooks (call_id, session_id, tool_name, args, start_ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(call_id) DO UPDATE SET
        tool_name = excluded.tool_name,
        args      = excluded.args,
        start_ts  = excluded.start_ts
    `),
    updateToolHookAfter: db.prepare(`
      UPDATE tool_call_hooks
      SET output = ?, metadata = ?, title = ?, end_ts = ?, duration_ms = ?
      WHERE call_id = ?
    `),

    insertChatParams: db.prepare(`
      INSERT INTO chat_params (session_id, agent, model_provider, model_id,
                               temperature, top_p, top_k, max_output_tokens, options, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    upsertPermissionAsked: db.prepare(`
      INSERT INTO permissions (permission_id, session_id, permission_type, patterns, metadata,
                               message_id, call_id, status, asked_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'asked', ?)
      ON CONFLICT(permission_id) DO UPDATE SET
        permission_type = excluded.permission_type,
        patterns        = excluded.patterns,
        metadata        = excluded.metadata,
        message_id      = excluded.message_id,
        call_id         = excluded.call_id,
        asked_ts        = excluded.asked_ts
    `),
    updatePermissionReplied: db.prepare(`
      UPDATE permissions SET status = ?, replied_ts = ? WHERE permission_id = ?
    `),

    insertFileEdit: db.prepare(`
      INSERT INTO file_edits (file_path, timestamp) VALUES (?, ?)
    `),

    insertCommand: db.prepare(`
      INSERT INTO commands (session_id, message_id, command_name, arguments, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `),

    insertSessionDiff: db.prepare(`
      INSERT INTO session_diffs (session_id, file_path, additions, deletions, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `),

    upsertSessionQuality: db.prepare(`
      INSERT INTO session_quality (
        session_id,
        profile_name,
        quality_score,
        quality_profile,
        quality_components,
        quality_blockers
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, profile_name) DO UPDATE SET
        quality_score      = excluded.quality_score,
        quality_profile    = excluded.quality_profile,
        quality_components = excluded.quality_components,
        quality_blockers   = excluded.quality_blockers,
        updated_at         = CURRENT_TIMESTAMP
    `),
  };

  const refreshSessionAggregates = db.transaction((sessionID: string) => {
    const agg = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE role IN ('user','assistant'))                   AS total_messages,
        COALESCE(SUM(cost), 0)                                                  AS total_cost,
        COALESCE(SUM(input_tokens), 0)                                          AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0)                                         AS total_output_tokens,
        COALESCE(SUM(reasoning_tokens), 0)                                      AS total_reasoning_tokens
      FROM messages WHERE session_id = ?
    `).get(sessionID) as any;

    const toolAgg = db.prepare(`
      SELECT
        COUNT(*) AS total_tool_calls,
        SUM(CASE WHEN tool_status = 'error' THEN 1 ELSE 0 END) AS error_tool_calls,
        SUM(CASE WHEN tool_status = 'completed' THEN 1 ELSE 0 END) AS completed_tool_calls,
        COALESCE(SUM(CASE WHEN end_ts IS NOT NULL AND start_ts IS NOT NULL
                          THEN end_ts - start_ts ELSE 0 END), 0) AS total_duration_ms
      FROM message_parts
      WHERE session_id = ? AND part_type = 'tool'
    `).get(sessionID) as any;

    db.prepare(`
      UPDATE sessions SET
        total_messages         = ?,
        total_cost             = ?,
        total_input_tokens     = ?,
        total_output_tokens    = ?,
        total_reasoning_tokens = ?,
        total_tool_calls       = ?,
        updated_at             = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(
      agg?.total_messages ?? 0,
      agg?.total_cost ?? 0,
      agg?.total_input_tokens ?? 0,
      agg?.total_output_tokens ?? 0,
      agg?.total_reasoning_tokens ?? 0,
      toolAgg?.total_tool_calls ?? 0,
      sessionID,
    );
  });

  function refreshTrainingExample(sessionID: string): void {
    const getMessageCounts = db.prepare(`
      SELECT
        COUNT(*) AS total_messages,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_messages,
        SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages
      FROM messages
      WHERE session_id = ?
    `).get(sessionID) as
      | {
          total_messages: number | null;
          user_messages: number | null;
          assistant_messages: number | null;
        }
      | undefined;

    const toolStats = db.prepare(`
      SELECT
        COUNT(*) AS total_tools,
        SUM(CASE WHEN tool_status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN tool_status = 'error'     THEN 1 ELSE 0 END) AS errors,
        COALESCE(SUM(CASE WHEN end_ts IS NOT NULL AND start_ts IS NOT NULL
                          THEN end_ts - start_ts ELSE 0 END), 0) AS total_duration_ms
      FROM message_parts WHERE session_id = ? AND part_type = 'tool'
    `).get(sessionID) as any;

    const toolNames = db.prepare(`
      SELECT DISTINCT tool_name FROM message_parts
      WHERE session_id = ? AND part_type = 'tool' AND tool_name IS NOT NULL
    `).all(sessionID).map((r: any) => r.tool_name);

    const systemPrompt = db
      .prepare("SELECT system_prompt FROM sessions WHERE session_id = ?")
      .get(sessionID) as { system_prompt: string | null } | undefined;

    const lastAssistant = db.prepare(`
      SELECT finish_reason, error_payload FROM messages
      WHERE session_id = ? AND role = 'assistant'
      ORDER BY COALESCE(completed_ts, created_ts) DESC
      LIMIT 1
    `).get(sessionID) as any;

    const total = toolStats?.total_tools ?? 0;
    const errors = toolStats?.errors ?? 0;
    const hasError = errors > 0 || lastAssistant?.error_payload != null;
    const taskSuccess = !hasError && (lastAssistant?.finish_reason === "stop" || total > 0);
    const efficiency = computeEfficiency({
      total,
      completed: toolStats?.completed ?? 0,
      errors,
      totalDurationMs: toolStats?.total_duration_ms ?? 0,
    });

    const quality = evaluateSessionForCorpusQuality({
      efficiencyScore: efficiency,
      taskSuccess,
      toolTotal: total,
      toolCompleted: toolStats?.completed ?? 0,
      toolErrors: errors,
      toolDurationMs: toolStats?.total_duration_ms ?? 0,
      uniqueToolCount: toolNames.length,
      userMessages: Number(getMessageCounts?.user_messages ?? 0),
      assistantMessages: Number(getMessageCounts?.assistant_messages ?? 0),
      hasSystemPrompt: Boolean(systemPrompt?.system_prompt),
    });
    const qualityProfile = getQualityProfile(process.env.AGENT_LOGGER_QUALITY_PROFILE);

    db.prepare(`
      INSERT INTO training_examples
        (session_id, task_success, has_error, efficiency_score,
         total_duration_ms, tool_count, tool_names, finish_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        task_success      = excluded.task_success,
        has_error         = excluded.has_error,
        efficiency_score  = excluded.efficiency_score,
        total_duration_ms = excluded.total_duration_ms,
        tool_count        = excluded.tool_count,
        tool_names        = excluded.tool_names,
        finish_reason     = excluded.finish_reason,
        updated_at        = CURRENT_TIMESTAMP
    `).run(
      sessionID,
      taskSuccess ? 1 : 0,
      hasError ? 1 : 0,
      efficiency,
      toolStats?.total_duration_ms ?? 0,
      total,
      JSON.stringify(toolNames),
      lastAssistant?.finish_reason ?? null,
    );

    stmt.upsertSessionQuality.run(
      sessionID,
      qualityProfile.name,
      quality.score,
      jsonOrNull(qualityProfile),
      jsonOrNull(quality.components),
      jsonOrNull(quality.blockers),
    );
  }

  function handleMessageUpdated(props: any): void {
    instrument("handleMessageUpdated", () => {
      const info = props?.info;
      if (!info?.id || !info?.sessionID) return;

      // Make sure the session row exists (in case session.created was missed).
      stmt.upsertSession.run(
        info.sessionID,
        projectName,
        directory,
        null,
        info.time?.created ?? Date.now(),
      );

      if (info.role === "user") {
        stmt.upsertMessage.run(
          info.id,
          info.sessionID,
          "user",
          info.agent ?? null,
          info.model?.providerID ?? null,
          info.model?.modelID ?? null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          info.time?.created ?? null,
          null,
          null,
          jsonOrNull(info),
        );
        if (info.system) {
          // Per-message system prompt observed via UserMessage.system; record on session if not set.
          db.prepare(
            "UPDATE sessions SET system_prompt = COALESCE(system_prompt, ?) WHERE session_id = ?",
          ).run(info.system, info.sessionID);
        }
      } else if (info.role === "assistant") {
        stmt.upsertMessage.run(
          info.id,
          info.sessionID,
          "assistant",
          info.agent ?? null,
          info.providerID ?? null,
          info.modelID ?? null,
          info.parentID ?? null,
          info.finish ?? null,
          info.cost ?? null,
          info.tokens?.input ?? null,
          info.tokens?.output ?? null,
          info.tokens?.reasoning ?? null,
          info.tokens?.cache?.read ?? null,
          info.tokens?.cache?.write ?? null,
          info.time?.created ?? null,
          info.time?.completed ?? null,
          jsonOrNull(info.error),
          jsonOrNull(info),
        );
        if (info.error) {
          stmt.bumpSessionError.run(jsonOrNull(info.error), info.sessionID);
        }
      }
    });
  }

  function handlePartUpdated(props: any): void {
    instrument("handlePartUpdated", () => {
      const part = props?.part;
      if (!part?.id || !part?.messageID || !part?.sessionID) return;

      let text: string | null = null;
      let toolName: string | null = null;
      let toolCallId: string | null = null;
      let toolStatus: string | null = null;
      let toolInput: string | null = null;
      let toolOutput: string | null = null;
      let toolError: string | null = null;
      let toolMetadata: string | null = null;
      let startTs: number | null = null;
      let endTs: number | null = null;

      switch (part.type) {
        case "text":
        case "reasoning":
          text = truncateString(part.text ?? null);
          startTs = part.time?.start ?? null;
          endTs = part.time?.end ?? null;
          break;
        case "tool": {
          toolName = part.tool ?? null;
          toolCallId = part.callID ?? null;
          const state = part.state ?? {};
          toolStatus = state.status ?? null;
          toolInput = jsonOrNull(state.input);
          startTs = state.time?.start ?? null;
          endTs = state.time?.end ?? null;
          if (state.status === "completed") {
            toolOutput = truncateString(safeStr(state.output));
            toolMetadata = jsonOrNull(state.metadata);
          } else if (state.status === "error") {
            toolError = truncateString(safeStr(state.error));
            toolMetadata = jsonOrNull(state.metadata);
          }
          break;
        }
        default:
          // step-start, step-finish, file, agent, subtask, retry, snapshot, patch, compaction
          // Stored generically via raw_part; nothing extra to extract.
          break;
      }

      stmt.upsertPart.run(
        part.id,
        part.messageID,
        part.sessionID,
        part.type,
        text,
        toolName,
        toolCallId,
        toolStatus,
        toolInput,
        toolOutput,
        toolError,
        toolMetadata,
        startTs,
        endTs,
        jsonOrNull(part),
        props?.time ?? Date.now(),
      );
    });
  }

  const hooks: Hooks = {
    event: async ({ event }) => {
      try {
        const e = event as any;
        const t: string | undefined = e?.type;
        const p: any = e?.properties ?? {};
        if (!t) return;

        if (t.startsWith("session.")) {
          const sid = p?.sessionID;
          if (!sid) return;

          switch (t) {
            case "session.created": {
              const info = p.info ?? {};
              stmt.upsertSession.run(
                sid,
                projectName,
                directory,
                info.title ?? null,
                info.time?.created ?? Date.now(),
              );
              break;
            }
            case "session.updated": {
              const info = p.info ?? {};
              if (info.title) {
                db.prepare(
                  "UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?",
                ).run(info.title, sid);
              }
              break;
            }
            case "session.diff":
              for (const d of p.diff || []) {
                stmt.insertSessionDiff.run(
                  sid,
                  d.file ?? d.path ?? "unknown",
                  d.additions ?? 0,
                  d.deletions ?? 0,
                  d.status ?? "modified",
                  Date.now(),
                );
              }
              break;
            case "session.deleted":
              stmt.setSessionLifecycle.run("deleted", Date.now(), sid);
              break;
            case "session.error":
              stmt.bumpSessionError.run(jsonOrNull(p.error), sid);
              stmt.setSessionLifecycle.run("error", null, sid);
              break;
            case "session.status": {
              const type = p.status?.type;
              if (type) {
                stmt.setSessionStatus.run(type, sid);
                if (type === "idle") {
                  try {
                    refreshSessionAggregates(sid);
                    refreshTrainingExample(sid);
                    stmt.setSessionLifecycle.run("completed", null, sid);
                  } catch (e) {
                    void log("warn", "refresh on idle failed", {
                      sessionID: sid,
                      error: String(e),
                    });
                  }
                }
              }
              break;
            }
          }
          return;
        }

        switch (t) {
          case "message.updated":
            handleMessageUpdated(p);
            return;
          case "message.part.updated":
            handlePartUpdated(p);
            return;
          case "permission.asked":
            stmt.upsertPermissionAsked.run(
              p.id ?? `${p.sessionID}-${Date.now()}`,
              p.sessionID,
              p.permission ?? null,
              jsonOrNull(p.patterns),
              jsonOrNull(p.metadata),
              p.tool?.messageID ?? null,
              p.tool?.callID ?? null,
              Date.now(),
            );
            return;
          case "permission.replied":
            stmt.updatePermissionReplied.run(
              p.reply ?? "unknown",
              Date.now(),
              p.requestID,
            );
            return;
          case "file.edited":
            stmt.insertFileEdit.run(p.file ?? "", Date.now());
            return;
          case "command.executed":
            stmt.insertCommand.run(
              p.sessionID,
              p.messageID ?? null,
              p.name ?? "",
              p.arguments ?? null,
              Date.now(),
            );
            return;
        }
      } catch (err) {
        void log("warn", "event hook error", {
          eventType: (event as any)?.type,
          error: String(err),
        });
      }
    },

    "chat.params": async (input, output) => {
      try {
        stmt.insertChatParams.run(
          input.sessionID,
          input.agent ?? null,
          input.provider?.info?.id ?? null,
          input.model?.id ?? null,
          output.temperature ?? null,
          output.topP ?? null,
          output.topK ?? null,
          output.maxOutputTokens ?? null,
          jsonOrNull(output.options),
          Date.now(),
        );
      } catch (err) {
        void log("warn", "chat.params capture failed", { error: String(err) });
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input.sessionID) return;
        const joined = (output.system ?? []).filter(Boolean).join("\n\n");
        if (joined) stmt.setSessionSystemPrompt.run(joined, input.sessionID);
      } catch (err) {
        void log("warn", "system prompt capture failed", { error: String(err) });
      }
    },

    "tool.execute.before": async (input, output) => {
      try {
        stmt.insertToolHookBefore.run(
          input.callID,
          input.sessionID,
          input.tool,
          jsonOrNull(output.args),
          Date.now(),
        );
      } catch (err) {
        void log("warn", "tool.execute.before capture failed", { error: String(err) });
      }
    },

    "tool.execute.after": async (input, output) => {
      try {
        const end = Date.now();
        const row = db
          .prepare("SELECT start_ts FROM tool_call_hooks WHERE call_id = ?")
          .get(input.callID) as { start_ts: number } | undefined;
        const duration = row?.start_ts ? end - row.start_ts : null;
        stmt.updateToolHookAfter.run(
          truncateString(safeStr(output.output)),
          jsonOrNull(output.metadata),
          output.title ?? null,
          end,
          duration,
          input.callID,
        );
      } catch (err) {
        void log("warn", "tool.execute.after capture failed", { error: String(err) });
      }
    },

    tool: {
      analyze_logs: tool({
        description: "Analyze tool-call performance for sessions in this project",
        args: {
          limit: tool.schema
            .number()
            .optional()
            .describe("Number of recent tool calls to analyze (default 200)"),
          project_filter: tool.schema
            .string()
            .optional()
            .describe("Project name to filter by (default: current project)"),
        },
        async execute(args) {
          const limit = args.limit ?? 200;
          const project = args.project_filter ?? projectName;

          const parts = db
            .prepare(
              `
              SELECT mp.tool_name, mp.tool_status,
                     mp.start_ts, mp.end_ts,
                     (mp.end_ts - mp.start_ts) AS duration_ms
              FROM message_parts mp
              JOIN sessions s ON s.session_id = mp.session_id
              WHERE mp.part_type = 'tool' AND s.project_name = ?
              ORDER BY mp.start_ts DESC
              LIMIT ?
            `,
            )
            .all(project, limit) as any[];

          const total = parts.length;
          const completed = parts.filter((p) => p.tool_status === "completed").length;
          const errors = parts.filter((p) => p.tool_status === "error").length;
          const durations = parts
            .map((p) => p.duration_ms)
            .filter((d) => typeof d === "number" && d > 0) as number[];
          const avgDuration = durations.length > 0
            ? durations.reduce((a, b) => a + b, 0) / durations.length
            : 0;

          const counts: Record<string, number> = {};
          for (const p of parts) {
            if (p.tool_name) counts[p.tool_name] = (counts[p.tool_name] ?? 0) + 1;
          }

          return JSON.stringify({
            project,
            window: { tool_calls: total, limit },
            summary: {
              total_tools: total,
              completed,
              errors,
              success_rate: total > 0 ? `${((completed / total) * 100).toFixed(1)}%` : "N/A",
              avg_duration_ms: Math.round(avgDuration),
            },
            top_tools: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10),
          }, null, 2);
        },
      }),

      export_training_data: tool({
        description: "Export multi-turn conversations as JSONL for SFT fine-tuning",
        args: {
          min_efficiency: tool.schema
            .number()
            .optional()
            .describe("Minimum efficiency score [0-1] (default 0.0)"),
          quality_profile: tool.schema
            .string()
            .optional()
            .describe("Quality profile to use for corpus scoring (default: default)"),
          min_quality_score: tool.schema
            .number()
            .optional()
            .describe("Minimum corpus quality score [0-1] (default 0.0)"),
          require_success: tool.schema
            .boolean()
            .optional()
            .describe("Only export sessions with task_success=1 (default false)"),
          redact: tool.schema
            .boolean()
            .optional()
            .describe("Apply deterministic secret redaction before export (default true)"),
          limit: tool.schema
            .number()
            .optional()
            .describe("Max sessions to export (default 50)"),
          project_filter: tool.schema
            .string()
            .optional()
            .describe("Limit to one project name (default: any)"),
        },
        async execute(args) {
          const minEff = args.min_efficiency ?? 0;
          const qualityProfile = getQualityProfile(args.quality_profile);
          const minQuality = args.min_quality_score ?? 0;
          const sortByQuality = args.quality_profile != null || args.min_quality_score != null;
          const requireSuccess = args.require_success ?? false;
          const doRedact = args.redact ?? true;
          const limit = args.limit ?? 50;
          const project = args.project_filter ?? null;
          const candidateLimit = Math.max(limit * QUALITY_CANDIDATE_MULTIPLIER, MIN_QUALITY_CANDIDATES);

          const extraRedaction = doRedact
            ? parseExtraRedactionPatterns(process.env.AGENT_LOGGER_EXTRA_REDACTION_PATTERNS)
            : { patterns: [], invalidPatterns: [] };
          const redactionPatterns = doRedact
            ? [...getBuiltinRedactionPatterns(), ...extraRedaction.patterns]
            : [];
          const redactionState = doRedact ? createRedactionState() : null;

          if (doRedact && redactionPatterns.length > 0) {
            void log("info", "Export redaction patterns enabled", {
              builtinPatternCount: getBuiltinRedactionPatterns().length,
              customPatternCount: extraRedaction.patterns.length,
            });
          }
          if (doRedact && extraRedaction.invalidPatterns.length > 0) {
            void log("warn", "Ignoring invalid custom redaction patterns", {
              invalidPatternCount: extraRedaction.invalidPatterns.length,
              invalidPatterns: extraRedaction.invalidPatterns,
            });
          }

          const sessions = db.prepare(`
            SELECT s.session_id, s.system_prompt, s.project_name,
                   t.efficiency_score, t.task_success, t.tool_count,
                   q.quality_score, q.quality_components, q.quality_blockers
            FROM training_examples t
            JOIN sessions s ON s.session_id = t.session_id
            LEFT JOIN session_quality q ON q.session_id = t.session_id AND q.profile_name = ?
            WHERE t.efficiency_score >= ?
              ${requireSuccess ? "AND t.task_success = 1" : ""}
              ${project ? "AND s.project_name = ?" : ""}
            ORDER BY t.efficiency_score DESC
            LIMIT ?
          `).all(
            ...(project ? [qualityProfile.name, minEff, project, candidateLimit] : [qualityProfile.name, minEff, candidateLimit])
          ) as any[];

          const totalCandidates = (db.prepare("SELECT COUNT(*) as count FROM training_examples").get() as any).count;

          const qualityRows = sessions.map(s => {
            const storedScore = Number(s.quality_score);
            if (s.quality_score !== null && Number.isFinite(storedScore)) {
              return {
                session: s,
                quality: {
                  profileName: qualityProfile.name,
                  score: storedScore,
                  components: parseJson(s.quality_components),
                  blockers: parseJson(s.quality_blockers),
                  rationale: `stored:profile=${qualityProfile.name}`,
                }
              };
            }

            // Fallback: Recompute if not in DB
            const messageCounts = db.prepare(`
              SELECT SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS user_messages,
                     SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS assistant_messages
              FROM messages WHERE session_id = ?
            `).get(s.session_id) as any;

            const toolStats = db.prepare(`
              SELECT COUNT(*) AS total_tools,
                     SUM(CASE WHEN tool_status = 'completed' THEN 1 ELSE 0 END) AS completed,
                     SUM(CASE WHEN tool_status = 'error' THEN 1 ELSE 0 END) AS errors,
                     COALESCE(SUM(CASE WHEN end_ts IS NOT NULL AND start_ts IS NOT NULL THEN end_ts - start_ts ELSE 0 END), 0) AS total_duration_ms
              FROM message_parts WHERE session_id = ? AND part_type = 'tool'
            `).get(s.session_id) as any;

            const toolNames = db.prepare("SELECT DISTINCT tool_name FROM message_parts WHERE session_id = ? AND part_type = 'tool'").all(s.session_id).map((r: any) => r.tool_name);
            const hasSystem = db.prepare("SELECT system_prompt FROM sessions WHERE session_id = ?").get(s.session_id) as any;

            return {
              session: s,
              quality: evaluateSessionForCorpusQuality({
                efficiencyScore: Number(s.efficiency_score ?? 0),
                taskSuccess: !!s.task_success,
                toolTotal: Number(toolStats.total_tools ?? 0),
                toolCompleted: Number(toolStats.completed ?? 0),
                toolErrors: Number(toolStats.errors ?? 0),
                toolDurationMs: Number(toolStats.total_duration_ms ?? 0),
                uniqueToolCount: toolNames.length,
                userMessages: Number(messageCounts.user_messages ?? 0),
                assistantMessages: Number(messageCounts.assistant_messages ?? 0),
                hasSystemPrompt: !!hasSystem?.system_prompt,
              }, qualityProfile.name)
            };
          }).filter(row => row.quality.score >= minQuality);

          if (sortByQuality) {
            qualityRows.sort((a, b) => b.quality.score - a.quality.score);
          }

          const lines: string[] = [];
          for (const { session: s, quality } of qualityRows.slice(0, limit)) {
            const conv = buildConversation(db, s.session_id, s.system_prompt);
            if (conv.messages.length < 2) continue;
            const payload = {
              messages: conv.messages,
              metadata: {
                source: "opencode",
                session_id: s.session_id,
                project: s.project_name,
                efficiency: s.efficiency_score,
                task_success: !!s.task_success,
                tool_count: s.tool_count,
                quality: {
                  profile: quality.profileName,
                  score: quality.score,
                  components: quality.components ?? null,
                  blockers: quality.blockers ?? null,
                  rationale: quality.rationale,
                },
                redacted: doRedact,
              },
            };
            const outPayload = doRedact && redactionState
              ? redactPayload(payload, redactionState, redactionPatterns)
              : payload;
            lines.push(JSON.stringify(outPayload));
          }

          return JSON.stringify({
            summary: {
              total_candidates: totalCandidates,
              passed_threshold: lines.length,
              min_efficiency: minEff,
              min_quality_score: minQuality,
              quality_profile: qualityProfile.name,
              require_success: requireSuccess,
              redacted: doRedact,
              limit_applied: limit
            },
            jsonl: lines.join("\n")
          }, null, 2);
        },
      }),

      get_dashboard: tool({
        description: "Real-time dashboard with today's activity and lifetime totals",
        args: {},
        async execute() {
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const startTs = todayStart.getTime();

          const today = db.prepare(`
            SELECT COUNT(*) AS total_calls,
                   SUM(CASE WHEN tool_status = 'completed' THEN 1 ELSE 0 END) AS completed,
                   SUM(CASE WHEN tool_status = 'error' THEN 1 ELSE 0 END) AS errors,
                   AVG(CASE WHEN end_ts IS NOT NULL AND start_ts IS NOT NULL THEN end_ts - start_ts END) AS avg_duration_ms
            FROM message_parts WHERE part_type = 'tool' AND start_ts >= ?
          `).get(startTs) as any;

          const recent = db.prepare(`
            SELECT tool_name, tool_status,
                   CASE WHEN end_ts IS NOT NULL AND start_ts IS NOT NULL THEN end_ts - start_ts END AS duration_ms
            FROM message_parts WHERE part_type = 'tool'
            ORDER BY start_ts DESC LIMIT 10
          `).all() as any[];

          const topTools = db.prepare(`
            SELECT tool_name, COUNT(*) AS count
            FROM message_parts
            WHERE part_type = 'tool' AND start_ts >= ?
            GROUP BY tool_name ORDER BY count DESC LIMIT 5
          `).all(startTs);

          const totals = db.prepare(`
            SELECT (SELECT COUNT(*) FROM sessions) AS total_sessions,
                   (SELECT COUNT(*) FROM messages) AS total_messages,
                   (SELECT COUNT(*) FROM message_parts WHERE part_type = 'tool') AS total_tool_calls,
                   (SELECT COUNT(*) FROM training_examples) AS total_training_examples
          `).get();

          return JSON.stringify({
            project: projectName,
            today: {
              total_calls: today?.total_calls ?? 0,
              completed: today?.completed ?? 0,
              errors: today?.errors ?? 0,
              avg_duration_ms: Math.round(today?.avg_duration_ms ?? 0),
            },
            recent_calls: recent.map(r => ({ tool: r.tool_name, status: r.tool_status, duration_ms: r.duration_ms })),
            top_tools_today: topTools,
            totals,
            db_path: DB_PATH,
          }, null, 2);
        },
      }),

      prune_old_data: tool({
        description: "Delete sessions older than N days. Cleans every table.",
        args: {
          days: tool.schema.number().optional().describe("Delete data older than this many days (default 90)"),
          dry_run: tool.schema.boolean().optional().describe("If true, only report what would be deleted"),
        },
        async execute(args) {
          const days = args.days ?? 90;
          const dryRun = args.dry_run ?? false;
          const cutoffMs = Date.now() - days * 86400_000;

          const oldSessions = db.prepare(`SELECT session_id FROM sessions WHERE COALESCE(end_time, start_time) < ?`).all(cutoffMs) as { session_id: string }[];
          const ids = oldSessions.map(s => s.session_id);

          if (dryRun || ids.length === 0) {
            return JSON.stringify({ dry_run: dryRun, days_old: days, sessions_to_delete: ids.length }, null, 2);
          }

          const tx = db.transaction(() => {
            const placeholders = ids.map(() => "?").join(",");
            db.prepare(`DELETE FROM message_parts WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM tool_call_hooks WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM chat_params WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM permissions WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM commands WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM session_diffs WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM session_quality WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM training_examples WHERE session_id IN (${placeholders})`).run(...ids);
            db.prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`).run(...ids);
          });
          tx();

          return JSON.stringify({ deleted_sessions: ids.length, days_old: days }, null, 2);
        },
      }),
    },
  };

  return hooks;
};
