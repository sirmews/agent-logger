export const CAPTURE_SCHEMA_VERSION = 1;

export type SourceAgent = "codex" | "opencode";

export type CodexPermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

export type CodexSessionSource = "startup" | "resume" | "clear" | "compact";

export type TruncationMeta = {
  field: string;
  stored_bytes: number;
  original_bytes: number;
};

export type CaptureEnvelope = {
  schema_version: number;
  logger_version: string;
  record_id: string;
  captured_at: number;
  source_agent: SourceAgent;
  source_event: string;
  session_id: string;
  turn_id: string | null;
  transcript_path: string | null;
  cwd: string | null;
  model: string | null;
  permission_mode: CodexPermissionMode | null;
  session_source: CodexSessionSource | null;
  stop_hook_active: boolean | null;
  normalized: Record<string, unknown>;
  raw: Record<string, unknown>;
  truncation: TruncationMeta | null;
  redaction: unknown | null;
  git_context: GitContext | null;
};

export type GitContext = {
  git_root: string | null;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  remote_url: string | null;
  changed_files: ChangedFileSummary | null;
};

export type ChangedFileSummary = {
  files: string[];
  omitted_count: number;
};

export type NormalizedToolMeta = {
  tool_name: string;
  tool_use_id: string | null;
  turn_id: string | null;
  command: string | null;
  target: string | null;
  status: string | null;
  exit_code: number | null;
  duration_ms: number | null;
};

export type NormalizedPermissionMeta = {
  tool_name: string | null;
  tool_input: unknown;
  turn_id: string | null;
  permission_mode: CodexPermissionMode | null;
  agent_id: string | null;
  agent_type: string | null;
};

export type NormalizedCompactMeta = {
  turn_id: string | null;
  reason: string | null;
};

export type NormalizedSubagentMeta = {
  subagent_id: string | null;
  parent_turn_id: string | null;
  agent_type: string | null;
};
