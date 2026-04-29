import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

async function loadPluginWithDbPath(dbPath: string): Promise<any> {
  process.env.AGENT_LOGGER_DB_PATH = dbPath;
  const modulePath = `../../src/index.ts?run=${Date.now()}`;
  const pluginModule = await import(modulePath);
  return await pluginModule.CommunicationLoggerPlugin({
    directory: "/tmp/eval-project",
    client: { app: { log: () => Promise.resolve() } },
  } as any);
}

describe("evaluation harness", () => {
  test("exported data matches gold labels", async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "agent-logger-eval-"));
    const dbPath = resolve(tempDir, "eval.db");
    const goldLabelsPath = resolve(import.meta.dir, "gold_labels.jsonl");

    try {
      const plugin = await loadPluginWithDbPath(dbPath);

      // Seed DB to match gold_labels.jsonl
      await plugin.event({
        event: {
          type: "session.created",
          properties: { sessionID: "session-a", info: { title: "Eval Session" } },
        },
      });
      await plugin.event({
        event: {
          type: "message.updated",
          properties: {
            info: { id: "m1", sessionID: "session-a", role: "user", time: { created: Date.now() } },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: { id: "p1", messageID: "m1", sessionID: "session-a", type: "text", text: "Hello" },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.updated",
          properties: {
            info: { id: "m2", sessionID: "session-a", role: "assistant", finish: "stop", time: { created: Date.now() } },
          },
        },
      });
      await plugin.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: { id: "p2", messageID: "m2", sessionID: "session-a", type: "text", text: "Hi there" },
          },
        },
      });
      await plugin.event({
        event: {
          type: "session.status",
          properties: { sessionID: "session-a", status: { type: "idle" } },
        },
      });

      const output = await plugin.tool.export_training_data.execute({ min_efficiency: 0 });
      const { jsonl } = JSON.parse(output);
      
      const goldLines = readFileSync(goldLabelsPath, "utf-8").split("\n").filter(Boolean);
      const exportLines = jsonl.split("\n").filter(Boolean);

      expect(exportLines.length).toBeGreaterThanOrEqual(goldLines.length);

      const gold = JSON.parse(goldLines[0]);
      const exported = JSON.parse(exportLines[0]);

      expect(exported.messages[0].content).toBe(gold.messages[0].content);
      expect(exported.metadata.session_id).toBe(gold.metadata.session_id);
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });
});
