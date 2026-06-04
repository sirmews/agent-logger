# Training Capture Contract Roadmap

This plan defines the next stage for AgentLogger: evolve capture quality so future training datasets are useful, without starting fine-tuning yet. The first implementation should focus on Codex, but the data shape must be shared enough that OpenCode can produce equally useful training records in the next PR.

## Current Position

AgentLogger already captures raw Codex hook events into a JSONL buffer and ingests them into SQLite. That proves the basic installation and logging loop works, but the current records are still too thin for strong training-data curation.

The next goal is better capture, not model training. We need richer, better-linked records that explain what happened in a session, what tools were used, what permissions were requested, what repository state changed, and what evidence suggests the outcome was good or bad.

## Terms

**Live capture path** means code that runs while Codex or OpenCode is actively handling a user request. This must stay small, fast, and fail-safe because logger failures must not slow or break the agent.

**Offline processing path** means code that runs later, after records have been written. This is where heavier work belongs: parsing logs, reconciling turns, reading transcripts, classifying verification commands, scoring quality, and building dataset files.

## External-source verification (as of 2026-06-02)

Before deciding the order of work, the assumptions about Codex hooks were checked against the upstream interface, not memory:

| Question | Source | Result |
|---|---|---|
| Which hook events does Codex emit? | [`codex-rs/hooks/schema/generated/`](https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated) | Ten events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`. No `Notification`. |
| Is `PermissionRequest` real and stable? | upstream schema file | Yes, shipped; not a Claude-Code-only event. |
| Is the transcript format a stable interface? | [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks) | **No.** Officially documented as unstable. |
| What shape is `model` on the wire? | `pre-tool-use` / `session-start` input schemas | Plain string slug (e.g. `"gpt-5.4"`), not `{ provider, modelID }`. |
| What are the values of `permission_mode`? | every schema's enum | `default \| acceptEdits \| plan \| dontAsk \| bypassPermissions`. |
| Does `SessionStart` distinguish fresh starts from compaction continuations? | `session-start` input schema | Yes, via `source: startup \| resume \| clear \| compact`. |
| Does `Stop` indicate auto-continuation? | `stop` input schema | Yes, via `stop_hook_active: boolean`. |
| Are `unified_exec` and `WebSearch` interceptable today? | [Codex hooks reference](https://developers.openai.com/codex/hooks) | No — explicitly listed as gaps in `PreToolUse` coverage. |
| Does Codex set `CLAUDE_PLUGIN_ROOT`? | Codex hooks reference | Yes, for compatibility, alongside the Codex-native `PLUGIN_ROOT` / `PLUGIN_DATA`. Existing [`hooks/hooks.json`](file:///Users/nav/Projects/opencode-communication-logger/hooks/hooks.json) usage is fine but prefer `PLUGIN_ROOT` going forward. |

Two consequences of this verification are folded into the plan below: (a) `Notification`-shaped capture is dropped from scope, and (b) the existing matcher regex in [`hooks/hooks.json`](file:///Users/nav/Projects/opencode-communication-logger/hooks/hooks.json) — `^(Write|Edit|MultiEdit|Bash|Execute)$` — is a Claude-Code-shaped artifact and should be replaced with Codex aliases (`apply_patch`, `Edit`, `Write`, `Bash`) during PR 1.

## Decision

The first implementation PR should be Codex-first.

OpenCode should not be fully upgraded in that PR. Instead, the first PR should define the shared capture contract and include an OpenCode mapping document so the next PR has a clear target.

Transcript parsing should be planned as a later offline enrichment step. It should not become the primary live capture mechanism until Codex documents the transcript format as a stable interface. The minimum useful transcript value is reliable assistant response and turn reconstruction. If transcript parsing only duplicates prompts and tools we already capture, it is not worth the added complexity yet.

Fine-tuning is out of scope for this roadmap stage.

## Shared Capture Contract

Create a versioned contract that both Codex and OpenCode events can map into. The contract should preserve raw source payloads while also exposing normalized fields for training-data preparation.

Each captured record should include:

- `schema_version`
- `logger_version`
- `record_id`
- `captured_at`
- `source_agent` such as `codex` or `opencode`
- `source_event`
- `session_id`
- `turn_id` when available
- `cwd` or project path
- `model` and permission mode when available
- normalized payload fields
- raw source payload
- truncation metadata when payloads are shortened
- redaction metadata once redaction is applied

The live capture path should append records and return control to the agent. It should not connect to SQLite, parse transcripts, score sessions, call models, or perform expensive repository analysis.

### Envelope shape (v1)

To avoid ambiguity during implementation, PR 1 should produce JSONL lines that look like:

```json
{
  "schema_version": 1,
  "logger_version": "x.y.z",
  "record_id": "uuid",
  "captured_at": 1782348574000,
  "source_agent": "codex",
  "source_event": "PreToolUse",
  "session_id": "...",
  "turn_id": "...",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "...",
  "model": "gpt-5.4",
  "permission_mode": "default",
  "session_source": "startup",
  "stop_hook_active": false,
  "normalized": { "tool_name": "apply_patch", "tool_use_id": "...", "...": "..." },
  "raw": { "...original hook payload..." },
  "truncation": { "field": "raw.tool_response", "stored_bytes": 200000, "original_bytes": 814221 },
  "redaction": null
}
```

Field-shape choices above are grounded in the Codex upstream JSON schemas at [`codex-rs/hooks/schema/generated/`](https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated). Notable corrections from the earlier draft of this doc and from [`codex-logger-spec.md`](file:///Users/nav/Projects/opencode-communication-logger/docs/plans/codex-logger-spec.md):

- `model` is a plain string slug (e.g. `"gpt-5.4"`), not an object with `provider`/`modelID`. The current ingester [splits on `/`](file:///Users/nav/Projects/opencode-communication-logger/src/cli/ingester.ts#L142-L160), which is OpenCode-shaped and does not match Codex. PR 1 should keep that splitting logic only as a fallback for OpenCode envelopes and treat the raw slug as authoritative for Codex.
- `permission_mode` is a closed enum: `default | acceptEdits | plan | dontAsk | bypassPermissions`.
- `transcript_path` is a top-level field on every Codex hook input. Capture it verbatim; do not parse it on the live path (see PR 3).
- `session_source` (`startup | resume | clear | compact`) comes from `SessionStart`. The `compact` value is critical for training data because such a "session start" is mid-conversation continuation, not a fresh user task.
- `stop_hook_active` on `Stop` indicates a Codex auto-continuation; dataset builders will likely want to treat those records differently from genuine session terminations.

The current ingester reads top-level fields like `sessionID`/`session_id`, `callID`/`call_id`, `tool`/`tool_name` via [`normalizeEvent`](file:///Users/nav/Projects/opencode-communication-logger/src/cli/ingester.ts#L85). PR 1 must teach it to prefer the envelope's `normalized` block when `schema_version >= 1` and fall back to legacy top-level fields otherwise, so the "Keep old raw Codex buffer records ingestible" requirement is satisfied without a migration.

## PR 1: Codex Training-Capture Contract

Goal: upgrade Codex capture to produce richer versioned records while preserving compatibility with the existing JSONL buffer.

Recommended implementation scope:

1. Add shared TypeScript types for the versioned capture envelope.
2. Update Codex hook writers to wrap new records in the envelope.
3. Preserve raw Codex hook payloads inside each record.
4. Keep old raw Codex buffer records ingestible.
5. Add `PermissionRequest` capture.
   - Confirmed shipped in Codex (schema: [`permission-request.command.input.schema.json`](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/permission-request.command.input.schema.json)). Wire a new `PermissionRequest` entry in [`hooks/hooks.json`](file:///Users/nav/Projects/opencode-communication-logger/hooks/hooks.json) pointing at a new `permission.ts` (or reuse `tool.ts` with a `--permission` flag). Capture fields: `tool_name`, `tool_input`, `turn_id`, `permission_mode`, `agent_id`, `agent_type`. Note that `Notification` does **not** exist in Codex's hook schema set — there is no separate notification hook to capture.

   Also fix the existing matcher bug while you're in `hooks.json`: the current regex `^(Write|Edit|MultiEdit|Bash|Execute)$` mixes Codex (`apply_patch` → matcher aliases `Write`/`Edit`/`apply_patch`) and Claude Code names (`MultiEdit`, `Execute`). The Codex docs explicitly list the matcher aliases for `apply_patch` and `Bash`; replace with `^(Bash|apply_patch|Edit|Write)$` (and any specific `mcp__*` patterns you want to keep) so the hook actually fires on Codex tool calls.
6. Add session-start repository context:
   - git root
   - current branch
   - current commit
   - dirty/clean status
   - remote URL when cheaply available
   - All git calls must be spawned with a hard wall-clock timeout (≤ 1s) well inside the 5s `timeoutSec` of the hook, and must be skipped silently if `git` is missing or `cwd` is not inside a repo.
7. Add stop/final-state repository context:
   - final branch
   - final commit
   - dirty/clean status
   - changed-file summary
   - Cap the changed-file summary (e.g. first N paths plus an `omitted_count`) so a large refactor session does not produce multi-MB records.
8. Add stronger tool metadata:
   - `tool_name`
   - `tool_use_id`
   - `turn_id`
   - command or target when available
   - status/exit code when available
   - duration when available
   - stored bytes and original bytes when truncation occurs

   Additionally, wire two compaction hooks ([`PreCompact`](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/pre-compact.command.input.schema.json) and [`PostCompact`](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/post-compact.command.input.schema.json)) so compaction boundaries can be reconstructed during dataset building without needing transcript parsing. The PR 3 transcript prototype lists "compaction boundaries" as a target — live `PreCompact`/`PostCompact` capture solves that without the transcript dependency. `SubagentStart` and `SubagentStop` are also available and worth wiring on the same pass since they introduce nested turn lineage that affects training-data segmentation.
9. Persist new fields in the database, not just in JSONL. Today [`codex_messages`](file:///Users/nav/Projects/opencode-communication-logger/src/cli/ingest-db.ts#L40) and [`codex_tool_calls`](file:///Users/nav/Projects/opencode-communication-logger/src/cli/ingest-db.ts#L52) have no column for `turn_id`, `permission_mode`, `git_branch`, `git_commit`, or repository dirty status. PR 1 must add `ALTER TABLE`-style additive columns (and a new `codex_permission_requests` table if step 5 produces records) so the new envelope fields actually survive the cold path. Without this, the envelope upgrade improves JSONL but the SQLite store stays as thin as it is today.
10. Add tests for:
   - envelope creation
   - old-format compatibility (legacy JSONL lines without `schema_version` still ingest)
   - permission request capture
   - git-context fail-safety outside a git repo and when `git` is missing on `PATH`
   - truncation metadata round-trips into SQLite
   - ingestion of mixed old and new Codex records in the same buffer file
   - additive schema migration runs cleanly against a pre-existing v0 database
11. Update docs to describe what Codex capture includes and what it still cannot reliably observe.

Validation:

- Run `bun run quality`.
- Run a temporary ingest against the real Codex telemetry buffer.
- Confirm no hook command can fail closed or block Codex if git inspection fails.

## PR 2: OpenCode Contract Parity

Goal: make OpenCode capture map into the same shared contract so future training data can combine both agents, while strictly preserving OpenCode's real-time direct-database transport.

Recommended implementation scope:

1. **Unify the Data, Not the Transport**: OpenCode must *not* be forced to use the Codex JSONL buffer. OpenCode is a persistent daemon that registers real-time SQL tools (e.g., `analyze_logs`); using an eventually-consistent buffer would break these tools by feeding them stale data, and risk stranding data if the process exits before an "idle" flush.
2. Refactor `src/cli/ingester.ts` to export its core SQL insert logic (e.g., an `ingestEnvelope(envelope, db)` helper) so it can be shared.
3. Map OpenCode plugin events to the shared `CaptureEnvelope` (v1) in memory inside the `event` hook.
4. Immediately pass those envelopes to the shared SQL insert logic, maintaining OpenCode's strongly consistent, synchronous database writes.
5. Preserve raw OpenCode event payloads inside the envelopes.
6. Normalize OpenCode sessions, messages, tool calls, permissions, file edits, diffs, and outcomes into the same concepts used by Codex.
7. Keep existing OpenCode legacy table writes (`sessions`, `message_parts`, etc.) fully operational so existing custom tools do not break.
8. Add tests that compare Codex-shaped and OpenCode-shaped records for shared normalization behavior.
9. Update OpenCode docs to call out equivalent fields and platform-specific gaps.

Validation:

- Run `bun run quality`.
- Exercise OpenCode export paths with redaction enabled.
- Confirm OpenCode records remain useful even when exact Codex fields such as `turn_id` or `tool_use_id` differ.

## PR 3: Transcript Parsing Research and Prototype

Goal: decide whether Codex transcripts are reliable enough to enrich training records.

Transcript parsing should happen offline only. It should use already captured fields like `transcript_path`, `session_id`, and `turn_id` for reconciliation, not live capture.

The transcript-format-stability concern in this roadmap is now externally confirmed. The official Codex hooks reference at [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks) states verbatim: *"transcript_path points to a conversation transcript for convenience, but the transcript format is not a stable interface for hooks and may change over time."* That settles the question — transcript parsing is an enrichment-only path and must not become a primary capture mechanism.

Research tasks:

1. Check current official Codex documentation for transcript guarantees. (Confirmed unstable as of 2026-06; revisit before each release that touches transcripts.)
2. Inspect current Codex source for transcript shape, stability, and hook schema references.
3. Compare transcript records against the telemetry buffer for the same session.
4. Identify whether transcript parsing reliably recovers:
   - assistant final messages
   - assistant turn boundaries
   - tool-call linkage
   - compaction boundaries
   - permission context
   - reasoning traces, only if available and appropriate to store
5. Decide whether transcript parsing should be:
   - enrichment for missing assistant messages
   - reconciliation for turn boundaries
   - fallback when hooks miss events
   - rejected until the format is stable

Prototype scope:

- Parse one or two real transcripts locally.
- Produce a comparison report against the JSONL telemetry buffer.
- Do not write transcript-derived fields into the primary database until the reliability decision is documented.

## Training Dataset Direction

After capture improves, dataset building can begin. That later stage should produce local artifacts only:

- `manifest.json`
- `train.jsonl`
- `validation.jsonl`
- `eval.jsonl`
- `excluded.jsonl`
- `metrics.json`

The dataset builder should explain why sessions are included or excluded. It should prefer deterministic evidence before model-based grading:

- tests passed
- lint passed
- build passed
- command failure recovered
- meaningful file diff exists
- commit or push occurred
- user explicitly accepted or continued after a risky operation

Fine-tuning API calls, reinforcement fine-tuning, teacher-model rewriting, and cloud sync should wait until this local dataset workflow is trustworthy.

## Risks

- Codex transcript format is **explicitly documented as unstable** by OpenAI ([Codex hooks reference](https://developers.openai.com/codex/hooks)). Any transcript-derived enrichment must be tagged with `logger_version` plus the Codex CLI version it was extracted under, so old records can be invalidated cleanly when the format changes.
- Some Codex tools or browser/web actions may not be visible through current hooks. Specifically, the Codex docs state that `PreToolUse` does **not** yet intercept the newer `unified_exec` streaming-shell path or `WebSearch`. The roadmap should treat any "completeness of tool capture" claim as bounded by these documented gaps.
- Repository inspection can be slow or fail outside git repositories, so it must be bounded and fail-safe.
- More captured context increases privacy risk, so redaction and exclusion metadata need to remain part of the plan.
- A shared contract can become too generic if it ignores platform-specific details. Preserve raw payloads to avoid losing important source data.
- Buffer size doubles because the envelope stores both `raw` and `normalized`. For now this is acceptable, but PR 1 should record per-line byte sizes during testing so we can decide later whether raw payloads need to move to a separate sidecar file or get gzip-compressed before SQLite ingestion.

## Cross-references

- [`docs/v2-data-curation-strategy.md`](file:///Users/nav/Projects/opencode-communication-logger/docs/v2-data-curation-strategy.md) describes the eventual grading and synthetic-redaction pipeline. The "Training Dataset Direction" section above is the deterministic-evidence precursor to that strategy; keep both documents in sync when the dataset builder lands.
- [`docs/plans/phased-development-roadmap.md`](file:///Users/nav/Projects/opencode-communication-logger/docs/plans/phased-development-roadmap.md) is the prior phased plan; this roadmap supersedes its Phase 3 ("Quality Grading & SFT Export") by inserting a richer capture stage first.

## Recommended Next Step

Start with PR 1: Codex Training-Capture Contract.

That PR should improve what Codex captures now, create the shared contract OpenCode will later use, and keep transcript parsing as a documented offline follow-up rather than a dependency for the first implementation.
