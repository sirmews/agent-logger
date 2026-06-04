#!/usr/bin/env bun
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];

if (command === "view" || command === "viewer") {
  const viewerPath = resolve(__dirname, "../src/cli/viewer.ts");
  spawnSync("bun", ["run", viewerPath], { stdio: "inherit" });
} else {
  console.log(`
AgentLogger CLI

Usage:
  agent-logger view     Launch the local web dashboard to view telemetry
`);
}
