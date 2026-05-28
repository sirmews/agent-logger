import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { getIngestDb } from "../src/cli/ingest-db";
import { ingestTelemetry } from "../src/cli/ingester";
import * as fs from "fs";
import * as path from "path";

const FIXTURES_DIR = path.resolve("tests/codex-fixtures");
const TEST_BUFFER_PATH = path.join(FIXTURES_DIR, "mock-telemetry-buffer.jsonl");
const TEST_DB_PATH = path.join(FIXTURES_DIR, "mock-codex-logs.db");

describe("Codex Ingester & DB Structuring Tests", () => {
  beforeEach(() => {
    // Ensure clean state before each test
    if (fs.existsSync(TEST_BUFFER_PATH)) {
      fs.unlinkSync(TEST_BUFFER_PATH);
    }
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    // WAL files cleanup if any
    if (fs.existsSync(`${TEST_DB_PATH}-wal`)) {
      fs.unlinkSync(`${TEST_DB_PATH}-wal`);
    }
    if (fs.existsSync(`${TEST_DB_PATH}-shm`)) {
      fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    }
  });

  afterEach(() => {
    // Clean up files after test
    if (fs.existsSync(TEST_BUFFER_PATH)) {
      fs.unlinkSync(TEST_BUFFER_PATH);
    }
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    if (fs.existsSync(`${TEST_DB_PATH}-wal`)) {
      fs.unlinkSync(`${TEST_DB_PATH}-wal`);
    }
    if (fs.existsSync(`${TEST_DB_PATH}-shm`)) {
      fs.unlinkSync(`${TEST_DB_PATH}-shm`);
    }
  });

  test("Database initialization creates schema tables with correct configuration", () => {
    const db = getIngestDb(TEST_DB_PATH);
    expect(db).toBeDefined();

    // Verify tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("codex_sessions");
    expect(tableNames).toContain("codex_messages");
    expect(tableNames).toContain("codex_tool_calls");

    // Verify WAL journal mode is active
    const journalMode = db.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
    expect(journalMode.journal_mode.toLowerCase()).toBe("wal");

    // Verify foreign keys are enabled
    const foreignKeys = db.prepare("PRAGMA foreign_keys;").get() as { foreign_keys: number };
    expect(foreignKeys.foreign_keys).toBe(1);

    db.close();
  });

  test("Ingest full compliant trajectory sequentially and query exact records", async () => {
    const trajectory = [
      {
        event: "SessionStart",
        sessionID: "session_id_456",
        timestamp: 1782348574000,
        projectPath: "/Users/nav/Projects/test-app",
        agentName: "codex-developer-agent",
        model: {
          provider: "anthropic",
          modelID: "claude-3-opus",
        },
      },
      {
        event: "UserPromptSubmit",
        sessionID: "session_id_456",
        messageID: "msg_user_456",
        prompt: "Run ls command",
        timestamp: 1782348580000,
      },
      {
        event: "PreToolUse",
        sessionID: "session_id_456",
        callID: "call_tool_456",
        tool: "Bash",
        args: {
          command: "ls -la",
        },
        timestamp: 1782348590000,
      },
      {
        event: "PostToolUse",
        sessionID: "session_id_456",
        callID: "call_tool_456",
        tool: "Bash",
        output: "src\ntests\npackage.json",
        status: "completed",
        timestamp: 1782348595500, // 5.5 seconds runtime duration (5500ms)
      },
      {
        event: "Stop",
        sessionID: "session_id_456",
        timestamp: 1782348610000,
        finishReason: "stop",
        lastResponse: {
          messageID: "msg_assistant_456",
          content: "The directory contains src, tests and package.json.",
        },
      },
    ];

    const lines = trajectory.map((event) => JSON.stringify(event)).join("\n");
    fs.writeFileSync(TEST_BUFFER_PATH, lines);

    const db = getIngestDb(TEST_DB_PATH);
    await ingestTelemetry(TEST_BUFFER_PATH, db);

    // Assertions on codex_sessions
    const session = db.prepare("SELECT * FROM codex_sessions WHERE session_id = ?").get("session_id_456") as any;
    expect(session).toBeDefined();
    expect(session.project_path).toBe("/Users/nav/Projects/test-app");
    expect(session.agent_name).toBe("codex-developer-agent");
    expect(session.model_provider).toBe("anthropic");
    expect(session.model_id).toBe("claude-3-opus");
    expect(session.start_time).toBe(1782348574000);
    expect(session.end_time).toBe(1782348610000);
    expect(session.finish_reason).toBe("stop");

    // Assertions on codex_messages (user)
    const userMsg = db.prepare("SELECT * FROM codex_messages WHERE message_id = ?").get("msg_user_456") as any;
    expect(userMsg).toBeDefined();
    expect(userMsg.session_id).toBe("session_id_456");
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toBe("Run ls command");
    expect(userMsg.timestamp).toBe(1782348580000);

    // Assertions on codex_messages (assistant)
    const assistantMsg = db.prepare("SELECT * FROM codex_messages WHERE message_id = ?").get("msg_assistant_456") as any;
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.session_id).toBe("session_id_456");
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("The directory contains src, tests and package.json.");
    expect(assistantMsg.timestamp).toBe(1782348610000);

    // Assertions on codex_tool_calls
    const toolCall = db.prepare("SELECT * FROM codex_tool_calls WHERE call_id = ?").get("call_tool_456") as any;
    expect(toolCall).toBeDefined();
    expect(toolCall.session_id).toBe("session_id_456");
    expect(toolCall.tool_name).toBe("Bash");
    expect(JSON.parse(toolCall.input_args).command).toBe("ls -la");
    expect(toolCall.output).toBe("src\ntests\npackage.json");
    expect(toolCall.status).toBe("completed");
    expect(toolCall.start_time).toBe(1782348590000);
    expect(toolCall.end_time).toBe(1782348595500);
    expect(toolCall.duration_ms).toBe(5500); // 1782348595500 - 1782348590000 = 5500

    db.close();
  });

  test("Ingest trajectory with tool error status", async () => {
    const trajectory = [
      {
        event: "SessionStart",
        sessionID: "sess_err",
        timestamp: 100,
        projectPath: "/Users/nav/Projects/err-app",
        agentName: "error-agent",
        model: "openai/gpt-4o",
      },
      {
        event: "PreToolUse",
        sessionID: "sess_err",
        callID: "call_err",
        tool: "Write",
        args: {
          filePath: "/invalid/path/file.txt",
        },
        timestamp: 200,
      },
      {
        event: "PostToolUse",
        sessionID: "sess_err",
        callID: "call_err",
        tool: "Write",
        output: "Error: Permission denied",
        status: "error",
        timestamp: 350,
      },
      {
        event: "Stop",
        sessionID: "sess_err",
        timestamp: 400,
        finishReason: "error",
        lastResponse: {
          content: "I encountered a permission error trying to write.",
        },
      },
    ];

    const lines = trajectory.map((event) => JSON.stringify(event)).join("\n");
    fs.writeFileSync(TEST_BUFFER_PATH, lines);

    const db = getIngestDb(TEST_DB_PATH);
    await ingestTelemetry(TEST_BUFFER_PATH, db);

    // Verify session
    const session = db.prepare("SELECT * FROM codex_sessions WHERE session_id = ?").get("sess_err") as any;
    expect(session.model_provider).toBe("openai");
    expect(session.model_id).toBe("gpt-4o");
    expect(session.finish_reason).toBe("error");

    // Verify message
    const assistantMsg = db.prepare("SELECT * FROM codex_messages WHERE session_id = ? AND role = 'assistant'").get("sess_err") as any;
    expect(assistantMsg.message_id).toBe("msg_assistant_sess_err");
    expect(assistantMsg.content).toBe("I encountered a permission error trying to write.");

    // Verify tool call
    const toolCall = db.prepare("SELECT * FROM codex_tool_calls WHERE call_id = ?").get("call_err") as any;
    expect(toolCall.status).toBe("error");
    expect(toolCall.output).toBe("Error: Permission denied");
    expect(toolCall.duration_ms).toBe(150); // 350 - 200

    db.close();
  });
});
