# Caveats & Rationale

This document captures known limitations of the plugin **as currently implemented** and the design reasoning behind them. The goal is not to defend the choices — it is to make the trade-offs legible so you (or a future reader) can decide whether each one is acceptable for your use case before it becomes a problem in production.

If a caveat here is unacceptable for your use case, the "Options" section under each item lists the realistic ways to address it.

---

## 1. `efficiency_score` is a heuristic

### What is happening

[`computeEfficiency()`](../src/index.ts) produces a number in `[0, 1]` from four inputs only:

- success rate (`completed / total` tool calls),
- average per-tool duration bucketed into four bands (60s/30s/10s/5s),
- a small "variety bonus" that grows with the number of tool calls (capped at 0.1),
- an error penalty proportional to error fraction.

The weights (0.6 / 0.3 / 0.1) and the duration bands are hand-picked. There is no calibration against any ground-truth label.

The same number is then used by `export_training_data` as a quality signal (`min_efficiency`, default 0.0), and a corpus quality profile score can additionally be applied with `min_quality_score`.

### Why this matters

A heuristic gate that decides what becomes training data **systematically biases the dataset toward whatever the heuristic happens to like.** Concretely:

- Sessions where the model spent many short tool calls and never errored will score high, even if the final answer was wrong.
- Sessions where the model thought hard, errored once, recovered, and produced a great answer will score low.
- Sessions where the model gave up early (no tools at all) score zero — but that is not the same as "low quality": it could just mean the user asked a one-shot question.

If you fine-tune on this filtered set, the resulting model is being told *"behave like trajectories that look like this heuristic likes them"*, not *"behave like trajectories that solved the user's task"*. The classic failure modes are:

