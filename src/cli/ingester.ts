import { Database, Statement } from "bun:sqlite";
import * as fs from "fs";
import * as readline from "readline";
import { getIngestDb } from "./ingest-db";
import { z } from "zod";

function instrument<T>(name: string, fn: () => T): T {
  return fn();
}

function truncateString(s: string | null | undefined, max = 200000): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n\n---TRUNCATED---";
}

const TelemetryPayloadSchema = z.object({
  event: z.string().optional(),
  hook_event_name: z.string().optional(),
  sessionID: z.string().optional(),
  session_id: z.string().optional(),
  timestamp: z.number().optional(),
  localTimestamp: z.number().optional(),
  cwd: z.string().optional(),
  projectPath: z.string().optional(),
  project_path: z.string().optional(),
  agentName: z.string().optional(),
  agent_name: z.string().optional(),
  agent: z.string().optional(),
  source: z.string().optional(),
}).passthrough();

export interface NormalizedEvent {
  eventName: string;
  sessionId: string;
  timestamp: number;
  projectPath: string;
  agentName: string | null;
  payload: any;
}

/**
 * Normalizes raw payload into a unified schema contract, supporting both v1 envelopes and legacy records.
 */
export function normalizeEvent(raw: any): NormalizedEvent | null {
  const isEnvelope = typeof raw === "object" && raw !== null && typeof raw.schema_version === "number" && raw.schema_version >= 1;

  if (isEnvelope) {
    const sourceEvent = raw.source_event;
    if (!sourceEvent) return null;

    const sessionId = raw.session_id ?? "unknown";
    const timestamp = raw.captured_at ?? Date.now();
    const projectPath = raw.cwd ?? "unknown";
    const agentName = (raw.source_agent ?? null) as string | null;

    return {
      eventName: sourceEvent,
      sessionId,
      timestamp,
      projectPath,
      agentName,
      payload: raw,
    };
  }

  const result = TelemetryPayloadSchema.safeParse(raw);
  if (!result.success) return null;

  const data = result.data;
  const eventName = data.event ?? data.hook_event_name;
  if (!eventName) return null;

  const sessionId = data.sessionID ?? data.session_id ?? "unknown";
  const timestamp = data.timestamp ?? data.localTimestamp ?? Date.now();
  const projectPath = data.projectPath ?? data.cwd ?? data.project_path ?? "unknown";
  const agentName = data.agentName ?? data.agent_name ?? data.agent ?? data.source ?? null;

  return {
    eventName,
    sessionId,
    timestamp,
    projectPath,
    agentName,
    payload: raw,
  };
}

/**
 * Extracts a field from either the envelope's normalized block or legacy top-level keys.
 */
function extractFromEnvelope(payload: any, legacyKey1: string, legacyKey2: string, normalizedKey: string): any {
  if (payload.schema_version >= 1 && payload.normalized) {
    const val = payload.normalized[normalizedKey];
    if (val !== undefined && val !== null) return val;
  }
  return payload[legacyKey1] ?? payload[legacyKey2] ?? payload[normalizedKey] ?? null;
}

function extractTurnId(payload: any): string | null {
  if (payload.schema_version >= 1) {
    return payload.turn_id ?? payload.normalized?.turn_id ?? null;
  }
  return payload.turn_id ?? payload.turnID ?? null;
}

function extractGitContext(payload: any): {
  git_root: string | null;
  git_branch: string | null;
  git_commit: string | null;
  git_dirty: number | null;
  git_remote_url: string | null;
  changed_files_json: string | null;
} {
  const gc = payload.git_context;
  if (!gc) {
    return {
      git_root: null,
      git_branch: null,
      git_commit: null,
      git_dirty: null,
      git_remote_url: null,
      changed_files_json: null,
    };
  }
  return {
    git_root: gc.git_root ?? null,
    git_branch: gc.branch ?? null,
    git_commit: gc.commit ?? null,
    git_dirty: gc.dirty !== null && gc.dirty !== undefined ? (gc.dirty ? 1 : 0) : null,
    git_remote_url: gc.remote_url ?? null,
    changed_files_json: gc.changed_files ? JSON.stringify(gc.changed_files) : null,
  };
}

