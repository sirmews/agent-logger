# Phased Development Roadmap: Codex Communication Logger

This document outlines the systematic, phased roadmap for implementing the **Codex Communication Logger** using our spec-first design, hot-path log buffer, and cold-path database ingester.

---

## Phase 1: Foundation & Buffer Logging (Hot-Path Core)

**Goal:** Implement the raw telemetry buffer recording with zero-latency overhead and perfect fail-safe execution.

1. **Scaffold Shared Buffer Writer:**
   * Create `src/hooks/utils/buffer-writer.ts` to manage directory checking and POSIX `O_APPEND` atomic file appends to `telemetry-buffer.jsonl`.
   * Implement strict global try-catch wrappers to ensure errors are suppressed, printing `{"continue": true}` to `stdout` and exiting with `0`.

2. **Implement CLI Entrypoints:**
   * `src/hooks/session.ts` (Handles `--start` and `--stop` events).
   * `src/hooks/message.ts` (Handles `--prompt` events).
   * `src/hooks/tool.ts` (Handles `--before` and `--after` tool metrics).

3. **Verify Stdin/Stdout Stream Contracts:**
   * Populate `tests/codex-fixtures/*.json` with mock Codex events.
   * Write and run local tests in `tests/codex-hooks.test.ts` to verify exit codes, stdout formats, and atomic logging performance.

---

## Phase 2: Offline Ingester & DB Structuring (Cold-Path Core)

**Goal:** Parse the raw telemetry buffer, resolve session states, and populate the normalized SQLite database schema.

1. **Initialize SQLite Handler:**
   * Build `src/cli/ingest-db.ts` to handle cross-platform DB directory creation.
   * Configure critical SQLite pragmas (`foreign_keys = ON`, `journal_mode = WAL`, and `.busyTimeout(5000)`).

2. **Implement Telemetry Parsing Logic:**
   * Create the ingester script `src/cli/ingester.ts`.
   * It sequentially parses `telemetry-buffer.jsonl` to:
     * Match start and stop events to populate `codex_sessions`.
     * Pair prompts and assistant stop payloads into unified turns inside `codex_messages`.
     * Join `PreToolUse` and `PostToolUse` call IDs to compute tool runtimes (`duration_ms`) and record them in `codex_tool_calls`.

3. **Database Integration Tests:**
   * Add integration tests verifying successful ingestion of simulated multi-turn raw logs into the structured SQLite store.

---

## Phase 3: Quality Grading & SFT Export (Corpus Curation)

**Goal:** Apply quality profiles and deterministic redaction to generate high-fidelity, anonymized JSONL training datasets.

1. **Port Curation Rubrics:**
   * Port the deterministic grading profiles (`default`, `conservative`, `permissive`) to score Codex trajectories based on efficiency, task completion status, and tool diversity.

2. **Integrate Redaction Presets:**
   * Re-use the pattern matcher presets (`minimal`, `standard`, `strict`) to strip PII and keys deterministically at export time.

3. **Implement Export CLI:**
   * Create `src/cli/export.ts` with options matching OpenCode's parameters: `--min-efficiency`, `--min-quality`, and `--redact`.

---

## Phase 4: Bundling & Plugin Registration (Packaging)

**Goal:** Package and distribute the plugin for Codex CLI integration.

1. **Bundle Hook Executables:**
   * Configure `esbuild` or `tsup` to bundle TypeScript hooks into dependency-free, lightweight single-file JavaScript distributions.

2. **Publish Manifest Declarations:**
   * Build `.codex-plugin/plugin.json` containing rich presentation metadata.
   * Create `hooks.json` specifying exact regex matchers (e.g., `^(Write|Edit|MultiEdit|Bash|Execute)$`) to limit tool hooks to high-value, slow tasks and prevent overhead on fast actions.

3. **Local Ingestion Test:**
   * Register the plugin in Codex’s local `marketplace.json` configuration and run a real Codex turn to confirm end-to-end event writing.
