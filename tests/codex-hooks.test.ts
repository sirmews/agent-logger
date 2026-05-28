import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { resolve, join } from "path";

const FIXTURES_DIR = resolve("tests/codex-fixtures");
const TEST_BUFFER_PATH = join(FIXTURES_DIR, "telemetry-buffer-test.jsonl");

describe("Codex Hook Commands Protocol Verification", () => {
  // Before running tests, ensure we compile the latest TypeScript hooks.
  beforeAll(() => {
    // If the test buffer exists, clean it up.
    if (existsSync(TEST_BUFFER_PATH)) {
      unlinkSync(TEST_BUFFER_PATH);
    }
    // Compile using the build script
    execSync("bun run build", { stdio: "inherit" });

    // Copy dist/src/hooks to dist/hooks to match the spec path expectation
    const fs = require("fs");
    if (fs.existsSync("dist/src/hooks")) {
      fs.cpSync("dist/src/hooks", "dist/hooks", { recursive: true });
    }
  });

  // Clear test buffer before each test to isolate states and allow independent runs
  beforeEach(() => {
    if (existsSync(TEST_BUFFER_PATH)) {
      unlinkSync(TEST_BUFFER_PATH);
    }
  });

  afterAll(() => {
    // Clean up test buffer
    if (existsSync(TEST_BUFFER_PATH)) {
      unlinkSync(TEST_BUFFER_PATH);
    }
  });

  test("SessionStart hook completes successfully with --start", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "start.json"), "utf-8");
    const result = execSync("node ./dist/hooks/session.js --start", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);
    expect(parsedStdout.systemMessage).toBeNull();

    // Verify written buffer line
    expect(existsSync(TEST_BUFFER_PATH)).toBe(true);
    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("SessionStart");
    expect(record.type).toBe("task_started");
    expect(record.sessionID).toBe("session_test_123");
    expect(record.projectPath).toBe("/Users/nav/Projects/my-app");
    expect(record.localTimestamp).toBeTypeOf("number");
  });

  test("Stop hook completes successfully with --stop", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "stop.json"), "utf-8");
    const result = execSync("node ./dist/hooks/session.js --stop", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);

    // Verify written buffer line
    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("Stop");
    expect(record.type).toBe("task_complete");
    expect(record.sessionID).toBe("session_test_123");
    expect(record.finishReason).toBe("stop");
    expect(record.lastResponse.content).toBe("The capital of France is Paris.");
    expect(record.localTimestamp).toBeTypeOf("number");
  });

  test("UserPromptSubmit hook completes successfully with --prompt", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "prompt.json"), "utf-8");
    const result = execSync("node ./dist/hooks/message.js --prompt", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);

    // Verify written buffer line
    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("UserPromptSubmit");
    expect(record.sessionID).toBe("session_test_123");
    expect(record.messageID).toBe("msg_user_1");
    expect(record.prompt).toContain("capital of France");
    expect(record.localTimestamp).toBeTypeOf("number");
  });

  test("PreToolUse hook completes successfully with --before", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "pre-tool.json"), "utf-8");
    const result = execSync("node ./dist/hooks/tool.js --before", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);

    // Verify written buffer line
    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("PreToolUse");
    expect(record.sessionID).toBe("session_test_123");
    expect(record.callID).toBe("call_tool_1");
    expect(record.tool).toBe("Execute");
    expect(record.args.command).toBe("ls -la");
    expect(record.localTimestamp).toBeTypeOf("number");
  });

  test("PostToolUse hook completes successfully with --after", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "post-tool.json"), "utf-8");
    const result = execSync("node ./dist/hooks/tool.js --after", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);

    // Verify written buffer line
    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.event).toBe("PostToolUse");
    expect(record.sessionID).toBe("session_test_123");
    expect(record.callID).toBe("call_tool_1");
    expect(record.tool).toBe("Execute");
    expect(record.status).toBe("completed");
    expect(record.output).toContain("total 40");
    expect(record.localTimestamp).toBeTypeOf("number");
  });
});