export class TelemetryIngester {
  private db: Database;
  // Safe from memory leak in daemon because createEnvelope() always provides a record_id.
  // This map is only populated during legacy offline CLI ingestion.
  private permissionRequestCounters = new Map<string, number>();

  private selectSessionStmt: Statement;
  private insertSessionStmt: Statement;
  private updateSessionStmt: Statement;
  private updateSessionStartStmt: Statement;
  private insertMessageStmt: Statement;
  private insertToolCallStmt: Statement;
  private selectToolCallStmt: Statement;
  private insertToolCallPostStmt: Statement;
  private updateToolCallPostStmt: Statement;
  private insertPermissionRequestStmt: Statement;
  private insertCompactEventStmt: Statement;
  private insertSubagentEventStmt: Statement;
  private updateSessionStopStmt: Statement;
  private insertAssistantMessageStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    this.selectSessionStmt = db.prepare("SELECT session_id, project_path, agent_name FROM codex_sessions WHERE session_id = ?");
    this.insertSessionStmt = db.prepare(`
      INSERT INTO codex_sessions (session_id, project_path, agent_name, start_time)
      VALUES (?, ?, ?, ?)
    `);
    this.updateSessionStmt = db.prepare(`
      UPDATE codex_sessions
      SET project_path = COALESCE(NULLIF(?, 'unknown'), project_path),
          agent_name = COALESCE(agent_name, ?)
      WHERE session_id = ?
    `);

    this.updateSessionStartStmt = db.prepare(`
      UPDATE codex_sessions
      SET model_provider = COALESCE(?, model_provider),
          model_id = COALESCE(?, model_id),
          session_source = COALESCE(?, session_source),
          permission_mode = COALESCE(?, permission_mode),
          transcript_path = COALESCE(?, transcript_path),
          git_root = COALESCE(?, git_root),
          git_branch = COALESCE(?, git_branch),
          git_commit = COALESCE(?, git_commit),
          git_dirty = COALESCE(?, git_dirty),
          git_remote_url = COALESCE(?, git_remote_url)
      WHERE session_id = ?
    `);

    this.insertMessageStmt = db.prepare(`
      INSERT INTO codex_messages (message_id, session_id, role, content, timestamp, turn_id)
      VALUES (?, ?, 'user', ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        content = excluded.content,
        timestamp = excluded.timestamp,
        turn_id = COALESCE(excluded.turn_id, codex_messages.turn_id)
    `);

    this.insertToolCallStmt = db.prepare(`
      INSERT INTO codex_tool_calls (call_id, session_id, tool_name, input_args, status, start_time, turn_id)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(call_id) DO UPDATE SET
        tool_name = excluded.tool_name,
        input_args = COALESCE(excluded.input_args, codex_tool_calls.input_args),
        start_time = excluded.start_time,
        turn_id = COALESCE(excluded.turn_id, codex_tool_calls.turn_id)
    `);

    this.selectToolCallStmt = db.prepare("SELECT start_time FROM codex_tool_calls WHERE call_id = ?");

