# SFT & DPO Curation Roadmap

This document outlines the strategy and concrete implementation plan for transitioning AgentLogger from a **Data Capture** tool into a **Data Curation** engine. 

While the current pipeline successfully captures 100% of the runtime data into a unified SQLite schema across both Codex and OpenCode, the raw trajectories are not yet optimized for model training. Naively fine-tuning on raw logs leads to behavioral cloning of bad habits, hallucinations, and format drift.

To train a model that actually outperforms the baseline, we need to plug three critical holes:
1. **The Reasoning Gap**: Missing internal monologues before tool calls.
2. **The False Positive Problem**: Agents confidently failing but marking tasks as successful.
3. **Missing Preference Data**: Throwing away failed runs instead of using them to teach the model what *not* to do via DPO (Direct Preference Optimization).

---

## Phase 1: Interleaved Trajectory Formatting (SFT Readiness)

**The Problem:** Modern SFT training pipelines (like those for Llama-3 or Claude) expect a single, chronologically interleaved conversation where the agent "thinks" right before it acts. Our current export separates `messages` and `tools` into two different arrays.

**The Goal:** Update the `export_training_data` tool to stitch `codex_messages` and `codex_tool_calls` into a single, cohesive timeline based on their timestamps.

**Implementation Scope:**
1. **Chronological Merge:** Read both `codex_messages` and `codex_tool_calls` for a session and sort them globally by `timestamp` / `start_time`.
2. **ReAct Formatting:** Map the merged timeline into a standard `User -> Thought -> Action (Tool) -> Observation (Result) -> Assistant` sequence.
3. **Reasoning Backfill (Optional/Future):** If a tool call occurs without a preceding `<thought>` block or reasoning message, provide an integration point where an offline Teacher Model can reverse-engineer a thought process (e.g., *"I need to check the files in this directory before proceeding"*).

**Validation:**
- Exported JSONL contains a single `messages` array per line with proper role alternations (`user`, `assistant`, `tool`, `tool_result`).

---

## Phase 2: Ground-Truth Validation (LLM-as-a-Judge)

**The Problem:** Currently, if a session exits without a tool error and `finish_reason = stop`, we label it `task_success = true`. However, an agent can confidently write terrible, buggy code and cleanly exit. Training on this teaches the model to confidently fail.

**The Goal:** Use the rich Git context we capture (specifically `git_commit` at start and `git_end_commit` at stop) to generate a hard diff of what the agent actually changed, and use an external Judge LLM to verify if the task was truly solved.

**Implementation Scope:**
1. **Create Evaluator Command:** Add an `agent-logger evaluate` CLI command.
2. **Extract Diffs:** For sessions marked as heuristically "successful", read the start and end commits from `codex_sessions`, then run `git diff <start> <end>`.
3. **LLM Evaluation:** Send the original User Prompt + the Git Diff + the Trajectory to a configurable Judge LLM (e.g., GPT-4o, Claude 3.5 Sonnet).
    * *Prompt Rubric:* "The user asked for X. The agent produced this diff. Did it completely solve the problem without introducing bugs? Reply YES or NO, followed by a brief justification."
4. **Persist Verdict:** Create a `ground_truth_evals` table to store the Judge's boolean verdict and reasoning.
5. **Strict SFT Export:** Update `export_training_data` to only export sessions where `ground_truth_evals.verdict == true` (when strict mode is enabled).

**Validation:**
- Running the evaluator command successfully computes git diffs and saves external verdicts.
- Confident failures are cleanly stripped from the final SFT export.

---

## Phase 3: Preference Optimization (DPO Export)

**The Problem:** SFT only teaches a model what to do. To stop a model from making recurring mistakes (like running `rm -rf` when frustrated, or falling into infinite loops), we must teach it what *not* to do. Modern alignment uses Direct Preference Optimization (DPO), which requires paired data: a "Chosen" trajectory vs. a "Rejected" trajectory for the exact same prompt.

**The Goal:** Group our historical sessions by User Prompt to find tasks that the agent attempted multiple times, extracting a winning run and a failing run to generate a DPO-compatible dataset.

