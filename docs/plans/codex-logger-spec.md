# Spec-First Implementation Plan: Codex Communication Logger

This document serves as the formal specification and technical implementation plan for porting the Communication Logger capability to the **Codex CLI (`codex-rs`)** platform.

It follows a **Spec-First Feature Implementation** methodology: all interfaces, stdin/stdout data contracts, schema constraints, and verification harnesses are defined prior to writing application logic.

---

## 1. Architectural Design Principles

To meet the requirements of **zero-latency overhead (no slowdown)**, **absolute fail-safe execution (no bugs)**, and **high-fidelity training logs**, the system separates telemetry recording into a **Hot Path** (run during the session) and a **Cold Path** (run offline/on-demand).

### 1.1 The Hot Path (Recording)
* **Design:** Zero-overhead atomic appends.
* **Mechanism:** Spun-up hook commands never open SQLite, take locks, or execute SQL. They read Codex's payload from `stdin`, add a local timestamp, and atomically append it to a raw JSONL telemetry buffer (`~/.local/share/codex/telemetry-buffer.jsonl`) using atomic `O_APPEND` file writes.
* **Fail-Safe Guard:** The hook command wraps its entire routine in a global `try...catch`. If file access fails, it silently outputs `{"continue": true}` to `stdout` and exits with code `0`. Codex is never blocked, slowed, or disrupted.

### 1.2 The Cold Path (Structuring & Grading)
* **Design:** Offline ingestion and curation.
* **Mechanism:** When exporting data, an offline ingester tool parses the `telemetry-buffer.jsonl` file, reconciles turn-by-turn conversational records (matching prompts with completions and tool calls), and populates a normalized local SQLite database for training-set curation and export.

```text
 [Codex Engine]
        │
        │ 1. Spawn hook command (Only on matched events)
        │ 2. Pipe input JSON via Stdin
        ▼
┌──────────────────────────────┐
│  node ./dist/hooks/<type>.js │ ◄── [Fail-Safe / Try-Catch Guard]
└──────────────┬───────────────┘
               │
               │ 3. Atomic File Append (O_APPEND write, target: <3ms)
               ▼
┌───────────────────────────────────────────────┐
│ ~/.local/share/codex/telemetry-buffer.jsonl   │
└──────────────────────┬────────────────────────┘
                       │
                       │ 4. Offline Ingestion & Quality Grading (Cold Path)
                       ▼
┌───────────────────────────────────────────────┐
│     Normalized SQLite DB & SFT Export         │
└───────────────────────────────────────────────┘
```

---

## 2. Stdin / Stdout Protocol Specifications (Factual Data Contracts)

Every executable hook must satisfy these strict schema contracts, derived from real-world telemetry stream checks:

### 2.1 `SessionStart` Hook
Fires when a new agent session is initiated.
* **Event Name:** `SessionStart` (triggered by Codex `"type": "task_started"`)
* **CLI Trigger:** `node ./dist/hooks/session.js --start`
* **Input Schema (`stdin`):**
  ```json
  {
    "session_id": "string",
    "cwd": "string",
    "hook_event_name": "SessionStart",
    "model": "string",
    "permission_mode": "string",
    "source": "string"
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true,
    "systemMessage": null
  }
  ```

