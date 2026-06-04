import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveDbPath } from "../src/index.js";
import { getIngestDb } from "../src/cli/ingest-db.js";
import { CommunicationLoggerPlugin } from "../src/index.js";
import * as fs from "fs";
import * as path from "path";

const FIXTURES_DIR = path.resolve("tests/codex-fixtures");


describe("OpenCode Parity Contract", () => {
  const cleanupDb = (dbPath: string) => {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
      if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
    } catch (err) {}
  };

  beforeEach(() => {
    process.env.AGENT_LOGGER_DB_PATH = path.join(FIXTURES_DIR, `opencode-parity-${Date.now()}-${Math.random()}.db`);
    cleanupDb(process.env.AGENT_LOGGER_DB_PATH as string);
    const dbPath = process.env.AGENT_LOGGER_DB_PATH as string;
    if (dbPath && fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  afterEach(() => {
    cleanupDb(process.env.AGENT_LOGGER_DB_PATH as string);
  });

  test("OpenCode events map exactly to Codex tables", async () => {
    const plugin = await CommunicationLoggerPlugin({
      directory: "/tmp/parity-project",
      client: {
        app: {
          log: () => Promise.resolve(),
        },
      },
    } as any);

    // Send a session created event
    await plugin.event({
      event: {
        type: "session.created",
        properties: {
          sessionID: "opencode-session-1",
          time: 12345000,
          info: { title: "Parity Test", model: { providerID: "openai", modelID: "gpt-4o" } },
        },
      },
    } as any);

    // Send a tool execute event
    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "opencode-session-1",
          time: 12346000,
          part: {
            messageID: "msg-tool-1",
            type: "tool",
            tool: "Bash",
            callID: "call-xyz",
            state: { status: "pending", input: { command: "ls -la" } }
          }
        },
      },
    } as any);

    await plugin.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "opencode-session-1",
          time: 12347000,
          part: {
            messageID: "msg-tool-1",
            type: "tool",
            tool: "Bash",
            callID: "call-xyz",
            state: { status: "completed", output: "file.txt" }
          }
        },
      },
    } as any);

    // Send a finish event
    await plugin.event({
      event: {
        type: "message.updated",
        properties: {
          sessionID: "opencode-session-1",
          time: 12348000,
          info: {
            id: "msg-stop",
            role: "assistant",
            finish: "stop",
            summary: "I have listed the files.",
          }
        },
      },
    } as any);

    const db = getIngestDb(process.env.AGENT_LOGGER_DB_PATH as string);

    // Verify codex_sessions
    const session = db.prepare("SELECT * FROM codex_sessions WHERE session_id = ?").get("opencode-session-1") as any;
    expect(session).toBeDefined();
    expect(session.agent_name).toBe("opencode");
    expect(session.model_provider).toBe("openai");
    expect(session.model_id).toBe("gpt-4o");
    expect(session.project_path).toBe("/tmp/parity-project");
    expect(session.start_time).toBe(12345000);
    expect(session.end_time).toBe(12348000); // From the message.updated finish

    // Verify codex_tool_calls
    const toolCall = db.prepare("SELECT * FROM codex_tool_calls WHERE call_id = ?").get("call-xyz") as any;
    expect(toolCall).toBeDefined();
    expect(toolCall.session_id).toBe("opencode-session-1");
    expect(toolCall.tool_name).toBe("Bash");
    expect(JSON.parse(toolCall.input_args).command).toBe("ls -la");
    expect(toolCall.output).toBe("file.txt");
    expect(toolCall.status).toBe("completed");
    expect(toolCall.start_time).toBe(12346000);
    expect(toolCall.end_time).toBe(12347000);

    // Verify codex_messages (last response)
    const msg = db.prepare("SELECT * FROM codex_messages WHERE role = 'assistant' AND session_id = ?").get("opencode-session-1") as any;
    expect(msg).toBeDefined();
    expect(msg.content).toBe("I have listed the files.");

    db.close();
  });

  test("OpenCode tool error workflow", async () => {
    const plugin = await CommunicationLoggerPlugin({ directory: "/tmp/parity-project", client: { app: { log: () => Promise.resolve() } } } as any);
    
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "sess-error", time: 100, info: { title: "Error Test" } } } } as any);
    await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "sess-error", time: 110, part: { messageID: "m1", type: "tool", tool: "Bash", callID: "c1", state: { status: "pending", input: { command: "exit 1" } } } } } } as any);
    await plugin.event({ event: { type: "message.part.updated", properties: { sessionID: "sess-error", time: 120, part: { messageID: "m1", type: "tool", tool: "Bash", callID: "c1", state: { status: "error", error: "Command failed" } } } } } as any);
    await plugin.event({ event: { type: "message.updated", properties: { sessionID: "sess-error", time: 130, info: { id: "m2", role: "assistant", finish: "stop", summary: "It failed." } } } } as any);

    const db = getIngestDb(process.env.AGENT_LOGGER_DB_PATH as string);
    const tc = db.prepare("SELECT * FROM codex_tool_calls WHERE call_id = ?").get("c1") as any;
    expect(tc.status).toBe("error");
    expect(tc.output).toBe("Command failed");
    expect(tc.duration_ms).toBe(10);
    db.close();
  });

  test("OpenCode permission denied workflow", async () => {
    const plugin = await CommunicationLoggerPlugin({ directory: "/tmp/parity-project", client: { app: { log: () => Promise.resolve() } } } as any);
    
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "sess-perm", time: 200, info: { title: "Perm Test" } } } } as any);
    await plugin.event({ event: { type: "permission.asked", properties: { id: "req-1", sessionID: "sess-perm", permission: "Bash", metadata: { command: "rm -rf /" }, tool: { messageID: "m1", callID: "c1" } } } } as any);

    const db = getIngestDb(process.env.AGENT_LOGGER_DB_PATH as string);
    const perm = db.prepare("SELECT * FROM codex_permission_requests WHERE session_id = ?").get("sess-perm") as any;
    expect(perm.tool_name).toBe("Bash");
    expect(perm.permission_mode).toBe("ask");
    expect(JSON.parse(perm.tool_input).command).toBe("rm -rf /");
    db.close();
  });

  test("OpenCode compaction workflow", async () => {
    const plugin = await CommunicationLoggerPlugin({ directory: "/tmp/parity-project", client: { app: { log: () => Promise.resolve() } } } as any);
    
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "sess-compact", time: 300, info: { title: "Compact Test" } } } } as any);
    await plugin.event({ event: { type: "session.compacted", properties: { sessionID: "sess-compact", time: 350 } } } as any);

    const db = getIngestDb(process.env.AGENT_LOGGER_DB_PATH as string);
    const comp = db.prepare("SELECT * FROM codex_compact_events WHERE session_id = ?").get("sess-compact") as any;
    expect(comp.event_type).toBe("PostCompact");
    db.close();
  });
});

