import { describe, expect, test } from "bun:test";
import { resolveDbPath } from "../src/index";
import { homedir } from "os";
import { join, resolve } from "path";

describe("DB path resolution", () => {
  test("uses explicit env precedence", () => {
    const env = {
      AGENT_LOGGER_DB_PATH: "/tmp/agent-logger/primary.db",
      COMMUNICATION_LOGGER_DB_PATH: "/tmp/agent-logger/secondary.db",
      OPENCODE_COMMUNICATION_LOGGER_DB_PATH: "/tmp/agent-logger/legacy.db",
    } as const;

    expect(resolveDbPath(env)).toBe(resolve("/tmp/agent-logger/primary.db"));
  });

  test("falls back to secondary env var", () => {
    const env = {
      COMMUNICATION_LOGGER_DB_PATH: "/tmp/agent-logger/secondary.db",
      OPENCODE_COMMUNICATION_LOGGER_DB_PATH: "/tmp/agent-logger/legacy.db",
    } as const;

    expect(resolveDbPath(env)).toBe(resolve("/tmp/agent-logger/secondary.db"));
  });

  test("falls back to legacy env var", () => {
    const env = {
      OPENCODE_COMMUNICATION_LOGGER_DB_PATH: "/tmp/agent-logger/legacy.db",
    } as const;

    expect(resolveDbPath(env)).toBe(resolve("/tmp/agent-logger/legacy.db"));
  });

  test("falls back to default path", () => {
    const resolved = resolveDbPath({});
    const defaultPath = resolve(join(homedir(), ".local", "share", "opencode", "communication-logs.db"));
    expect(resolved).toBe(defaultPath);
    expect(resolved).toContain("communication-logs.db");
  });
});
