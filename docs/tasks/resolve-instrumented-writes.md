# Task: Resolve enforce-instrumented-writes Warnings

## Context

The `ast-grep` linter (`sg scan`) enforces a reliability rule `enforce-instrumented-writes` under `.ast-grep/rules/reliability/enforce-instrumented-writes.yml`. This rule ensures that all database write operations are wrapped in the `instrument()` function to monitor execution latency on the event hot path.

Currently, there are 32 occurrences of non-instrumented database writes in `src/index.ts`. These must be resolved to satisfy the strict quality gates.

## Warnings List

The warnings are located in `src/index.ts` across several main logical areas:

### 1. Migrations Path (`migrate` function)
The database migration queries run synchronously during initialization and are not instrumented:
- Line 398: `db.prepare("INSERT INTO schema_version...").run(1)`
- Line 414: `db.prepare("INSERT INTO schema_version...").run(2)`
- Line 433: `db.prepare("INSERT INTO schema_version...").run(3)`

*Note: Since migrations run only once at startup, we should decide if they require instrumentation or if the ast-grep rule should exclude the `migrate` function scope.*

### 2. Session Refresh and Evaluation (`refreshSessionAggregates` & `refreshTrainingExample`)
Aggregates and training example generation writes are not instrumented:
- Lines 983–1001: `db.prepare("UPDATE sessions SET...").run(...)` inside `refreshSessionAggregates`
- Lines 1071–1094: `db.prepare("INSERT INTO training_examples...").run(...)` inside `refreshTrainingExample`
- Lines 1096–1103: `stmt.upsertSessionQuality.run(...)` inside `refreshTrainingExample`

### 3. Event Hook Handlers (`event` hook)
Multiple synchronous event handlers bypass the `instrument` block:
- Line 1257: `stmt.upsertSession.run(...)`
- Lines 1269–1271: `db.prepare("UPDATE sessions SET title...").run(...)`
- Line 1277: `stmt.insertSessionDiff.run(...)`
- Line 1288: `stmt.setSessionLifecycle.run("deleted", ...)`
- Line 1291: `stmt.bumpSessionError.run(...)`
- Line 1292: `stmt.setSessionLifecycle.run("error", ...)`
- Line 1297: `stmt.setSessionStatus.run(type, ...)`
- Line 1302: `stmt.setSessionLifecycle.run("completed", ...)`
- Line 1325: `stmt.upsertPermissionAsked.run(...)`
- Line 1337: `stmt.updatePermissionReplied.run(...)`
- Line 1344: `stmt.insertFileEdit.run(...)`
- Line 1347: `stmt.insertCommand.run(...)`

### 4. Other Hook Handlers (`chat.params`, system prompt, before/after hooks)
- Line 1366: `stmt.insertChatParams.run(...)`
- Line 1387: `stmt.setSessionSystemPrompt.run(...)`
- Line 1395: `stmt.insertToolHookBefore.run(...)`
- Line 1414: `stmt.updateToolHookAfter.run(...)`

### 5. Maintenance / Tool Handlers (`prune_old_data` tool)
Bulk delete statements inside the transaction of `prune_old_data` are not instrumented:
- Lines 1743–1752: `db.prepare("DELETE FROM message_parts...").run(...)` and consecutive prunes.

---

## Resolution Strategy

To resolve these warnings:

1. **Wrap Event and Hook Writes**: Use the `instrument` helper for all event-driven writes:
   ```typescript
   instrument("upsertSession", () => stmt.upsertSession.run(...));
   ```

2. **Exempt Migrations / Maintenance**: If certain cold-path functions (like `migrate` or `prune_old_data`) do not benefit from hot-path latency instrumentation, we can either:
   - Wrap them anyway with a generic label (e.g., `instrument("migration", ...)`).
   - Or adjust the `.ast-grep` rules to ignore directories/methods if possible.
