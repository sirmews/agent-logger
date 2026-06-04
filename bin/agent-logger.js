#!/usr/bin/env bun
import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";
import * as os from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2];

if (command === "view" || command === "viewer") {
  const viewerPath = resolve(__dirname, "../src/cli/viewer.ts");
  spawnSync("bun", ["run", viewerPath], { stdio: "inherit" });
} else if (command === "ingest") {
  // Resolve paths
  const dbPath = process.env.AGENT_LOGGER_DB_PATH ?? 
    process.env.COMMUNICATION_LOGGER_DB_PATH ?? 
    process.env.OPENCODE_COMMUNICATION_LOGGER_DB_PATH ?? 
    resolve(os.homedir(), ".local", "share", "opencode", "communication-logs.db");

  let defaultBufferPath;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || resolve(os.homedir(), 'AppData', 'Roaming');
    defaultBufferPath = resolve(appData, 'codex', 'telemetry-buffer.jsonl');
  } else {
    defaultBufferPath = resolve(os.homedir(), '.local', 'share', 'codex', 'telemetry-buffer.jsonl');
  }
  const bufferPath = process.env.CODEX_TELEMETRY_BUFFER_PATH ?? defaultBufferPath;

  console.log(`Ingesting Codex Telemetry...`);
  console.log(`Buffer: ${bufferPath}`);
  console.log(`DB:     ${dbPath}\n`);

  if (!fs.existsSync(bufferPath)) {
    console.log("No telemetry buffer found. Nothing to ingest.");
    process.exit(0);
  }

  const ingesterPath = resolve(__dirname, "../src/cli/ingester.ts");
  const result = spawnSync("bun", ["run", ingesterPath, "--buffer", bufferPath, "--db", dbPath], { stdio: "inherit" });

  if (result.status === 0) {
    // Truncate the buffer file after successful ingestion to avoid re-reading massive files
    fs.truncateSync(bufferPath, 0);
    console.log(`\nSuccess! Buffer cleared. You can now run 'agent-logger view' to see the imported Codex runs.`);
  } else {
    console.error(`\nIngestion failed with exit code ${result.status}. Buffer was not cleared.`);
    process.exit(result.status ?? 1);
  }
} else {
  console.log(`
AgentLogger CLI

Usage:
  agent-logger view     Launch the local web dashboard to view telemetry
  agent-logger ingest   Parse the offline Codex JSONL buffer into the SQLite database
`);
}