**Implementation Scope:**
1. **Create DPO Exporter:** Add a new `export_dpo_data` tool/CLI command.
2. **Fuzzy Grouping:** Group `codex_sessions` by the initial user prompt (ignoring minor whitespace/formatting differences).
3. **Pair Extraction:** For a given prompt group, locate at least one "Chosen" run (Verified `task_success = true` or `ground_truth_verdict = true`) and at least one "Rejected" run (High error count, `finish_reason = error`, or `ground_truth_verdict = false`).
4. **HuggingFace Format:** Export these pairs into the standard HuggingFace DPO format:
    ```json
    {
      "prompt": "User's initial instruction",
      "chosen": [ ... interleaved successful trajectory ... ],
      "rejected": [ ... interleaved failed trajectory ... ]
    }
    ```

**Validation:**
- Output JSONL correctly matches the schema expected by DPO training libraries (e.g., `trl` or `Axolotl`).
- Prompts are properly deduplicated across multiple sessions.

---

## Order of Execution
- **Phase 1** must be completed first, as both SFT and DPO pipelines require the interleaved ReAct format to train modern models properly.
- **Phase 2** should follow to ensure that the "Chosen" trajectories we select for Phase 3 are actually correct, rather than just heuristically smooth.
- **Phase 3** is the final step, unlocking advanced model alignment.

---

## Review Notes

### Capture is ahead of export — the gap is wiring, not data

The capture pipeline already stores tool inputs and outputs. The hook in `src/hooks/tool.ts` captures `payload.output ?? payload.tool_response` on `PostToolUse` and the full `tool_input` args on `PreToolUse`. The ingester (`src/cli/ingester.ts`) persists these to `codex_tool_calls.input_args` and `codex_tool_calls.output` (truncated to 200K chars). The schema (`src/cli/ingest-db.ts`) has both columns.

**However**, the current export in `src/cli/export.ts:162-164` only selects `tool_name, status, duration_ms` — it does not read `input_args`, `output`, or `exit_code`. The SFT payload therefore contains no tool inputs or outputs, only metadata.

**Impact on Phase 1:** The "Reasoning Gap" is partly a data-surfacing problem, not a capture problem. Before building a Teacher Model backfill pipeline, wire the existing `input_args` and `output` fields into the export payload. This is a low-effort, high-signal change.

**Impact on Phase 2:** The roadmap proposes an external LLM Judge because we "can't run tests retroactively." This is correct — we cannot re-run a session days later in a moved codebase. But the agent *already ran the code during the session*, and we captured the results. Every `codex_tool_calls.exit_code` and `codex_tool_calls.status` is a ground-truth execution signal. If the agent ran `npm test` or `tsc --noEmit` during the session and it passed, that's your verification — no Judge LLM needed for those sessions.

**Recommendation:** Rewrite Phase 2 to use a tiered approach:
1. **Tier 1 (Deterministic):** Sessions where the agent ran a test suite or compiler and it passed (`exit_code == 0` on test/lint commands) → automatically verified.
2. **Tier 2 (Heuristic):** Sessions with no execution evidence → fall back to LLM Judge, but acknowledge this is weaker signal.
3. Drop the "Reasoning Backfill" from Phase 1 scope entirely. If a trajectory has no reasoning, it's still usable as a tool-use-only training example — don't hallucinate justification after the fact.

---

## External Pipeline Investigations

### TALOS Trace Curator (Primary candidate)

