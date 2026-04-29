# AgentLogger

Agent logger plugin for OpenCode that captures session events into a local SQLite store and exports curated training datasets.

## Architecture

```text
  +----------+       +------------------+       +-----------------------+
  | OpenCode | ----> | Event Hooks      | ----> | SQLite (Local)        |
  | (Host)   |       | (src/index.ts)   |       | (~/.local/share/...)  |
  +----------+       +---------+--------+       +-----------+-----------+
                               |                            |
                               |                            |
  +----------+       +---------v--------+       +-----------v-----------+
  | User     | <---> | Plugin Tools     | <---- | Data Export /         |
  | (CLI)    |       | (analyze_logs)   |       | Training JSONL        |
  +----------+       +------------------+       +-----------------------+
```

## Overview

The plugin monitors the OpenCode lifecycle to capture tool trajectories, chat history, and system metadata. It calculates efficiency scores and applies quality rubrics to filter high-quality trajectories for machine learning training data.

## Data Persistence

Logs are stored in a WAL-enabled SQLite database. Default path:
`~/.local/share/opencode/communication-logs.db`.

Override the path with one of these environment variables:
- `AGENT_LOGGER_DB_PATH`
- `COMMUNICATION_LOGGER_DB_PATH`
- `OPENCODE_COMMUNICATION_LOGGER_DB_PATH`

Add extra redaction rules with:
- `AGENT_LOGGER_EXTRA_REDACTION_PATTERNS`

This should be a semicolon-separated list of JavaScript regular expressions (no surrounding `/.../` flags), for example: `export AGENT_LOGGER_EXTRA_REDACTION_PATTERNS="(?i)secret-token;api_key=\\w+"`.

## Configuration

### Storage path

- Set an explicit database file path with any of the supported env vars above.
- Useful for containers and read-only home directories.
- The plugin enforces safe defaults for the resolved file location:
  - directory: `0700`
  - database file: `0600`

Example:

```bash
export AGENT_LOGGER_DB_PATH="/run/user/1000/agent-logger.db"
```

### Export safety defaults

- `export_training_data` redacts common secrets by default.
- Additional patterns can be enabled with `AGENT_LOGGER_EXTRA_REDACTION_PATTERNS`.
- Default arguments were tuned toward safety:
  - `min_efficiency: 0.0`
  - `quality_profile: default`
  - `require_success: false`
  - `redact: true`
- If you need all sessions without filtering, set `min_efficiency: 0`, `require_success: false`.
- For unredacted export payloads, set `redact: false` explicitly.

### Corpus quality profiles (deterministic eval)

Session quality is scored with one of three deterministic profiles:

- `default` (balanced)
- `conservative` (higher bar for tool-backed outcomes)
- `permissive` (fewer constraints)

You can set the default profile with:

- `AGENT_LOGGER_QUALITY_PROFILE`

`export_training_data` also accepts:

- `quality_profile` (default: `default`)
- `min_quality_score` (`0` to `1`)

The score and components are included in the exported payload metadata under
`metadata.quality`.

## Troubleshooting

- Plugin fails to start with a permission error:
  - Verify `AGENT_LOGGER_DB_PATH` (or fallback env var) points to a writable location.
  - Ensure the resolved path's parent directory is writable by the process.
  - Confirm no other process is holding a stale lock on the SQLite file.
- DB still writing to default location when override is set:
  - Start Opencode from the same shell/session where the env var is defined.
  - Check startup logs for: `Using override database path via environment variable`.
- `export_training_data` appears to miss fields:
  - The export is based on rebuilt sessions from `message`/`message.part` rows.
  - Re-run with `min_efficiency: 0`, `require_success: false` to inspect full corpus first.

### Schema Summary

- `sessions`: Session-level metrics (total calls, success status, duration).
- `messages`: Full message history with role, model info, and token counts.
- `message_parts`: Fine-grained trajectory data (text, tool calls, reasoning).
- `training_examples`: Recomputed session summaries for easy filtering/export.
- `session_quality`: Deterministic rubric scores for exported corpus selection.
- `session_diffs`: Authoritative per-session file changes (authoritative diffs).
- `tool_call_hooks`: Hook-time mirror of tool executions.
- `chat_params`: Model configurations (temperature, top_p, etc.).
- `file_edits`: Global filesystem modification heartbeat.
- `permissions`: History of user permission responses.

## Provided Tools

| Tool | Description | Arguments |
|------|-------------|-----------|
| `analyze_logs` | Performance analytics per project | `limit` (int), `project_filter` (string) |
| `export_training_data` | Generates JSONL fine-tuning data + summary | `min_efficiency` (float), `quality_profile` (string), `min_quality_score` (float), `limit` (int), `project_filter` (string), `require_success` (bool), `redact` (bool) |
| `get_dashboard` | Real-time session and daily metrics | - |
| `prune_old_data` | Maintenance for training records | `days` (int), `dry_run` (bool) |

## Training Data Format

The `export_training_data` tool produces a JSON response containing a summary and the JSONL lines:

```json
{
  "summary": {
    "total_candidates": 150,
    "passed_threshold": 42,
    "min_efficiency": 0.0,
    "min_quality_score": 0.7,
    "quality_profile": "default",
    "require_success": true,
    "redacted": true,
    "limit_applied": 50
  },
  "jsonl": "{\"messages\": [...], \"metadata\": {\"quality\": {\"score\": 0.85, ...}, ...}}\n..."
}
```

## Advanced Configuration

### Redaction Presets

- `AGENT_LOGGER_REDACTION_PRESET`: Choose a risk profile for secret redaction.
  - `minimal`: Only high-confidence secrets (OpenAI keys, JWTs).
  - `standard` (default): Common keys, Bearer tokens, AWS, GitHub, Google.
  - `strict`: Aggressive matching including all UUIDs and generic hashes.

### Performance Tuning

- `AGENT_LOGGER_DB_WRITE_MODE`: Set to `sync` (default) or `batch` (future).
- `AGENT_LOGGER_DB_LATENCY_THRESHOLD_MS`: Log a debug warning when DB writes exceed this duration (default: `50`).

## Installation

Add the package name to your `opencode.json` configuration:

```json
{
  "plugin": ["agent-logger"]
}
```

## Development checks

Quality gates:

```bash
bun run quality
```

Or run components separately:

- `bun run lint:jsdoc` for API documentation coverage.
- `bun run lint:ai` for AST guardrails under `.ast-grep/rules`.
- `bun test` for regression coverage.

Requires Bun runtime.

```bash
bun install
bun run build     # Outputs to dist/
bun run typecheck # Validate types
bun test         # Run Bun unit tests
```

To test locally, point to the compiled distribution:

```json
{
  "plugin": ["file:///path/to/project/dist/index.js"]
}
```

## References

- [OpenCode Plugin Hooks — Canonical Reference](docs/opencode-plugin-hooks.md) (in-repo, source-verified)
- [Code Maturity and Standards](docs/code-maturity-and-standards.md)
- [Caveats & Rationale](docs/caveats-and-rationale.md) — known limitations and the design reasoning behind them
- [OpenCode Official Documentation](https://opencode.ai/docs)
- [OpenCode Configuration Guide](https://opencode.ai/docs/config)
- [@opencode-ai/plugin on npm](https://www.npmjs.com/package/@opencode-ai/plugin)
- [OpenCode GitHub Repository (anomalyco/opencode)](https://github.com/anomalyco/opencode)

## License
MIT
