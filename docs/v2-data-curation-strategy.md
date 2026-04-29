# From Logging to Training: V2 Data Curation Strategy

## The Vision: Active Curation over Passive Observation

In V1 of AgentLogger, the primary goal was **Passive Observation**: capturing the raw trajectory of user-agent interactions into a local SQLite database. While this provides a great audit trail, raw logs are often too noisy, unsafe, or poorly formatted to be dropped directly into a Supervised Fine-Tuning (SFT) pipeline.

To build world-class agents, we must transition to **Active Curation**. This document outlines the V2 strategy for transforming raw SQLite logs into high-fidelity, privacy-safe training datasets.

---

## Core Architectural Principle: Batch Processing

**Crucially, curation must not happen on the hot path.** 

Running LLM evaluators, NER (Named Entity Recognition) privacy scrubbers, or complex heuristics synchronously during a live session would introduce severe latency and ruin the developer experience. 

Instead, the V2 architecture relies on **Batch Processing**. 
* **Live phase:** The plugin continues to dump raw, lightweight events to the local SQLite database as fast as possible.
* **Batch phase:** A background worker, CLI command, or export pipeline runs periodically (e.g., daily, or at export time). This batch process handles the heavy lifting of grading, formatting, and scrubbing.

---

## The Four Pillars of V2 Curation

### 1. "LLM-as-a-Judge" (Replacing Heuristics)
Currently, `efficiency_score` is a hard-coded heuristic based on duration and error counts. It measures *smoothness*, not *correctness*.

**The Batch Solution:**
Run an asynchronous "Grader" pipeline. A frontier model (like Claude 3.5 Sonnet or GPT-4o) reviews completed sessions against a strict rubric.
* **Logic:** Did the reasoning logically lead to the tool call?
* **Precision:** Were the tool arguments optimal?
* **Recovery:** If an error occurred, did the agent recover gracefully?
* *Output:* The grader assigns a rigorous `quality_score` (1-5) and filters out hallucinations or "lucky guesses."

### 2. High-Fidelity Reasoning (The ReAct Pattern)
Training models to use tools effectively requires teaching them *how to think*, not just what to output. 

**The Batch Solution:**
During the batch export, the pipeline must enforce a strict **ReAct (Reason, Act, Observe)** structure.
* If a raw log contains a tool call *without* preceding reasoning, a "Teacher LLM" can be used in batch to **back-fill the missing thought process** (Teacher-Student Distillation).
* The final JSONL enforces the alternating pattern: `Thought` -> `Action` (Tool) -> `Observation` (Output).

### 3. Synthetic Privacy (Beyond Redaction)
Naive redaction (e.g., replacing an API key with `[REDACTED]`) damages the semantic fidelity of the training data. The model stops learning how to handle real token shapes.

**The Batch Solution:**
Implement a batch scrubbing phase that uses **Synthetic Replacement**.
* Instead of masking `sk-live-123456`, the scrubber replaces it with a synthetically generated, structurally identical fake: `sk-synth-987654`.
* "John Doe" becomes "Sam Smith". 
* This ensures the model learns the correct context without memorizing real PII (Personally Identifiable Information).

### 4. Outcome-Based Verification (Ground Truth)
The highest quality training data comes from verified success, not just an LLM's opinion.

**The Batch Solution:**
Link trajectories to deterministic real-world outcomes.
* **`session.diff`:** Subscribe to file change events. If a trajectory results in a diff that successfully passes local linting or tests, it gets an automatic quality multiplier.
* **Git hooks:** If a session's changes are committed and pushed, that trajectory is heavily weighted as a "Success."

---

## Next Steps for Implementation

1. **Refactor `export_training_data`:**
   Modify the current export tool to support an `--evaluator` flag. When passed, it routes the raw SQLite trajectories through a local or API-based LLM to generate a `quality_score` before writing the JSONL.
2. **Implement the "Vault" Scrubber:**
   Add a batch command (`opencode logs scrub`) that runs a local NER model (like Microsoft Presidio) over the database to synthetically replace secrets and PII prior to export.
3. **Capture `session.diff`:** (Completed)
   The plugin now listens to the `session.diff` event authoritatively, storing per-session file changes (additions, deletions, status) in the `session_diffs` table. This provides hard evidence of what a session actually accomplished on disk.

---

## Further Research & Reading

If you are expanding this into a blog post or continuing development, these topics are essential reading:

* **Prometheus-2 & G-Eval:** Frameworks for building stable, repeatable LLM-as-a-judge rubrics.
* **ReAct Prompting / Llama 3 Tool Calling Guidelines:** The industry standards for formatting tool-use training data.
* **Microsoft Presidio:** An open-source tool for PII identification and anonymization.
* **Teacher-Student Distillation in LLMs:** How frontier models are used to clean and augment datasets for smaller, fine-tuned models.
