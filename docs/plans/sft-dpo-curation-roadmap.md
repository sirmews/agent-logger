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