    this.insertToolCallPostStmt = db.prepare(`
      INSERT INTO codex_tool_calls (call_id, session_id, tool_name, output, status, end_time, duration_ms, turn_id, exit_code, truncation_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateToolCallPostStmt = db.prepare(`
      UPDATE codex_tool_calls
      SET output = ?, status = ?, end_time = ?, duration_ms = ?, turn_id = COALESCE(?, turn_id), exit_code = ?, truncation_meta = ?
      WHERE call_id = ?
    `);

    this.insertPermissionRequestStmt = db.prepare(`
      INSERT INTO codex_permission_requests (request_id, session_id, tool_name, tool_input, turn_id, permission_mode, agent_id, agent_type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        tool_name = COALESCE(excluded.tool_name, codex_permission_requests.tool_name),
        tool_input = COALESCE(excluded.tool_input, codex_permission_requests.tool_input),
        turn_id = COALESCE(excluded.turn_id, codex_permission_requests.turn_id),
        permission_mode = COALESCE(excluded.permission_mode, codex_permission_requests.permission_mode),
        agent_id = COALESCE(excluded.agent_id, codex_permission_requests.agent_id),
        agent_type = COALESCE(excluded.agent_type, codex_permission_requests.agent_type),
        timestamp = MAX(excluded.timestamp, codex_permission_requests.timestamp)
    `);

    this.insertCompactEventStmt = db.prepare(`
      INSERT INTO codex_compact_events (session_id, event_type, turn_id, reason, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.insertSubagentEventStmt = db.prepare(`
      INSERT INTO codex_subagent_events (session_id, event_type, subagent_id, parent_turn_id, agent_type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.updateSessionStopStmt = db.prepare(`
      UPDATE codex_sessions
      SET end_time = ?,
          finish_reason = ?,
          stop_hook_active = COALESCE(?, stop_hook_active),
          git_end_branch = COALESCE(?, git_end_branch),
          git_end_commit = COALESCE(?, git_end_commit),
          git_end_dirty = COALESCE(?, git_end_dirty),
          changed_files_json = COALESCE(?, changed_files_json)
      WHERE session_id = ?
    `);

    this.insertAssistantMessageStmt = db.prepare(`
      INSERT INTO codex_messages (message_id, session_id, role, content, timestamp, turn_id)
      VALUES (?, ?, 'assistant', ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        content = excluded.content,
        timestamp = excluded.timestamp,
        turn_id = COALESCE(excluded.turn_id, codex_messages.turn_id)
    `);
  }

  private ensureSessionExists(
    sessionId: string,
    timestamp: number,
    projectPath = "unknown",
    agentName: string | null = null
  ) {
    const existing = this.selectSessionStmt.get(sessionId) as any;
    if (!existing) {
      instrument("ensureSessionExists:insert", () => {
        this.insertSessionStmt.run(sessionId, projectPath, agentName, timestamp);
      });
    } else {
      const updatePath = projectPath !== "unknown" && existing.project_path === "unknown";
      const updateAgent = agentName !== null && existing.agent_name === null;
      if (updatePath || updateAgent) {
        instrument("ensureSessionExists:update", () => {
          this.updateSessionStmt.run(projectPath, agentName, sessionId);
        });
      }
    }
  }

  /**
   * Ingests an array of events inside a single transaction.
   */
  public ingestEvents(events: NormalizedEvent[]) {
    this.db.transaction(() => {
      for (const event of events) {
        this.ingestSingleEvent(event);
      }
    })();
    // Note: To completely decouple, quality scoring is no longer done during CLI ingestion.
    // It will be calculated dynamically on export.
  }

  /**
   * Ingests a single normalized event. It is highly recommended to call this 
   * within a transaction if ingesting many events in bulk.
   */
  public ingestSingleEvent(event: NormalizedEvent) {
    const { eventName, sessionId, timestamp, projectPath, agentName, payload } = event;

    this.ensureSessionExists(sessionId, timestamp, projectPath, agentName);

    const isEnvelope = payload.schema_version >= 1;

    if (eventName === "SessionStart") {
      let modelProvider: string | null = null;
      let modelId: string | null = null;

      const rawModel = payload.model ?? (isEnvelope ? payload.raw?.model : null);

      if (rawModel) {
        if (typeof rawModel === "object") {
          modelProvider = rawModel.provider ?? rawModel.providerID ?? null;
          modelId = rawModel.modelID ?? rawModel.modelId ?? null;
        } else if (typeof rawModel === "string") {
          if (rawModel.includes("/")) {
            const parts = rawModel.split("/");
            modelProvider = parts[0];
            modelId = parts.slice(1).join("/");
          } else {
            modelId = rawModel;
          }
        }
      }
      if (!modelProvider) modelProvider = payload.model_provider ?? null;
      if (!modelId) modelId = payload.model_id ?? null;

      const sessionSource = payload.session_source ?? null;
      const permissionMode = payload.permission_mode ?? null;
      const transcriptPath = payload.transcript_path ?? null;
      const git = extractGitContext(payload);

      instrument("SessionStart", () => {
        this.updateSessionStartStmt.run(
          modelProvider, modelId, sessionSource, permissionMode, transcriptPath,
          git.git_root, git.git_branch, git.git_commit, git.git_dirty, git.git_remote_url,
          sessionId
        );
      });

    } else if (eventName === "UserPromptSubmit") {
      const messageId = extractFromEnvelope(payload, "messageID", "message_id", "message_id")
        ?? payload.turn_id;
      if (!messageId) return;
      const prompt = extractFromEnvelope(payload, "prompt", "content", "prompt") ?? "";
      const turnId = extractTurnId(payload);

      instrument("UserPromptSubmit", () => {
        this.insertMessageStmt.run(messageId, sessionId, prompt, timestamp, turnId);
      });

    } else if (eventName === "PreToolUse") {
      const callId = extractFromEnvelope(payload, "callID", "call_id", "tool_use_id");
      if (!callId) return;
      const toolName = extractFromEnvelope(payload, "tool", "tool_name", "tool_name") ?? "";
      const args = payload.args ?? payload.tool_input
        ?? (isEnvelope ? payload.normalized?.tool_input : null) ?? null;
      const inputArgs = args ? (typeof args === "string" ? args : JSON.stringify(args)) : null;
      const turnId = extractTurnId(payload);

      instrument("PreToolUse", () => {
        this.insertToolCallStmt.run(callId, sessionId, toolName, inputArgs, timestamp, turnId);
      });

    } else if (eventName === "PostToolUse") {
      const callId = extractFromEnvelope(payload, "callID", "call_id", "tool_use_id");
      if (!callId) return;
      const toolName = extractFromEnvelope(payload, "tool", "tool_name", "tool_name") ?? "";
      const toolResponse = payload.output ?? payload.tool_response
        ?? (isEnvelope ? (payload.raw?.output ?? payload.raw?.tool_response) : null) ?? null;
      const status = extractFromEnvelope(payload, "status", "status", "status") ?? "completed";
      const turnId = extractTurnId(payload);
      const exitCode = payload.exit_code ?? (isEnvelope ? payload.normalized?.exit_code : null) ?? payload.exitCode ?? null;

      const existing = this.selectToolCallStmt.get(callId) as { start_time: number } | undefined;
      let durationMs: number | null = null;
      if (existing && typeof existing.start_time === "number") {
        durationMs = timestamp - existing.start_time;
      }

      const truncatedOutput = truncateString(typeof toolResponse === "string" ? toolResponse : (toolResponse ? JSON.stringify(toolResponse) : null));

      const truncationMeta = isEnvelope ? (payload.truncation ?? payload.normalized?.truncation ?? null) : null;
      const truncationJson = truncationMeta ? JSON.stringify(truncationMeta) : null;

      if (!existing) {
        instrument("PostToolUse:insert", () => {
          this.insertToolCallPostStmt.run(callId, sessionId, toolName || "unknown", truncatedOutput, status, timestamp, durationMs, turnId, exitCode, truncationJson);
        });
      } else {
        instrument("PostToolUse:update", () => {
          this.updateToolCallPostStmt.run(truncatedOutput, status, timestamp, durationMs, turnId, exitCode, truncationJson, callId);
        });
      }

    } else if (eventName === "PermissionRequest") {
      const toolName = isEnvelope ? (payload.normalized?.tool_name ?? null) : (payload.tool_name ?? payload.tool ?? null);
      const toolInput = isEnvelope ? (payload.normalized?.tool_input ?? null) : (payload.tool_input ?? payload.input ?? null);
      const turnId = extractTurnId(payload);
      const permissionMode = isEnvelope ? (payload.permission_mode ?? payload.normalized?.permission_mode ?? null) : (payload.permission_mode ?? null);
      const agentId = isEnvelope ? (payload.normalized?.agent_id ?? null) : (payload.agent_id ?? null);
      const agentType = isEnvelope ? (payload.normalized?.agent_type ?? null) : (payload.agent_type ?? null);
      const requestId = payload.record_id
        ?? (() => {
          const key = `${sessionId}-${timestamp}-${turnId ?? "unknown"}-${toolName ?? "unknown"}-${agentType ?? "unknown"}`;
          const next = (this.permissionRequestCounters.get(key) ?? 0) + 1;
          this.permissionRequestCounters.set(key, next);
          return `${key}-${next}`;
        })();

      instrument("PermissionRequest", () => {
        this.insertPermissionRequestStmt.run(requestId, sessionId, toolName, toolInput ? JSON.stringify(toolInput) : null, turnId, permissionMode, agentId, agentType, timestamp);
      });

    } else if (eventName === "PreCompact" || eventName === "PostCompact") {
      const turnId = extractTurnId(payload);
      const reason = isEnvelope ? (payload.normalized?.reason ?? null) : (payload.reason ?? null);

      instrument("Compact", () => {
        this.insertCompactEventStmt.run(sessionId, eventName, turnId, reason, timestamp);
      });

    } else if (eventName === "SubagentStart" || eventName === "SubagentStop") {
      const subagentId = isEnvelope ? (payload.normalized?.subagent_id ?? null) : (payload.subagent_id ?? null);
      const parentTurnId = isEnvelope ? (payload.normalized?.parent_turn_id ?? null) : (payload.parent_turn_id ?? payload.turn_id ?? null);
      const agentType = isEnvelope ? (payload.normalized?.agent_type ?? null) : (payload.agent_type ?? null);

      instrument("Subagent", () => {
        this.insertSubagentEventStmt.run(sessionId, eventName, subagentId, parentTurnId, agentType, timestamp);
      });

    } else if (eventName === "Stop") {
      const finishReason = payload.finishReason ?? payload.finish_reason
        ?? (isEnvelope ? payload.normalized?.finish_reason : null) ?? null;
      const stopHookActive = payload.stop_hook_active ?? (isEnvelope ? payload.normalized?.stop_hook_active : null) ?? null;
      const git = extractGitContext(payload);

      instrument("Stop:session", () => {
        this.updateSessionStopStmt.run(
          timestamp, finishReason, stopHookActive,
          git.git_branch, git.git_commit, git.git_dirty, git.changed_files_json,
          sessionId
        );
      });

      const lastResponse = payload.lastResponse ?? (isEnvelope ? payload.raw?.lastResponse : null) ?? {};
      const lastAssistantMessage = lastResponse.content ?? payload.last_assistant_message ?? "";
      const messageId = lastResponse.messageID ?? payload.message_id ?? `msg_assistant_${sessionId}`;

      const turnId = extractTurnId(payload);
      instrument("Stop:assistantMessage", () => {
        this.insertAssistantMessageStmt.run(messageId, sessionId, lastAssistantMessage, timestamp, turnId);
      });
    }
  }
}

/**
 * Parses raw JSONL telemetry buffer and ingests records into SQLite,
 * supporting both v1 envelopes and legacy format records.
 */
export async function ingestTelemetry(bufferPath: string, db: Database): Promise<void> {
  if (!fs.existsSync(bufferPath)) {
    return;
  }

  const fileStream = fs.createReadStream(bufferPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const events: NormalizedEvent[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const normalized = normalizeEvent(parsed);
      if (normalized) {
        events.push(normalized);
      }
    } catch (e) {
    }
  }

  const ingester = new TelemetryIngester(db);
  ingester.ingestEvents(events);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const bufferPathIdx = args.indexOf("--buffer");
  const dbPathIdx = args.indexOf("--db");

  const bufferPath = bufferPathIdx !== -1 ? args[bufferPathIdx + 1] : null;
  const dbPath = dbPathIdx !== -1 ? args[dbPathIdx + 1] : null;

  if (!bufferPath || !dbPath) {
    console.error("Usage: bun src/cli/ingester.ts --buffer <bufferPath> --db <dbPath>");
    process.exit(1);
  }

  try {
    const db = getIngestDb(dbPath);
    await ingestTelemetry(bufferPath, db);
    console.log(`Successfully ingested telemetry from ${bufferPath} into ${dbPath}`);
    process.exit(0);
  } catch (err) {
    console.error(`Ingestion failed: ${String(err)}`);
    process.exit(1);
  }
}
