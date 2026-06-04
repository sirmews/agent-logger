import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { resolve, join } from "path";

const FIXTURES_DIR = resolve("tests/codex-fixtures");
const TEST_BUFFER_PATH = join(FIXTURES_DIR, "telemetry-buffer-test.jsonl");

describe("Codex Hook Commands Protocol Verification", () => {
  beforeAll(() => {
    if (existsSync(TEST_BUFFER_PATH)) {
      unlinkSync(TEST_BUFFER_PATH);
    }
    execSync("bun run build", { stdio: "inherit" });
  });

  beforeEach(() => {
    if (existsSync(TEST_BUFFER_PATH)) {
      unlinkSync(TEST_BUFFER_PATH);
    }
  });

  afterAll(() => {
    if (existsSync(TEST_BUFFER_PATH)) {
      unlinkSync(TEST_BUFFER_PATH);
    }
  });

  test("SessionStart hook produces v1 envelope with --start", () => {
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

    expect(existsSync(TEST_BUFFER_PATH)).toBe(true);
    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.schema_version).toBe(1);
    expect(record.source_agent).toBe("codex");
    expect(record.source_event).toBe("SessionStart");
    expect(record.session_id).toBe("session_test_123");
    expect(record.captured_at).toBeTypeOf("number");
    expect(record.record_id).toBeTypeOf("string");
    expect(record.model).toBe("gpt-5.4");
    expect(record.permission_mode).toBe("default");
    expect(record.session_source).toBe("startup");
    expect(record.transcript_path).toBe("/tmp/codex-transcripts/session_test_123.jsonl");
    expect(record.raw.sessionID).toBe("session_test_123");
    expect(record.raw.model).toBe("gpt-5.4");
    expect(record.normalized.session_source).toBe("startup");
    expect(record.git_context).toBeDefined();
  });

  test("Stop hook produces v1 envelope with --stop", () => {
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

    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.schema_version).toBe(1);
    expect(record.source_event).toBe("Stop");
    expect(record.session_id).toBe("session_test_123");
    expect(record.stop_hook_active).toBe(false);
    expect(record.normalized.finish_reason).toBe("stop");
    expect(record.normalized.stop_hook_active).toBe(false);
    expect(record.raw.finishReason).toBe("stop");
    expect(record.git_context).toBeDefined();
  });

  test("UserPromptSubmit hook produces v1 envelope with --prompt", () => {
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

    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.schema_version).toBe(1);
    expect(record.source_event).toBe("UserPromptSubmit");
    expect(record.session_id).toBe("session_test_123");
    expect(record.turn_id).toBe("turn_1");
    expect(record.normalized.message_id).toBe("msg_user_1");
    expect(record.normalized.prompt).toContain("capital of France");
    expect(record.raw.prompt).toContain("capital of France");
    expect(record.transcript_path).toBe("/tmp/codex-transcripts/session_test_123.jsonl");
  });

  test("PreToolUse hook produces v1 envelope with --before", () => {
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

    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.schema_version).toBe(1);
    expect(record.source_event).toBe("PreToolUse");
    expect(record.session_id).toBe("session_test_123");
    expect(record.turn_id).toBe("turn_1");
    expect(record.normalized.tool_name).toBe("Bash");
    expect(record.normalized.tool_use_id).toBe("call_tool_1");
    expect(record.normalized.turn_id).toBe("turn_1");
    expect(record.normalized.command).toBe("ls -la");
    expect(record.raw.callID).toBe("call_tool_1");
    expect(record.raw.tool).toBe("Bash");
  });

  test("PostToolUse hook produces v1 envelope with --after", () => {
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

    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.schema_version).toBe(1);
    expect(record.source_event).toBe("PostToolUse");
    expect(record.session_id).toBe("session_test_123");
    expect(record.turn_id).toBe("turn_1");
    expect(record.normalized.tool_name).toBe("Bash");
    expect(record.normalized.status).toBe("completed");
    expect(record.raw.callID).toBe("call_tool_1");
    expect(record.raw.tool).toBe("Bash");
  });

  test("PermissionRequest hook produces v1 envelope", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "permission-request.json"), "utf-8");
    const result = execSync("node ./dist/hooks/permission.js", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.decision).toBe("allow");

    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.schema_version).toBe(1);
    expect(record.source_event).toBe("PermissionRequest");
    expect(record.session_id).toBe("session_test_123");
    expect(record.turn_id).toBe("turn_2");
    expect(record.permission_mode).toBe("default");
    expect(record.normalized.tool_name).toBe("Bash");
    expect(record.normalized.permission_mode).toBe("default");
    expect(record.normalized.agent_id).toBe("agent_main");
    expect(record.normalized.agent_type).toBe("codex-developer");
    expect(record.raw.tool_name).toBe("Bash");
  });

  test("PreCompact hook produces v1 envelope", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "pre-compact.json"), "utf-8");
    const result = execSync("node ./dist/hooks/compact.js --pre", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);

    const lines = readFileSync(TEST_BUFFER_PATH, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.schema_version).toBe(1);
    expect(record.source_event).toBe("PreCompact");
    expect(record.turn_id).toBe("turn_5");
    expect(record.normalized.reason).toBe("context_window_exceeded");
  });

  test("PostCompact hook produces v1 envelope", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "post-compact.json"), "utf-8");
    const result = execSync("node ./dist/hooks/compact.js --post", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);

    const record = JSON.parse(readFileSync(TEST_BUFFER_PATH, "utf-8").trim());
    expect(record.source_event).toBe("PostCompact");
  });

  test("SubagentStart hook produces v1 envelope", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "subagent-start.json"), "utf-8");
    const result = execSync("node ./dist/hooks/subagent.js --start", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);

    const record = JSON.parse(readFileSync(TEST_BUFFER_PATH, "utf-8").trim());
    expect(record.source_event).toBe("SubagentStart");
    expect(record.normalized.subagent_id).toBe("subagent_1");
    expect(record.normalized.parent_turn_id).toBe("turn_3");
    expect(record.normalized.agent_type).toBe("codex-search");
  });

  test("SubagentStop hook produces v1 envelope", () => {
    const mockStdin = readFileSync(join(FIXTURES_DIR, "subagent-stop.json"), "utf-8");
    const result = execSync("node ./dist/hooks/subagent.js --stop", {
      input: mockStdin,
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);

    const record = JSON.parse(readFileSync(TEST_BUFFER_PATH, "utf-8").trim());
    expect(record.source_event).toBe("SubagentStop");
    expect(record.normalized.subagent_id).toBe("subagent_1");
  });

  test("Hook fails safe with no stdin (does not block agent)", () => {
    const result = execSync("node ./dist/hooks/session.js --start", {
      input: "",
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);
  });

  test("Hook fails safe with invalid JSON stdin", () => {
    const result = execSync("node ./dist/hooks/tool.js --before", {
      input: "not valid json{{{",
      encoding: "utf-8",
      env: {
        ...process.env,
        CODEX_TELEMETRY_BUFFER_PATH: TEST_BUFFER_PATH,
      },
    });

    const parsedStdout = JSON.parse(result.trim());
    expect(parsedStdout.continue).toBe(true);
  });
});