- **Mode collapse** toward fast, error-free, tool-heavy patterns.
- **Sycophancy / shortcut learning** where the model picks tool patterns that satisfy the metric instead of the user.
- **Self-distillation drift** if you retrain on your own outputs and the heuristic is the only filter (this is independent of the heuristic's specific shape).

### Rationale for keeping it (for now)

- It is **observable and free**. Every existing log already produces enough information to compute it; you do not need a second model or human review.
- It is **monotone in a few obviously-good signals** (more errors → lower score, longer per-tool time → lower score). At the extremes it is directionally correct; the failure mode is the middle.
- It gives the plugin a **default behaviour** so users get *some* JSONL out of the box without having to wire up an external grader on day one.
- It is **easy to override** — `min_efficiency: 0` plus `require_success: false` disables the gate entirely, so a downstream pipeline can ignore it.

### Options when this becomes a real problem

In rough order of cost:

1. **Drop the gate.** Set `min_efficiency: 0`, `require_success: false`, export everything, and apply your own filter downstream. Fastest path; preserves the data; punts the problem.
2. **Replace the gate with `task_success` only.** `task_success` is also a heuristic but it depends on fewer arbitrary numbers (it is just "no tool errors AND last assistant `finish === 'stop'`"). Worse coverage, fewer false positives.
3. **External grader.** Run a stronger model over each session (user prompt + final assistant text + tool trajectory) and have it score the trajectory on a rubric. Store the score in `training_examples` and gate on that. This is what most production fine-tuning pipelines do.
4. **Human labels.** A small batch of human-rated sessions (≥200) calibrates *any* automated grader you use. This is the only way to know whether your gate is doing what you think it is.
5. **Outcome-based labels.** If the user is in a real workflow (CI, tickets, review), use the downstream signal (test passed, PR merged, ticket closed) as the success label and ignore the heuristic. Hardest to wire up; most predictive.

### What is documented in code

The heuristic lives in [`computeEfficiency()`](../src/index.ts) at the bottom of `src/index.ts` with a one-line "advisory only" warning. The README / training-data docs should restate that any consumer of `efficiency_score` is consuming a heuristic, not a measurement.

---

## 2. No secret redaction

### What is happening

Every captured field is written to SQLite **as-is**. In particular, the plugin stores:

- The **full user message text** (`message_parts.text` for user-role messages).
- The **full system prompt** (`sessions.system_prompt`).
- The **complete arguments** of every tool call (`message_parts.tool_input` and `tool_call_hooks.args`).
- The **complete output** of every tool call (`message_parts.tool_output`, `tool_call_hooks.output`), truncated only at 200 KB.
- The raw `Part` JSON (`message_parts.raw_part`) and raw `Message.info` (`messages.raw_info`), which contain everything above plus more.
- File paths from `file.edited` events.
- Slash-command arguments verbatim.

There is **zero filtering** of these fields. If the user pastes an API key into the chat, or a `bash` tool invocation runs `curl -H "Authorization: Bearer …"`, or a `read` tool returns a file containing `.env` contents, those values land in plain text in `~/.local/share/opencode/communication-logs.db`.

### Why this matters

There are three concrete risks:

1. **Disk-level exposure.** By default, the SQLite database lives in the user's home directory under `~/.local/share/opencode/communication-logs.db`, but this path is overridable via environment variables documented in `README` (`AGENT_LOGGER_DB_PATH`, etc.). Still, anything with read access to the chosen path sees plaintext secrets.
2. **Export-time exposure.** `export_training_data` produces JSONL that you presumably ship to a fine-tuning service. That service now has those secrets too.
3. **Training-set memorization.** If the secrets end up in fine-tuning data, the resulting model can regurgitate them. This has happened in published incidents (GitHub Copilot leaking keys, etc.) and is the reason most production data pipelines redact before storage, not after.

The third risk is the worst because it is **non-revocable** — once a model has memorized a key, you cannot un-train it without retraining.

### Rationale for the current state

- Redaction is a **separate, opinionated feature.** Doing it badly is worse than not doing it at all (false confidence). Common patterns that look like secrets but aren't (UUIDs, hashes) get over-redacted; secrets that don't match the expected format (custom auth headers) get under-redacted.
- The plugin's **threat model so far is "local single-user dev machine"**, where the user already has full filesystem access to their own keys. Redacting on disk does not change anything for that user.
- Redaction is **easier to add than to roll back.** If the plugin redacted aggressively from day one, users who needed the original values for debugging would have no recourse. Storing raw and redacting at export time keeps options open.

### Options when this becomes a real problem

1. **Block-list of fields.** Mark known-sensitive tool args (`bash` command, environment dumps, `read` output for paths under `~/.ssh`, `~/.aws`, `.env*`, etc.) for redaction at write time. Cheap, partial, brittle.
2. **Pattern redaction.** Run regexes for common secret formats (AWS keys, GitHub tokens, JWTs, OpenAI keys, generic `Bearer …`) over every text/output/args field before insert. Cheap, catches the worst leaks, will both miss and over-match. Tools like [`detect-secrets`](https://github.com/Yelp/detect-secrets) and [TruffleHog](https://github.com/trufflesecurity/trufflehog) have published rule sets that are reusable. v1 includes a default list with optional extension via `AGENT_LOGGER_EXTRA_REDACTION_PATTERNS`.
3. **Entropy / Shannon checks.** Flag any token over a length threshold with high entropy. Catches custom secrets but very noisy.
4. **Two-phase storage.** Write everything raw to a `*.raw.db` that is `chmod 600` and never leaves the machine; write a redacted copy to `communication-logs.db` for export. Most defensible; doubles storage.
5. **Redact at export only.** Keep the raw DB as-is, run redaction inside `export_training_data` before emitting JSONL. Lowest blast radius for export-bound data; still leaks on disk.
6. **Don't capture some fields at all.** Decide that `bash` args and `read`/`fetch` outputs are inherently too risky and store only their lengths/hashes. Strongest guarantee; biggest loss of trajectory fidelity.

A reasonable v1 is **(2) + (5)**: capture raw on disk (the user already trusts their own machine), pattern-redact in `export_training_data` so anything that leaves the machine is filtered. Make the patterns configurable via `AGENT_LOGGER_EXTRA_REDACTION_PATTERNS`.

### What is documented in code

- The export tool uses a deterministic redaction seam (`redactPayload`) and emits
  plugin logs when export-time redaction is enabled, including how many custom
  patterns were supplied.
- The redaction rule set is currently regex-only and configurable through
  `AGENT_LOGGER_EXTRA_REDACTION_PATTERNS`.
- This is still the largest follow-up in the codebase if your threat model requires
  stronger detection than regex matching.

---

## 3. `file.edited` events have no `sessionID`

### What is happening

The bus event `file.edited` carries `{ file: string }` only ([`file/index.ts` L71–L76](https://github.com/anomalyco/opencode/blob/main/packages/opencode/src/file/index.ts#L71-L76) — relative path, nothing else).

The plugin's `file_edits` table therefore has a `file_path` column and a `timestamp` column but no `session_id`. We cannot attribute file edits to the session that caused them from this event alone.

### Why this matters

If you want to answer questions like *"which sessions touched this file?"* or *"how many files did session X modify?"*, the `file_edits` table cannot help. It is effectively a project-wide log, not a per-session one.

This also means the export pipeline cannot use `file_edits` to reconstruct the diff a session produced — important if you want to train on input→diff pairs rather than input→tool-call pairs.

### Rationale for the current behaviour

- We capture the event anyway because **it is cheap and uniquely tells you a file was actually written to disk**, which the tool-call stream alone does not — a `write` tool call can fail silently (filesystem error after the tool returned, race with the user's editor, etc.).
- Treating it as a global signal is **truthful** to what opencode actually publishes. Inventing a `session_id` by guessing (e.g. "the most recently-busy session") would make the data look more reliable than it is.
- Tool parts are the **better source for session-attributed file edits**: every `edit`, `write`, and `patch` tool produces a `tool` part on a specific assistant message, with the file path in `tool_input` and the diff in `tool_output`. That is already captured in `message_parts`.

### Options when this becomes a real problem

1. **Use tool parts instead.** For session-attributed file edits, `SELECT tool_input, tool_output FROM message_parts WHERE part_type = 'tool' AND tool_name IN ('edit','write','patch','multiedit') AND session_id = ?` is the canonical query. The `file.edited` event is just a heartbeat that something hit the disk.
2. **Cross-reference by timestamp.** Pair each `file.edited` row with the most recent `tool` part that touched the same file path within a few hundred milliseconds. Works most of the time, fails on concurrent sessions / fast typers. Probably not worth the complexity.
3. **Use `session.diff` events.** (Implemented) opencode publishes `session.diff` with `{ sessionID, diff: FileDiff[] }`. The plugin now captures this in the `session_diffs` table, providing authoritative per-session file changes including additions, deletions, and status.
4. **Wait for upstream.** If the lack of `sessionID` on `file.edited` is itself a bug (debatable — file watching is intentionally session-agnostic in many editors), it could be fixed upstream and then the plugin would inherit attribution for free.

The right answer was **option 3**, which is now active. The `file_edits` table is kept as a global heartbeat.

### What is documented in code

- The handler in [src/index.ts](../src/index.ts) captures `session.diff` AUTHORITATIVELY.
- `file.edited` still records globally without session attribution.

---

## 4. Other caveats worth knowing about

These are smaller than the three above but live in the same neighbourhood. Documenting them so they are not surprising:

### 4a. Synchronous SQLite writes on the event hot path

The plugin runs SQLite `prepare().run()` synchronously inside every event/hook handler. For typical workloads this is fine (WAL mode, prepared statements, small payloads). For high-frequency events, especially `message.part.delta`, it would not be — which is why **the plugin deliberately does not subscribe to `message.part.delta`**. We capture `message.part.updated` instead, which fires once per state change rather than once per token.

If you ever do need streaming-token-level capture, batch the writes into a queue and flush periodically.

### 4b. 200 KB output truncation

Tool outputs over 200 KB are truncated with a `---TRUNCATED---` marker. The cap is hard-coded as `MAX_TOOL_OUTPUT_BYTES`. Rationale: an unbounded output (e.g. a `bash` command that dumps a large log) can blow up the database fast. Trade-off: any training example built from a truncated output is missing the tail of the tool result, which can change the meaning. If your tools routinely produce >200 KB outputs that matter, raise the cap or store outputs to disk and reference them by hash.

### 4c. `task_success` is also heuristic

`task_success` is `true` when there are zero tool errors AND the last assistant message has `finish === "stop"` (or there were no tool calls at all). This is *less* heuristic than `efficiency_score`, but it can still misclassify:

- A session that succeeded in spite of a tool error (model recovered) → false negative.
- A session that produced a confidently wrong answer with no tool errors → false positive.

The same options as in §1 (external grader, outcome-based labels) apply.

### 4d. `permission.ask` trigger hook intentionally not used

The plugin only *observes* permissions (via the `permission.asked` / `permission.replied` bus events). It deliberately does **not** register a `permission.ask` trigger hook because doing so would let the plugin override the user's allow/deny decisions. That is not its job. If a future feature wants to auto-approve known-safe commands for an automated workflow, it should be opt-in, separate from logging, and clearly named.

### 4e. Self-distillation risk

This is a meta-caveat that subsumes §1. If you fine-tune on your own model's outputs filtered only by automated heuristics, even good heuristics, the resulting model is being asked to imitate itself. There is published evidence that this drifts toward sycophancy and mode collapse over multiple rounds (search "model collapse synthetic data"). Mitigations:

- Mix synthetic with human or expert-model data.
- Filter on outcome rather than process where possible.
- Limit the number of self-distillation rounds.
- Always evaluate on a fixed external benchmark, not just internal logs.

This caveat does not require any code changes — it requires a clear-eyed view of what fine-tuning on the exported JSONL actually does.

---

## How to use this document

For this release, quality is represented in two layers:

- `efficiency_score` from `computeEfficiency()` remains the original operational signal.
- `session_quality` stores a deterministic rubric-based profile score generated during session refresh and persisted per profile.

When you (or a contributor) hit one of these limits in real use:

1. Re-read the relevant section to confirm the limit is real and not a misunderstanding.
2. Pick an option from that section's "Options" list.
3. Update both the code and this document together — every caveat should either be resolved here or moved to a closed section with a date.

Caveats that move from "live" to "resolved" should keep their entry in this file with a note about how and when they were addressed, so future readers can see why a particular pattern in the code exists.