**Repo:** [DJLougen/TALOS-trace-curator](https://github.com/DJLougen/TALOS-trace-curator)
**License:** MIT
**Language:** Python

TALOS is an 8-stage pipeline that turns raw agent session traces into training-ready datasets. It is the closest existing system to what we need.

#### Pipeline Stages

| Stage | What it does | Mapping to our data |
|-------|-------------|---------------------|
| **Ingest** | Loads from session dirs, single JSONL, or session ID | Our `export_training_data` JSONL output |
| **Anonymize** | Regex + optional LLM pass for PII (emails, API keys, paths, entropy tokens) | Our `redactPayloadForExport` — we already have this |
| **Quality Score** | 6-dimension composite (0.0–1.0), reported but **never filtered** | We have `evaluateSessionForCorpusQuality` but it's simpler |
| **Error Classify** | 5-factor taxonomy per trace: `tool_failure`, `syntax_error`, `reasoning_error`, `safety_refusal`, `timeout_stall`, `none` | We capture `exit_code` and `status` but don't classify errors |
| **Deduplicate** | Lexical diversity that ignores boilerplate tool-call JSON | We don't deduplicate at all currently |
| **Triple Export** | Axolotl `messages` + ShareGPT `conversations` + Unsloth `messages` simultaneously | We export only one format |
| **Dataset Card** | Auto-generated stats, error breakdown, Axolotl YAML | We don't generate dataset metadata |
| **HF Upload** | Optional `--push-to-hub` | Not needed yet |

#### Quality Scoring Dimensions

TALOS scores every trace on six dimensions (weighted sum, never used to filter):

```
quality_score = (reasoning_depth × 0.20)
              + (structure       × 0.20)
              + (tool_calls      × 0.15)
              + (coherence       × 0.15)
              + (length          × 0.15)
              + (refusal         × 0.15)
```

Key design choice: **label everything, filter nothing.** Error traces go into `data.jsonl`, clean traces also go into `data_clean.jsonl`. The user decides thresholds downstream. This is better than our current `task_success` boolean — we should adopt this philosophy.

#### Error Taxonomy (maps to our captured data)

| TALOS Label | Signal | Our equivalent |
|-------------|--------|----------------|
| `tool_failure` | HTTP 4xx/5xx, Connection refused, RateLimitError | `exit_code != 0` on Bash calls |
| `syntax_error` | Tracebacks, SyntaxError, malformed JSON | `output` containing stack traces |
| `reasoning_error` | Contradictions, hallucination tags | No direct equivalent — needs LLM classification |
| `safety_refusal` | Policy-violation language, jailbreak prompts | `permission_requests` table |
| `timeout_stall` | Empty turns mid-conversation, truncation | `finish_reason = timeout` or `compaction` events |
| `none` | Clean trace | Our current `task_success = true` |

#### What we'd need to adapt

1. **Input format conversion:** TALOS expects Hermes-style session format. We'd need a converter from our SQLite export (or export directly to TALOS JSONL).
2. **Tool-call boilerplate:** TALOS dedup ignores tool-call JSON boilerplate. Our `input_args` and `output` fields contain raw tool I/O — we'd need to teach the dedup to ignore our tool envelope format.
3. **Reasoning depth detection:** TALOS looks for `<thinking>`, `<reasoning>`, `<thought>` tags. Our agent doesn't produce these. We'd either need to (a) capture reasoning from the model's actual thinking, or (b) skip this dimension.

#### Verdict on TALOS

TALOS is not a drop-in — it's a reference architecture. The value is in adopting its **design patterns**: 6-dimension quality scoring, error taxonomy, label-don't-filter philosophy, and multi-format export. We could reimplement the core scoring/classification logic in TypeScript against our existing schema rather than trying to run TALOS's Python pipeline.

---

### AgentHER (Hindsight Experience Replay)

**Repo:** [alphadl/AgentHER](https://github.com/alphadl/AgentHER)
**License:** Apache 2.0

Instead of discarding failed trajectories, AgentHER **relabels the goal** to match what the agent actually accomplished. A trajectory that fails Task A becomes valid SFT/DPO data for Task B.

Four stages: failure detector → outcome extractor → prompt relabeler → data augmenter.

**Relevance to us:** Directly solves the "missing preference data" problem. Every failed session in our database has captured tool outputs — we know what the agent *actually did*. AgentHER could relabel those into valid training examples. The DPO pair synthesis (real success vs. relabeled failure for the same original prompt) is exactly what Phase 3 needs.

**Action:** Investigate as a post-Phase 3 enhancement. Wire our error-classified exports into AgentHER's pipeline.

---

### robinhood (Reasoning Trace Distillation)

**Repo:** [ManiacIncorporated/robinhood](**License:** MIT

Two-stage training: curriculum SFT (easy→hard) then REDI contrastive DPO using rejected traces.

**Key patterns to steal:**
- **Verification pipeline:** Automated for code (test execution), LLM-as-judge for everything else. This is the tiered approach we recommended in Phase 2.
- **REDI:** Keep rejected traces for contrastive DPO instead of discarding them. A 1.5B model trained on 131K examples (with rejected traces) matched 800K-example models without them.
- **Curriculum ordering:** Sort by difficulty (easy→hard) instead of random. Light-R1 showed this significantly improves results.

**Action:** Study their `TraceVerifier` dual pipeline (automated + LLM-judge) for Phase 2 implementation.

---

### training-pipeline (Logs as Seeds)

**Repo:** [officialasishkumar/training-pipeline](https://github.com/officialasishkumar/training-pipeline)
**License:** Not specified

Core insight: **logs should be seeds, not training data.** Raw captures are repetitive, low on edge cases, and full of PII. ~80% of trajectories are easy/single-tool. Training on them directly teaches the model to be average.

Instead: cluster user prompts, keep one representative per cluster, then generate synthetic trajectories with deliberate failure injection (TIMEOUT, INVALID_ARGS, RATE_LIMITED). This produces diverse training data that covers edge cases you'd never see in natural logs.

**Relevance to us:** We should think about our captures as seed material, not final training data. The `export_training_data` output should feed into a generation step, not directly into a trainer.

---

### Open Trajectory Gym (SFT → Online RL → GEPA)

**Repo:** [westonbrown/open-trajectory-gym](https://github.com/westonbrown/open-trajectory-gym)
**License:** Not specified

3-stage pipeline: SFT (TRL) → Online RL (SkyRL, live tool execution) → GEPA (DSPy prompt evolution). Domain-agnostic, bring your own agent/benchmark/reward.

**Relevance to us:** The Online RL stage uses live tool execution in Docker containers, solving the "can't replay" problem by holding the environment constant. This is the path for Phase 4+ when we want to generate new trajectories rather than curate existing ones.

---

### Agent Self-Review Feedback Loop

**Core pattern from research:** Reflect → Extract → Store → Retrieve

Nearly every recent self-improving agent system follows this loop (ERL, RetroAgent, SE-Agent, LEAFE, Agent-R). The differences are in *what* they extract and *how* they store it. The most relevant systems:

- **ERL (Experiential Reflective Learning):** After each task, the agent reflects on its trajectory and produces structured heuristics (trigger conditions + learned guidelines). Stored in a pool, retrieved by relevance for future tasks. +7.8% success rate on Gaia2 from accumulated self-review alone.
- **SE-Agent:** Three self-evolution operations — Revision (failure → new strategy), Recombination (merge strengths across trajectories), Refinement (eliminate redundancies). Achieved 80% on SWE-bench Verified.
- **AgentRx:** Generates invariants (rules that should hold true), checks them step-by-step against the trajectory, then classifies root cause into a 10-category taxonomy. Deterministic checks first, LLM only for final classification.
- **Long-Insight:** Decomposes trajectories into a DAG of logical steps, scores on difficulty + improvement potential. Detects 8 anti-patterns: test avoidance, missing verification, repetitive loops, inefficient exploration, ignored errors, verbose thinking, mid-trajectory deviation, late-stage waste.

#### Proposed architecture: Three-stage evaluation pipeline

```
Session completes
       │
       ▼
┌─────────────────────┐
│  Stage 1: Invariant  │  ← Deterministic, TypeScript, fast
│  Checker             │     Runs on every session, zero LLM cost
│  • exit_code checks  │
│  • output validation │
│  • file state checks │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Stage 2: Anti-      │  ← Heuristic, TypeScript, fast
│  Pattern Scanner     │     Pattern matching on tool call sequences
│  • repetitive calls  │
│  • ignored errors    │
│  • loops / stalls    │
│  • inefficient paths │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Stage 3: LLM Review │  ← Only for sessions passing stages 1-2
│  Skill               │     More expensive, batch offline
│  • reasoning quality │
│  • approach critique │
│  • alternative paths │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Reflection Store    │  ← Structured heuristics persisted
│  (per-session        │     alongside the trajectory
│   verdict + lessons) │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Training Export     │  ← Quality scores + error classes
│  (SFT + DPO)        │     attached to each trajectory
└─────────────────────┘
```

**Key insight:** Stages 1-2 are deterministic and cheap. You don't need an LLM to detect `exit_code != 0` or that the agent called `Read` on the same file 5 times. The LLM review is reserved for harder judgment calls. This means the feedback loop can run on every session, not just a sample.

#### Stage 1: Deterministic invariant checks (TypeScript)

These map directly to data we already capture in `codex_tool_calls`:

| Invariant | Check | Data source |
|-----------|-------|-------------|
| Successful write | After `Write`/`Edit` with `exit_code == 0`, file should exist | `output`, `exit_code` |
| Command success | After `Bash` call, `exit_code == 0` | `exit_code` |
| No empty output | Tool calls should produce non-empty `output` | `output` |
| Test passage | If `output` contains test runner output, all tests should pass | `output` regex |
| Compilation success | If `output` contains tsc/pylint/ruff output, no errors | `output` regex |
| No repeated failures | Same tool + same target + same error → flag as loop | `tool_name`, `target`, `exit_code` across calls |

#### Stage 2: Anti-pattern detection (TypeScript)

Pattern matching on sequences of tool calls within a session:

| Anti-pattern | Detection logic | Source fields |
|-------------|----------------|---------------|
| **Repetitive loops** | Same `tool_name` + same `target` called 3+ times | `tool_name`, `target`, `start_time` |
| **Ignored errors** | `exit_code != 0` on a call, next call is same tool+target with no corrective action | `exit_code`, `tool_name`, `target` |
| **Inefficient exploration** | `Read` calls on files not related to the task (detected by lack of subsequent `Edit`/`Write` on that file) | `tool_name`, `target`, followed-by analysis |
| **Test avoidance** | Session has test failures in early `output`, but agent continues editing without re-running tests | `output` patterns, no subsequent test-run tool call |
| **Missing verification** | After `Edit`/`Write`, no `Bash` call to verify (test, lint, compile) | `tool_name` sequence |
| **Late-stage waste** | Tool calls after the problem appears solved (detected by successful test + continued editing) | `output` patterns, `start_time` ordering |

#### Stage 3: LLM review skill

For sessions that pass stages 1-2, spawn a review session with a structured prompt:

```
You are reviewing a completed agent session. The session logs are attached.

Evaluate on these dimensions:
1. Correctness: Did the agent solve the stated problem?
2. Efficiency: Were there unnecessary steps or tool calls?
3. Reasoning: Did the agent's actions follow logically from the problem?
4. Recovery: If errors occurred, did the agent recover well?
5. Completeness: Are there edge cases or requirements the agent missed?

For each dimension, provide:
- Score (0-10)
- Brief justification
- If score < 7: what should have been done differently

Output as structured JSON.
```

**Blind spot mitigation:** Use a different model for review than the one that produced the trajectory, or run multiple independent review sessions and require consensus.

#### What this produces

Each session gets a `reflection` record:

```json
{
  "session_id": "...",
  "invariant_violations": [...],
  "anti_patterns": [...],
  "review_scores": {
    "correctness": 8,
    "efficiency": 6,
    "reasoning": 7,
    "recovery": 9,
    "completeness": 7
  },
  "review_comment": "...",
  "heuristics": [
    {
      "trigger": "When editing a file after test failure",
      "action": "Always re-run tests before making further edits"
    }
  ],
  "quality_score": 0.74,
  "error_class": "none"
}
```

This replaces the binary `task_success` with a rich, multi-dimensional quality signal that flows directly into the training export.

#### Research references

| System | Key contribution | Relevance |
|--------|-----------------|-----------|
| ERL | Structured heuristic extraction + retrieval | Reflection format, trigger/action structure |
| SE-Agent | Revision + Recombination + Refinement operations | Three-skill decomposition |
| AgentRx | Invariant-based step-by-step failure diagnosis | Stage 1 deterministic checks |
| Long-Insight | DAG decomposition + 8 anti-pattern detection | Stage 2 anti-pattern scanner |
| RetroAgent | Dual intrinsic feedback (numerical + language) | Two-tier scoring approach |
| LEAFE | Rollback + experience-guided branching | Learning from failure trajectories |
| Agent-R | MCTS-based revision trajectory construction | Splicing error → correction paths |
| CoEvolve | Feedback-driven task synthesis | Using failure signals to generate new training tasks |
| robinhood | Verification pipeline (automated + LLM-judge) | Tiered validation approach |

**Action:** Implement Stages 1-2 as TypeScript skills against existing `codex_tool_calls` data. Stage 3 as a batch offline review using a cheaper model. Wire reflection output into the training export as quality metadata.

---

### Summary of investigation priorities

| Priority | Project | What to investigate | When |
|----------|---------|-------------------|------|
| **P0** | Wire `input_args`/`output`/`exit_code` into export | One-line SQL fix, immediate value | Now |
| **P0** | Self-review Stage 1 (invariant checks) | Deterministic checks on `exit_code`/`output` | Now |
| **P1** | Self-review Stage 2 (anti-pattern scanner) | Pattern matching on tool call sequences | Before Phase 2 |
| **P1** | TALOS quality scoring patterns | Adopt 6-dimension scoring + error taxonomy in TypeScript | Before Phase 2 |
| **P1** | robinhood verification pipeline | Study dual verification (automated + LLM-judge) for Phase 2 | Phase 2 |
| **P2** | Self-review Stage 3 (LLM review skill) | Batch offline review with structured prompt | Phase 2 |
| **P2** | AgentHER relabeling | Relabel failed trajectories into valid DPO pairs | Phase 3 |
| **P2** | training-pipeline seed philosophy | Think of captures as seeds, not final training data | Phase 3 |
| **P3** | Open Trajectory Gym / DigiRL | Online RL with live tool execution | Future |
