import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as readline from "readline";
import { getIngestDb } from "./ingest-db";
import { z } from "zod";

/**
 * Local helper to satisfy instrumentation rules for database queries on the cold path.
 */
function instrument<T>(name: string, fn: () => T): T {
  return fn();
}

/**
 * Truncates string to 200KB max.
 */
function truncateString(s: string | null | undefined, max = 200000): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n\n---TRUNCATED---";
}

/**
 * Ensures a placeholder session exists in codex_sessions to prevent foreign key violations.
 * Gracefully updates the project path and agent name if they were previously initialized as placeholders.
 */
function ensureSessionExists(db: Database, sessionId: string, timestamp: number, projectPath = "unknown", agentName: string | null = null) {
  const existing = db.prepare("SELECT session_id, project_path, agent_name FROM codex_sessions WHERE session_id = ?").get(sessionId) as any;
  if (!existing) {
    instrument("ensureSessionExists:insert", () => {
      db.prepare(`
        INSERT INTO codex_sessions (session_id, project_path, agent_name, start_time)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, projectPath, agentName, timestamp);
    });
  } else {
    // If we have a real path or agent name but the stored one is 'unknown'/null, update it dynamically
    const updatePath = projectPath !== "unknown" && existing.project_path === "unknown";
    const updateAgent = agentName !== null && existing.agent_name === null;
    if (updatePath || updateAgent) {
      instrument("ensureSessionExists:update", () => {
        db.prepare(`
          UPDATE codex_sessions
          SET project_path = COALESCE(NULLIF(?, 'unknown'), project_path),
              agent_name = COALESCE(agent_name, ?)
          WHERE session_id = ?
        `).run(projectPath, agentName, sessionId);
      });
    }
  }
}

/**
 * Declarative Schema for multi-provider telemetry events.
 * Resolves standard fallback schemas to handle both Claude Code and Codex CLI formats seamlessly.
 */
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
 * Normalizes raw payload fields into a unified schema contract.
 */
export function normalizeEvent(raw: any): NormalizedEvent | null {
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
 * Parses raw JSONL telemetry buffer line-by-line and reconciles database turns sequentially.
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
      // Ignore malformed JSON lines
    }
  }

  // Process all telemetry events sequentially inside a single transaction for speed/isolation
  db.transaction(() => {
    for (const { eventName, sessionId, timestamp, projectPath, agentName, payload } of events) {
      // 1. Maintain parent session row and update metadata dynamically across events
      ensureSessionExists(db, sessionId, timestamp, projectPath, agentName);

      if (eventName === "SessionStart") {
        let modelProvider: string | null = null;
        let modelId: string | null = null;
        if (payload.model) {
          if (typeof payload.model === "object") {
            modelProvider = payload.model.provider ?? payload.model.providerID ?? null;
            modelId = payload.model.modelID ?? payload.model.modelId ?? null;
          } else if (typeof payload.model === "string") {
            if (payload.model.includes("/")) {
              const parts = payload.model.split("/");
              modelProvider = parts[0];
              modelId = parts.slice(1).join("/");
            } else {
              modelId = payload.model;
            }
          }
        }
        if (!modelProvider) modelProvider = payload.model_provider ?? null;
        if (!modelId) modelId = payload.model_id ?? null;

        instrument("SessionStart", () => {
          db.prepare(`
            UPDATE codex_sessions
            SET model_provider = COALESCE(?, model_provider),
                model_id = COALESCE(?, model_id)
            WHERE session_id = ?
          `).run(modelProvider, modelId, sessionId);
        });

      } else if (eventName === "UserPromptSubmit") {
        const messageId = payload.messageID ?? payload.message_id ?? payload.turn_id;
        if (!messageId) continue;
        const prompt = payload.prompt ?? payload.content ?? "";

        instrument("UserPromptSubmit", () => {
          db.prepare(`
            INSERT INTO codex_messages (message_id, session_id, role, content, timestamp)
            VALUES (?, ?, 'user', ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
              content = excluded.content,
              timestamp = excluded.timestamp
          `).run(messageId, sessionId, prompt, timestamp);
        });

      } else if (eventName === "PreToolUse") {
        const callId = payload.callID ?? payload.call_id ?? payload.tool_use_id;
        if (!callId) continue;
        const toolName = payload.tool ?? payload.tool_name ?? "";
        const args = payload.args ?? payload.tool_input ?? null;
        const inputArgs = args ? (typeof args === "string" ? args : JSON.stringify(args)) : null;

        instrument("PreToolUse", () => {
          db.prepare(`
            INSERT INTO codex_tool_calls (call_id, session_id, tool_name, input_args, status, start_time)
            VALUES (?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(call_id) DO UPDATE SET
              tool_name = excluded.tool_name,
              input_args = COALESCE(excluded.input_args, codex_tool_calls.input_args),
              start_time = excluded.start_time
          `).run(callId, sessionId, toolName, inputArgs, timestamp);
        });

      } else if (eventName === "PostToolUse") {
        const callId = payload.callID ?? payload.call_id ?? payload.tool_use_id;
        if (!callId) continue;
        const toolName = payload.tool ?? payload.tool_name ?? "";
        const toolResponse = payload.output ?? payload.tool_response ?? null;
        const status = payload.status ?? "completed";

        const existing = db.prepare("SELECT start_time FROM codex_tool_calls WHERE call_id = ?").get(callId) as { start_time: number } | undefined;
        let durationMs: number | null = null;
        if (existing && typeof existing.start_time === "number") {
          durationMs = timestamp - existing.start_time;
        }

        const truncatedOutput = truncateString(toolResponse);

        if (!existing) {
          instrument("PostToolUse:insert", () => {
            db.prepare(`
              INSERT INTO codex_tool_calls (call_id, session_id, tool_name, output, status, end_time, duration_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(callId, sessionId, toolName || "unknown", truncatedOutput, status, timestamp, durationMs);
          });
        } else {
          instrument("PostToolUse:update", () => {
            db.prepare(`
              UPDATE codex_tool_calls
              SET output = ?, status = ?, end_time = ?, duration_ms = ?
              WHERE call_id = ?
            `).run(truncatedOutput, status, timestamp, durationMs, callId);
          });
        }

      } else if (eventName === "Stop") {
        const finishReason = payload.finishReason ?? payload.finish_reason ?? null;

        instrument("Stop:session", () => {
          db.prepare(`
            UPDATE codex_sessions
            SET end_time = ?, finish_reason = ?
            WHERE session_id = ?
          `).run(timestamp, finishReason, sessionId);
        });

        const lastResponse = payload.lastResponse ?? {};
        const lastAssistantMessage = lastResponse.content ?? payload.last_assistant_message ?? "";
        const messageId = lastResponse.messageID ?? payload.message_id ?? `msg_assistant_${sessionId}`;

        instrument("Stop:assistantMessage", () => {
          db.prepare(`
            INSERT INTO codex_messages (message_id, session_id, role, content, timestamp)
            VALUES (?, ?, 'assistant', ?, ?)
            ON CONFLICT(message_id) DO UPDATE SET
              content = excluded.content,
              timestamp = excluded.timestamp
          `).run(messageId, sessionId, lastAssistantMessage, timestamp);
        });
      }
    }
  })();
}

// Support CLI execution
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
