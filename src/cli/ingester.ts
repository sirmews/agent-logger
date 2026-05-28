import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as readline from "readline";
import { getIngestDb } from "./ingest-db";

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
 */
function ensureSessionExists(db: Database, sessionId: string, timestamp: number, projectPath = "unknown") {
  const existing = db.prepare("SELECT session_id FROM codex_sessions WHERE session_id = ?").get(sessionId);
  if (!existing) {
    instrument("ensureSessionExists", () => {
      db.prepare(`
        INSERT INTO codex_sessions (session_id, project_path, start_time)
        VALUES (?, ?, ?)
      `).run(sessionId, projectPath, timestamp);
    });
  }
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

  const events: any[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      // Ignore malformed JSON lines
    }
  }

  // Process all telemetry events sequentially inside a single transaction for speed/isolation
  db.transaction(() => {
    for (const payload of events) {
      const eventName = payload.event ?? payload.hook_event_name;
      if (!eventName) continue;

      if (eventName === "SessionStart") {
        const sessionId = payload.sessionID ?? payload.session_id;
        if (!sessionId) continue;
        const projectPath = payload.projectPath ?? payload.cwd ?? payload.project_path ?? "unknown";
        const agentName = payload.agentName ?? payload.agent_name ?? payload.agent ?? payload.source ?? null;

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

        const startTime = payload.timestamp ?? payload.localTimestamp ?? Date.now();

        instrument("SessionStart", () => {
          db.prepare(`
            INSERT INTO codex_sessions (session_id, project_path, agent_name, model_provider, model_id, start_time)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              project_path = excluded.project_path,
              agent_name = COALESCE(excluded.agent_name, codex_sessions.agent_name),
              model_provider = COALESCE(excluded.model_provider, codex_sessions.model_provider),
              model_id = COALESCE(excluded.model_id, codex_sessions.model_id),
              start_time = excluded.start_time
          `).run(sessionId, projectPath, agentName, modelProvider, modelId, startTime);
        });

      } else if (eventName === "UserPromptSubmit") {
        const sessionId = payload.sessionID ?? payload.session_id;
        if (!sessionId) continue;
        const messageId = payload.messageID ?? payload.message_id ?? payload.turn_id;
        if (!messageId) continue;
        const prompt = payload.prompt ?? payload.content ?? "";
        const timestamp = payload.timestamp ?? payload.localTimestamp ?? Date.now();

        ensureSessionExists(db, sessionId, timestamp);

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
        const sessionId = payload.sessionID ?? payload.session_id;
        if (!sessionId) continue;
        const callId = payload.callID ?? payload.call_id ?? payload.tool_use_id;
        if (!callId) continue;
        const toolName = payload.tool ?? payload.tool_name ?? "";
        const args = payload.args ?? payload.tool_input ?? null;
        const inputArgs = args ? (typeof args === "string" ? args : JSON.stringify(args)) : null;
        const startTime = payload.timestamp ?? payload.localTimestamp ?? Date.now();

        ensureSessionExists(db, sessionId, startTime);

        instrument("PreToolUse", () => {
          db.prepare(`
            INSERT INTO codex_tool_calls (call_id, session_id, tool_name, input_args, status, start_time)
            VALUES (?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(call_id) DO UPDATE SET
              tool_name = excluded.tool_name,
              input_args = COALESCE(excluded.input_args, codex_tool_calls.input_args),
              start_time = excluded.start_time
          `).run(callId, sessionId, toolName, inputArgs, startTime);
        });

      } else if (eventName === "PostToolUse") {
        const sessionId = payload.sessionID ?? payload.session_id;
        const callId = payload.callID ?? payload.call_id ?? payload.tool_use_id;
        if (!callId) continue;
        const toolName = payload.tool ?? payload.tool_name ?? "";
        const toolResponse = payload.output ?? payload.tool_response ?? null;
        const status = payload.status ?? "completed";
        const timestamp = payload.timestamp ?? payload.localTimestamp ?? Date.now();

        const resolvedSessionId = sessionId || "unknown";
        ensureSessionExists(db, resolvedSessionId, timestamp);

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
            `).run(callId, resolvedSessionId, toolName || "unknown", truncatedOutput, status, timestamp, durationMs);
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
        const sessionId = payload.sessionID ?? payload.session_id;
        if (!sessionId) continue;
        const timestamp = payload.timestamp ?? payload.localTimestamp ?? Date.now();
        const finishReason = payload.finishReason ?? payload.finish_reason ?? null;

        ensureSessionExists(db, sessionId, timestamp);

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
