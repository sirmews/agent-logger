import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("Codex plugin packaging", () => {
  test("manifest uses fields accepted by Codex plugin validation", () => {
    const manifest = readJson(join(repoRoot, ".codex-plugin", "plugin.json")) as Record<string, unknown>;
    const allowedKeys = new Set([
      "id",
      "name",
      "version",
      "description",
      "skills",
      "apps",
      "mcpServers",
      "interface",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
    ]);

    for (const key of Object.keys(manifest)) {
      expect(allowedKeys.has(key), `unsupported manifest field: ${key}`).toBe(true);
    }

    const pluginInterface = manifest.interface as Record<string, unknown>;
    expect(pluginInterface.longDescription).toBeString();
    expect(pluginInterface.developerName).toBeString();
    expect(pluginInterface.defaultPrompt).toBeArray();
  });

  test("plugin exposes hook configuration through the conventional hooks directory", () => {
    const hooksPath = join(repoRoot, "hooks", "hooks.json");

    expect(existsSync(hooksPath)).toBe(true);

    const hookConfig = readJson(hooksPath) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };

    expect(hookConfig.hooks.SessionStart[0].hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(hookConfig.hooks.UserPromptSubmit[0].hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(hookConfig.hooks.PreToolUse[0].hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(hookConfig.hooks.PostToolUse[0].hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(hookConfig.hooks.Stop[0].hooks[0].command).toContain("${CLAUDE_PLUGIN_ROOT}");
  });
});
