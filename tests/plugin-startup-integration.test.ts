import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

type AppLogEntry = {
  body: {
    service?: string;
    level?: string;
    message?: string;
    extra?: Record<string, unknown>;
  };
};

async function loadPluginWithDbPath(dbPath: string): Promise<{
  plugin: any;
  logs: AppLogEntry[];
}> {
  process.env.AGENT_LOGGER_DB_PATH = dbPath;

  const modulePath = `../src/index.ts?run=${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const pluginModule = await import(modulePath);
  const pluginFactory = pluginModule.CommunicationLoggerPlugin;

  const logs: AppLogEntry[] = [];
  const plugin = await pluginFactory({
    directory: "/tmp/integration-project",
    client: {
      app: {
        log: (entry: AppLogEntry) => {
          logs.push(entry);
          return Promise.resolve();
        },
      },
    },
  } as any);

  return { plugin, logs };
}

describe("plugin startup and tool execution", () => {
  test("logs override db path warning when env overrides are used", async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "agent-logger-tests-"));
    const dbPath = resolve(tempDir, "custom-logger.db");

    const prev = process.env.AGENT_LOGGER_DB_PATH;
    let logs: AppLogEntry[] = [];
    try {
      ({ logs } = await loadPluginWithDbPath(dbPath));

      const warning = logs.find(
        (row) =>
          row.body?.message ===
          "Using override database path via environment variable",
      );

      expect(warning?.body?.extra).toBeDefined();
      expect(warning?.body?.extra?.dbPath).toBe(dbPath);
      expect(warning?.body?.extra?.defaultDbPath).toBe(
        "~/.local/share/opencode/communication-logs.db",
      );
    } finally {
      process.env.AGENT_LOGGER_DB_PATH = prev;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures if handles are still open.
      }
    }
  });

  test("warns when AGENT_LOGGER_EXTRA_REDACTION_PATTERNS contains invalid regex", async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "agent-logger-tests-"));
    const dbPath = resolve(tempDir, "invalid-patterns.db");

    const prevDbPath = process.env.AGENT_LOGGER_DB_PATH;
    const prevExtra = process.env.AGENT_LOGGER_EXTRA_REDACTION_PATTERNS;
    let logs: AppLogEntry[] = [];
    let plugin: any;
    try {
      process.env.AGENT_LOGGER_EXTRA_REDACTION_PATTERNS = "[unclosed";
      ({ plugin, logs } = await loadPluginWithDbPath(dbPath));

      await plugin.tool.export_training_data.execute({ redact: true, limit: 1 });

      const warning = logs.find(
        (row) => row.body?.message === "Ignoring invalid custom redaction patterns",
      );

      expect(warning?.body?.service).toBe("communication-logger");
      expect(warning?.body?.level).toBe("warn");
      expect(warning?.body?.extra?.invalidPatternCount).toBe(1);
      expect(warning?.body?.extra?.invalidPatterns).toEqual(["[unclosed"]);
    } finally {
      process.env.AGENT_LOGGER_DB_PATH = prevDbPath;
      process.env.AGENT_LOGGER_EXTRA_REDACTION_PATTERNS = prevExtra;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures if handles are still open.
      }
    }
  });

  test("can execute a plugin tool against a real plugin instance", async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "agent-logger-tests-"));
    const dbPath = resolve(tempDir, "integration.db");

    const prev = process.env.AGENT_LOGGER_DB_PATH;
    let plugin: any;
    try {
      ({ plugin } = await loadPluginWithDbPath(dbPath));
      const output = await plugin.tool.get_dashboard.execute({});

      const parsed = JSON.parse(output as string);
      expect(parsed.project).toBe("integration-project");
      expect(parsed.totals.total_sessions).toBe(0);
    } finally {
      process.env.AGENT_LOGGER_DB_PATH = prev;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures if handles are still open.
      }
    }
  });

  test("export_training_data returns telemetry and filters sessions correctly", async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "agent-logger-tests-"));
    const dbPath = resolve(tempDir, "export-test.db");
    const prev = process.env.AGENT_LOGGER_DB_PATH;

    try {
      const { plugin } = await loadPluginWithDbPath(dbPath);

      // 1. Manually populate DB via hooks to simulate two sessions
      // Session A: Success + High Efficiency
      await plugin.event({
        event: {
          type: "session.created",
          properties: { sessionID: "session-a", info: { title: "Good Session" } },
        },
      });
      await plugin.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-1",
              sessionID: "session-a",
              role: "user",
              time: { created: Date.now() },
            },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              messageID: "msg-1",
              sessionID: "session-a",
              type: "text",
              text: "Hello",
            },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-2",
              sessionID: "session-a",
              role: "assistant",
              finish: "stop",
              time: { created: Date.now(), completed: Date.now() },
            },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-2",
              messageID: "msg-2",
              sessionID: "session-a",
              type: "tool",
              tool: "test-tool",
              callID: "call-1",
              state: { status: "completed", output: "Success" },
            },
          },
        },
      });

      // Session B: Low Efficiency (will have 0 tool calls if we don't add them, or we can just trigger idle)
      await plugin.event({
        event: {
          type: "session.created",
          properties: { sessionID: "session-b", info: { title: "Bad Session" } },
        },
      });
      await plugin.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-3",
              sessionID: "session-b",
              role: "user",
              time: { created: Date.now() },
            },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-3",
              messageID: "msg-3",
              sessionID: "session-b",
              type: "text",
              text: "Broken",
            },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-4",
              sessionID: "session-b",
              role: "assistant",
              time: { created: Date.now() },
            },
          },
        },
      });

      // Trigger idle to refresh aggregates
      await plugin.event({
        event: { type: "session.status", properties: { sessionID: "session-a", status: { type: "idle" } } },
      });
      await plugin.event({
        event: { type: "session.status", properties: { sessionID: "session-b", status: { type: "idle" } } },
      });

      // 2. Export with high quality threshold
      const output = await plugin.tool.export_training_data.execute({
        min_quality_score: 0.7,
      });

      const parsed = JSON.parse(output as string);
      expect(parsed.summary.total_candidates).toBe(2);
      expect(parsed.summary.passed_threshold).toBe(1);
      expect(parsed.summary.min_quality_score).toBe(0.7);
      expect(parsed.jsonl).toContain("session-a");
      expect(parsed.jsonl).not.toContain("session-b");

      // 3. Verify JSONL schema
      const lines = parsed.jsonl.split("\n").filter(Boolean);
      const firstLine = JSON.parse(lines[0]);
      expect(firstLine.messages).toBeDefined();
      expect(firstLine.metadata.session_id).toBe("session-a");
      expect(firstLine.metadata.task_success).toBe(true);

    } finally {
      process.env.AGENT_LOGGER_DB_PATH = prev;
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore handles
      }
    }
  });
});