### 2.2 `UserPromptSubmit` Hook
Fires immediately after a user submits a chat message but before the LLM generates a response.
* **Event Name:** `UserPromptSubmit`
* **CLI Trigger:** `node ./dist/hooks/message.js --prompt`
* **Input Schema (`stdin`):**
  ```json
  {
    "session_id": "string",
    "turn_id": "string",
    "cwd": "string",
    "hook_event_name": "UserPromptSubmit",
    "model": "string",
    "prompt": "string"
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.3 `PreToolUse` Hook
Fires directly before Codex executes any local tool or MCP command.
* **Event Name:** `PreToolUse`
* **CLI Trigger:** `node ./dist/hooks/tool.js --before`
* **Input Schema (`stdin`):**
  ```json
  {
    "session_id": "string",
    "turn_id": "string",
    "cwd": "string",
    "hook_event_name": "PreToolUse",
    "tool_name": "string",
    "tool_input": {},
    "tool_use_id": "string"
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.4 `PostToolUse` Hook
Fires immediately after a local tool or MCP command completes execution.
* **Event Name:** `PostToolUse`
* **CLI Trigger:** `node ./dist/hooks/tool.js --after`
* **Input Schema (`stdin`):**
  ```json
  {
    "session_id": "string",
    "turn_id": "string",
    "cwd": "string",
    "hook_event_name": "PostToolUse",
    "tool_name": "string",
    "tool_input": {},
    "tool_response": "string",
    "tool_use_id": "string"
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.5 `Stop` Hook (Captures the Assistant Response / General Feedback)
Fires when the session or turn terminates.
* **Event Name:** `Stop`
* **CLI Trigger:** `node ./dist/hooks/session.js --stop`
* **Input Schema (`stdin`):**
  ```json
  {
    "session_id": "string",
    "turn_id": "string",
    "cwd": "string",
    "hook_event_name": "Stop",
    "last_assistant_message": "string"
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

---

## 3. SQLite Database Schema (Target Cold-Path Storage)

For structured query capabilities, grading, and curation, the JSONL log buffer is ingested offline into a local SQLite database named `codex-communication-logs.db` stored in a cross-platform location (resolved via standard Node.js logic to fall back to `%APPDATA%` on Windows or `~/.local/share/` on POSIX systems).

Upon connection initialization, the ingestion wrapper:
1. Recursively ensures parent directories are provisioned on disk.
2. Enables foreign key support: `PRAGMA foreign_keys = ON;`.
3. Set write-ahead logging: `PRAGMA journal_mode = WAL;`.
4. Configures database locking busy timeout: `.busyTimeout(5000)`.

```sql
CREATE TABLE IF NOT EXISTS codex_sessions (
  session_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  agent_name TEXT,
  model_provider TEXT,
  model_id TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  finish_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS codex_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS codex_tool_calls (
  call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_args TEXT, -- JSON-stringified payload
  output TEXT,     -- Truncated to 200KB max
  status TEXT,     -- 'pending' | 'completed' | 'error'
  start_time INTEGER,
  end_time INTEGER,
  duration_ms INTEGER,
  inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
);
```

---

## 4. Test-Driven Verification Harness

To confirm correctness without executing a full instance of Codex CLI, write local validation scripts to mock input/output streams.

1. **Create Mock Payloads** (`tests/codex-fixtures/*.json`):
   Create exact mock payloads matching the specified stdin shapes.

2. **Run Harness Tests** (`tests/codex-hooks.test.ts`):
   Use the runtime to verify program contracts:
   ```typescript
   import { describe, expect, test } from "bun:test";
   import { execSync } from "child_process";
   import { readFileSync } from "fs";

   describe("Codex Hook Commands Protocol Verification", () => {
     test("PreToolUse CLI parses stdin and outputs compliant stdout", () => {
       const mockStdin = readFileSync("tests/codex-fixtures/pre-tool.json", "utf-8");
       const result = execSync("node ./dist/hooks/tool.js --before", {
         input: mockStdin,
         encoding: "utf-8"
       });
       const parsed = JSON.parse(result.trim());
       expect(parsed.continue).toBe(true);
     });
   });
   ```

---

## 5. Codex Plugin Manifest Configuration

To register the logger with Codex CLI, keep presentation metadata in `.codex-plugin/plugin.json` and expose hook commands through `hooks/hooks.json`:

```json
{
  "name": "codex-communication-logger",
  "version": "1.0.0",
  "description": "Telemetry and training corpus logger for Codex CLI",
  "author": {
    "name": "Nav"
  },
  "interface": {
    "displayName": "Codex Telemetry Logger",
    "shortDescription": "Ensures every local action is structured and logged safely.",
    "longDescription": "Captures Codex session, prompt, tool, and stop events through low-latency hooks, then writes them to a local telemetry buffer for offline ingestion and export.",
    "developerName": "Nav",
    "category": "Developer Tools",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Check whether Codex telemetry is being captured."
    ]
  }
}
```

The accompanying `hooks/hooks.json` links Codex's lifecycle handlers directly to our compiled, lightweight CLI entrypoints and registers standard regex filters on tool tools to minimize latency.

```json
{
  "SessionStart": [
    {
      "command": "node ./dist/hooks/session.js --start",
      "timeoutSec": 5
    }
  ],
  "UserPromptSubmit": [
    {
      "command": "node ./dist/hooks/message.js --prompt",
      "timeoutSec": 5
    }
  ],
  "PreToolUse": [
    {
      "command": "node ./dist/hooks/tool.js --before",
      "matcher": "^(Write|Edit|MultiEdit|Bash|Execute)$",
      "timeoutSec": 5
    }
  ],
  "PostToolUse": [
    {
      "command": "node ./dist/hooks/tool.js --after",
      "matcher": "^(Write|Edit|MultiEdit|Bash|Execute)$",
      "timeoutSec": 5
    }
  ],
  "Stop": [
    {
      "command": "node ./dist/hooks/session.js --stop",
      "timeoutSec": 5
    }
  ]
}
```

---

## 2. Stdin / Stdout Protocol Specifications (Data Contracts)

Every executable hook must satisfy these strict schema contracts.

### 2.1 `SessionStart` Hook
Fires when a new agent session is initiated.
* **Event Name:** `SessionStart` (triggered by Codex `"type": "task_started"`)
* **CLI Trigger:** `node ./dist/hooks/session.js --start`
* **Input Schema (`stdin`):**
  ```json
  {
    "type": "task_started",
    "sessionID": "string",
    "timestamp": 1782348574000,
    "projectPath": "string",
    "agentName": "string",
    "model": {
      "provider": "string",
      "modelID": "string"
    }
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true,
    "systemMessage": null
  }
  ```

### 2.2 `UserPromptSubmit` Hook
Fires immediately after a user submits a chat message but before the LLM generates a response.
* **Event Name:** `UserPromptSubmit`
* **CLI Trigger:** `node ./dist/hooks/message.js --prompt`
* **Input Schema (`stdin`):**
  ```json
  {
    "sessionID": "string",
    "messageID": "string",
    "prompt": "string",
    "timestamp": 1782348580000
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.3 `PreToolUse` Hook
Fires directly before Codex executes any local tool or MCP command.
* **Event Name:** `PreToolUse`
* **CLI Trigger:** `node ./dist/hooks/tool.js --before`
* **Input Schema (`stdin`):**
  ```json
  {
    "sessionID": "string",
    "callID": "string",
    "tool": "string",
    "args": {},
    "timestamp": 1782348590000
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.4 `PostToolUse` Hook
Fires immediately after a local tool or MCP command completes execution.
* **Event Name:** `PostToolUse`
* **CLI Trigger:** `node ./dist/hooks/tool.js --after`
* **Input Schema (`stdin`):**
  ```json
  {
    "sessionID": "string",
    "callID": "string",
    "tool": "string",
    "output": "string",
    "status": "completed" | "error",
    "timestamp": 1782348598000
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.5 `Stop` Hook (Captures the Assistant Response / General Feedback)
Fires when the session or turn terminates. Triggered by Codex `"type": "agent-turn-complete"` or `"type": "task_complete"`.
* **Event Name:** `Stop`
* **CLI Trigger:** `node ./dist/hooks/session.js --stop`
* **Input Schema (`stdin`):**
  ```json
  {
    "type": "agent-turn-complete" | "task_complete",
    "sessionID": "string",
    "timestamp": 1782348610000,
    "finishReason": "stop" | "error" | "cancelled",
    "lastResponse": {
      "messageID": "string",
      "content": "string"
    }
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

---

## 3. SQLite Database Schema (Target Cold-Path Storage)

For structured query capabilities, grading, and curation, the JSONL log buffer is ingested offline into a local SQLite database named `codex-communication-logs.db` stored in a cross-platform location (resolved via standard Node.js logic to fall back to `%APPDATA%` on Windows or `~/.local/share/` on POSIX systems).

Upon connection initialization, the ingestion wrapper:
1. Recursively ensures parent directories are provisioned on disk.
2. Enables foreign key support: `PRAGMA foreign_keys = ON;`.
3. Set write-ahead logging: `PRAGMA journal_mode = WAL;`.
4. Configures database locking busy timeout: `.busyTimeout(5000)`.

```sql
CREATE TABLE IF NOT EXISTS codex_sessions (
  session_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  agent_name TEXT,
  model_provider TEXT,
  model_id TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  finish_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS codex_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS codex_tool_calls (
  call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_args TEXT, -- JSON-stringified payload
  output TEXT,     -- Truncated to 200KB max
  status TEXT,     -- 'pending' | 'completed' | 'error'
  start_time INTEGER,
  end_time INTEGER,
  duration_ms INTEGER,
  inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
);
```

---

## 4. Test-Driven Verification Harness

To confirm correctness without executing a full instance of Codex CLI, write local validation scripts to mock input/output streams.

1. **Create Mock Payloads** (`tests/codex-fixtures/*.json`):
   Create exact mock payloads matching the specified stdin shapes.

2. **Run Harness Tests** (`tests/codex-hooks.test.ts`):
   Use the runtime to verify program contracts:
   ```typescript
   import { describe, expect, test } from "bun:test";
   import { execSync } from "child_process";
   import { readFileSync } from "fs";

   describe("Codex Hook Commands Protocol Verification", () => {
     test("PreToolUse CLI parses stdin and outputs compliant stdout", () => {
       const mockStdin = readFileSync("tests/codex-fixtures/pre-tool.json", "utf-8");
       const result = execSync("node ./dist/hooks/tool.js --before", {
         input: mockStdin,
         encoding: "utf-8"
       });
       const parsed = JSON.parse(result.trim());
       expect(parsed.continue).toBe(true);
     });
   });
   ```

---

## 5. Codex Plugin Manifest Configuration

To register the logger with Codex CLI, keep presentation metadata in `.codex-plugin/plugin.json` and expose hook commands through `hooks/hooks.json`:

```json
{
  "name": "codex-communication-logger",
  "version": "1.0.0",
  "description": "Telemetry and training corpus logger for Codex CLI",
  "author": {
    "name": "Nav"
  },
  "interface": {
    "displayName": "Codex Telemetry Logger",
    "shortDescription": "Ensures every local action is structured and logged safely.",
    "longDescription": "Captures Codex session, prompt, tool, and stop events through low-latency hooks, then writes them to a local telemetry buffer for offline ingestion and export.",
    "developerName": "Nav",
    "category": "Developer Tools",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Check whether Codex telemetry is being captured."
    ]
  }
}
```

The accompanying `hooks/hooks.json` links Codex's lifecycle handlers directly to our compiled, lightweight CLI entrypoints and registers standard regex filters on tool tools to minimize latency.

```json
{
  "SessionStart": [
    {
      "command": "node ./dist/hooks/session.js --start",
      "timeoutSec": 5
    }
  ],
  "UserPromptSubmit": [
    {
      "command": "node ./dist/hooks/message.js --prompt",
      "timeoutSec": 5
    }
  ],
  "PreToolUse": [
    {
      "command": "node ./dist/hooks/tool.js --before",
      "matcher": "^(Write|Edit|MultiEdit|Bash|Execute)$",
      "timeoutSec": 5
    }
  ],
  "PostToolUse": [
    {
      "command": "node ./dist/hooks/tool.js --after",
      "matcher": "^(Write|Edit|MultiEdit|Bash|Execute)$",
      "timeoutSec": 5
    }
  ],
  "Stop": [
    {
      "command": "node ./dist/hooks/session.js --stop",
      "timeoutSec": 5
    }
  ]
}
```

---

## 2. Stdin / Stdout Protocol Specifications (Data Contracts)

Every executable hook must satisfy these strict schema contracts.

### 2.1 `SessionStart` Hook
Fires when a new agent session is initiated.
* **Event Name:** `SessionStart`
* **CLI Trigger:** `node ./dist/hooks/session.js --start`
* **Input Schema (`stdin`):**
  ```json
  {
    "sessionID": "string",
    "timestamp": 1782348574000,
    "projectPath": "string",
    "agentName": "string",
    "model": {
      "provider": "string",
      "modelID": "string"
    }
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true,
    "systemMessage": null
  }
  ```

### 2.2 `UserPromptSubmit` Hook
Fires immediately after a user submits a chat message but before the LLM generates a response.
* **Event Name:** `UserPromptSubmit`
* **CLI Trigger:** `node ./dist/hooks/message.js --prompt`
* **Input Schema (`stdin`):**
  ```json
  {
    "sessionID": "string",
    "messageID": "string",
    "prompt": "string",
    "timestamp": 1782348580000
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.3 `PreToolUse` Hook
Fires directly before Codex executes any local tool or MCP command.
* **Event Name:** `PreToolUse`
* **CLI Trigger:** `node ./dist/hooks/tool.js --before`
* **Input Schema (`stdin`):**
  ```json
  {
    "sessionID": "string",
    "callID": "string",
    "tool": "string",
    "args": {},
    "timestamp": 1782348590000
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.4 `PostToolUse` Hook
Fires immediately after a local tool or MCP command completes execution.
* **Event Name:** `PostToolUse`
* **CLI Trigger:** `node ./dist/hooks/tool.js --after`
* **Input Schema (`stdin`):**
  ```json
  {
    "sessionID": "string",
    "callID": "string",
    "tool": "string",
    "output": "string",
    "status": "completed" | "error",
    "timestamp": 1782348598000
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

### 2.5 `Stop` Hook (Fulfills the Assistant Response Gap)
Fires when the session terminates or completes. Since Codex lacks a direct intermediate stream hook for raw completion generation, the `Stop` event payload is the canonical source containing the final assistant answer turns and status metrics.
* **Event Name:** `Stop`
* **CLI Trigger:** `node ./dist/hooks/session.js --stop`
* **Input Schema (`stdin`):**
  ```json
  {
    "sessionID": "string",
    "timestamp": 1782348610000,
    "finishReason": "stop" | "error" | "cancelled",
    "lastResponse": {
      "messageID": "string",
      "content": "string"
    }
  }
  ```
* **Output Schema (`stdout`):**
  ```json
  {
    "continue": true
  }
  ```

---

## 3. SQLite Database Schema

For Codex logs, we target a database named `codex-communication-logs.db` stored in a cross-platform location (resolved via standard Node.js logic to fall back to `%APPDATA%` on Windows or `~/.local/share/` on POSIX systems).

Upon connection initialization, the library **must**:
1. Recursively ensure parent directories are provisioned on disk.
2. Enable foreign key support: `PRAGMA foreign_keys = ON;`.
3. Set write-ahead logging: `PRAGMA journal_mode = WAL;`.
4. Configure database locking busy timeout: `.busyTimeout(5000)` to handle concurrent write threads.

```sql
CREATE TABLE IF NOT EXISTS codex_sessions (
  session_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  agent_name TEXT,
  model_provider TEXT,
  model_id TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  finish_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS codex_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS codex_tool_calls (
  call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_args TEXT, -- JSON-stringified payload
  output TEXT,     -- Truncated to 200KB max
  status TEXT,     -- 'pending' | 'completed' | 'error'
  start_time INTEGER,
  end_time INTEGER,
  duration_ms INTEGER,
  inserted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES codex_sessions(session_id) ON DELETE CASCADE
);
```

---

## 4. Test-Driven Verification Harness

To confirm correctness without executing a full instance of Codex CLI, write local validation scripts to mock input/output streams.

1. **Create Mock Payloads** (`tests/codex-fixtures/*.json`):
   Create exact mock payloads matching the specified stdin shapes.

2. **Run Harness Tests** (`tests/codex-hooks.test.ts`):
   Use the runtime to verify program contracts:
   ```typescript
   import { describe, expect, test } from "bun:test";
   import { execSync } from "child_process";
   import { readFileSync } from "fs";

   describe("Codex Hook Commands Protocol Verification", () => {
     test("PreToolUse CLI parses stdin and outputs compliant stdout", () => {
       const mockStdin = readFileSync("tests/codex-fixtures/pre-tool.json", "utf-8");
       const result = execSync("node ./dist/hooks/tool.js --before", {
         input: mockStdin,
         encoding: "utf-8"
       });
       const parsed = JSON.parse(result.trim());
       expect(parsed.continue).toBe(true);
     });
   });
   ```

---

## 5. Codex Plugin Manifest Configuration

To register the logger with Codex CLI, keep presentation metadata in `.codex-plugin/plugin.json` and expose hook commands through `hooks/hooks.json`:

```json
{
  "name": "codex-communication-logger",
  "version": "1.0.0",
  "description": "Telemetry and training corpus logger for Codex CLI",
  "author": {
    "name": "Nav"
  },
  "interface": {
    "displayName": "Codex Telemetry Logger",
    "shortDescription": "Ensures every local action is structured and logged safely.",
    "longDescription": "Captures Codex session, prompt, tool, and stop events through low-latency hooks, then writes them to a local telemetry buffer for offline ingestion and export.",
    "developerName": "Nav",
    "category": "Developer Tools",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": [
      "Check whether Codex telemetry is being captured."
    ]
  }
}
```

The accompanying `hooks/hooks.json` links Codex's lifecycle handlers directly to our compiled, lightweight CLI entrypoints and registers standard regex filters on tool tools to minimize latency.

```json
{
  "SessionStart": [
    {
      "command": "node ./dist/hooks/session.js --start",
      "timeoutSec": 5
    }
  ],
  "UserPromptSubmit": [
    {
      "command": "node ./dist/hooks/message.js --prompt",
      "timeoutSec": 5
    }
  ],
  "PreToolUse": [
    {
      "command": "node ./dist/hooks/tool.js --before",
      "matcher": "^(Write|Edit|MultiEdit|Bash|Execute)$",
      "timeoutSec": 5
    }
  ],
  "PostToolUse": [
    {
      "command": "node ./dist/hooks/tool.js --after",
      "matcher": "^(Write|Edit|MultiEdit|Bash|Execute)$",
      "timeoutSec": 5
    }
  ],
  "Stop": [
    {
      "command": "node ./dist/hooks/session.js --stop",
      "timeoutSec": 5
    }
  ]
}
```
