import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { getIngestDb } from "../src/cli/ingest-db";
import { execSync, execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const TEST_DB_PATH = path.resolve("tests/codex-fixtures/mock-export-db.db");
const TEST_OUTPUT_PATH = path.resolve("tests/codex-fixtures/mock-export-output.jsonl");

describe("Codex Export CLI", () => {
  beforeEach(() => {
    // Cleanup files if any
    for (const file of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_OUTPUT_PATH]) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Ignore if unable to delete
        }
      }
    }
  });

  afterEach(() => {
    // Cleanup files after test
    for (const file of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`, TEST_OUTPUT_PATH]) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Ignore if unable to delete
        }
      }
    }
  });

  test("Successful seed, export with quality score filtering and secret redaction", () => {
    // 1. Seed database with getIngestDb
    const db = getIngestDb(TEST_DB_PATH);

    // Insert Session A (High Quality)
    db.prepare(`
      INSERT INTO codex_sessions (session_id, project_path, agent_name, model_provider, model_id, start_time, end_time, finish_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("session_a", "/path/to/project_a", "agent_a", "openai", "gpt-4", 1000, 2000, "stop");

    db.prepare(`
      INSERT INTO codex_messages (message_id, session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run("msg_a1", "session_a", "system", "You are a helpful assistant.", 1000);

    db.prepare(`
      INSERT INTO codex_messages (message_id, session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run("msg_a2", "session_a", "user", "Please run the tests.", 1100);

    db.prepare(`
      INSERT INTO codex_messages (message_id, session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run("msg_a3", "session_a", "assistant", "Tests passed successfully.", 1500);

    db.prepare(`
      INSERT INTO codex_tool_calls (call_id, session_id, tool_name, input_args, output, status, start_time, end_time, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("call_a1", "session_a", "Bash", "{}", "completed successfully", "completed", 1150, 1170, 20);

    db.prepare(`
      INSERT INTO codex_tool_calls (call_id, session_id, tool_name, input_args, output, status, start_time, end_time, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("call_a2", "session_a", "Read", "{}", "file content", "completed", 1200, 1210, 10);

    // Insert Session B (Low Quality with secrets)
    db.prepare(`
      INSERT INTO codex_sessions (session_id, project_path, agent_name, model_provider, model_id, start_time, end_time, finish_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("session_b", "/path/to/project_b", "agent_b", "anthropic", "claude-3-opus", 5000, 6000, "error");

    db.prepare(`
      INSERT INTO codex_messages (message_id, session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run("msg_b1", "session_b", "user", "Here is my secret Anthropic token: sk-ant-1234567890abcdef and Bearer my-secret-token", 5100);

    db.prepare(`
      INSERT INTO codex_tool_calls (call_id, session_id, tool_name, input_args, output, status, start_time, end_time, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("call_b1", "session_b", "Bash", "{}", "Error: permission denied", "error", 5200, 5300, 100);

    db.close();

    // 2. Run exporter CLI with --min-quality-score 0.7
    execFileSync("bun", ["src/cli/export.ts", "--db", TEST_DB_PATH, "--output", TEST_OUTPUT_PATH, "--min-quality-score", "0.7"], {
      encoding: "utf-8",
    });

    expect(fs.existsSync(TEST_OUTPUT_PATH)).toBe(true);

    const content = fs.readFileSync(TEST_OUTPUT_PATH, "utf-8").trim();
    const lines = content.split("\n").filter(Boolean);

    // Only Session A should be exported
    expect(lines.length).toBe(1);

    const parsedSessionA = JSON.parse(lines[0]);
    expect(parsedSessionA.metadata.session_id).toBe("session_a");
    expect(parsedSessionA.metadata.project).toBe("/path/to/project_a");
    expect(parsedSessionA.metadata.quality.score).toBeGreaterThan(0.7);

    // 3. Re-run with --min-quality-score 0.0 (export both) and verify redaction of Session B's content
    if (fs.existsSync(TEST_OUTPUT_PATH)) {
      fs.unlinkSync(TEST_OUTPUT_PATH);
    }

    // Set AGENT_LOGGER_EXTRA_REDACTION_PATTERNS to match sk-ant- keys
    const extraPatterns = "sk-ant-[a-zA-Z0-9]+";
    execFileSync("bun", ["src/cli/export.ts", "--db", TEST_DB_PATH, "--output", TEST_OUTPUT_PATH, "--min-quality-score", "0.0"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        AGENT_LOGGER_EXTRA_REDACTION_PATTERNS: extraPatterns,
      },
    });

    expect(fs.existsSync(TEST_OUTPUT_PATH)).toBe(true);

    const contentAll = fs.readFileSync(TEST_OUTPUT_PATH, "utf-8").trim();
    const linesAll = contentAll.split("\n").filter(Boolean);

    expect(linesAll.length).toBe(2);

    // Find the exported Session B line
    const parsedLines = linesAll.map((l) => JSON.parse(l));
    const sessionBExport = parsedLines.find((p) => p.metadata.session_id === "session_b");
    expect(sessionBExport).toBeDefined();

    // Verify redaction of secrets in Session B's messages
    const userMsg = sessionBExport.messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();

    // The secret should be redacted
    expect(userMsg.content).not.toContain("sk-ant-1234567890abcdef");
    expect(userMsg.content).not.toContain("Bearer my-secret-token");

    // Mask checks
    expect(userMsg.content).toContain("<<REDACTED_CUSTOM_001>>");
    expect(userMsg.content).toContain("<<REDACTED_BEARER_001>>");
  });

  test("Parser handles invalid non-numeric flags with safe fallback values", () => {
    const { parseArgs } = require("../src/cli/export");
    const parsed = parseArgs([
      "--db", "my.db",
      "--output", "out.jsonl",
      "--min-efficiency", "invalid-float",
      "--min-quality-score", "invalid-float",
      "--limit", "invalid-int"
    ]);

    expect(parsed.minEfficiency).toBe(0.0);
    expect(parsed.minQualityScore).toBe(0.0);
    expect(parsed.limit).toBe(50);
  });
});
