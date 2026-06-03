import {
  randomUUID,
} from "crypto";
import {
  CAPTURE_SCHEMA_VERSION,
  type CaptureEnvelope,
  type SourceAgent,
  type CodexPermissionMode,
  type CodexSessionSource,
  type TruncationMeta,
  type GitContext,
} from "../types.js";
const LOGGER_VERSION: string = "__LOGGER_VERSION__";

const MAX_PAYLOAD_BYTES = 200_000;
const MAX_STRING_BYTES = 50_000;

/**
 * Creates a versioned capture envelope wrapping the raw payload with normalized fields.
 */
export function createEnvelope(opts: {
  source_agent: SourceAgent;
  source_event: string;
  raw: Record<string, unknown>;
  normalized: Record<string, unknown>;
  session_id?: string | null;
  turn_id?: string | null;
  transcript_path?: string | null;
  cwd?: string | null;
  model?: string | null;
  permission_mode?: CodexPermissionMode | null;
  session_source?: CodexSessionSource | null;
  stop_hook_active?: boolean | null;
  git_context?: GitContext | null;
  skip_raw_truncation?: boolean;
}): CaptureEnvelope {
  let truncation: TruncationMeta | null = null;
  let raw = opts.raw;

  if (!opts.skip_raw_truncation) {
    truncation = computeTruncation(opts.raw);
    if (truncation) {
      raw = truncateRawPayload(opts.raw);
      truncation = {
        ...truncation,
        stored_bytes: Buffer.byteLength(JSON.stringify(raw), "utf-8"),
      };
    }
  }

  return {
    schema_version: CAPTURE_SCHEMA_VERSION,
    logger_version: LOGGER_VERSION,
    record_id: randomUUID(),
    captured_at: Date.now(),
    source_agent: opts.source_agent,
    source_event: opts.source_event,
    session_id: opts.session_id ?? extractSessionId(opts.raw),
    turn_id: opts.turn_id ?? extractTurnId(opts.raw),
    transcript_path: opts.transcript_path ?? extractTranscriptPath(opts.raw),
    cwd: opts.cwd ?? extractCwd(opts.raw),
    model: opts.model ?? null,
    permission_mode: opts.permission_mode ?? null,
    session_source: opts.session_source ?? null,
    stop_hook_active: opts.stop_hook_active ?? null,
    normalized: opts.normalized,
    raw,
    truncation,
    redaction: null,
    git_context: opts.git_context ?? null,
  };
}

function extractSessionId(raw: Record<string, unknown>): string {
  return (raw.sessionID ?? raw.session_id ?? "unknown") as string;
}

function extractTurnId(raw: Record<string, unknown>): string | null {
  return (raw.turn_id ?? raw.turnID ?? null) as string | null;
}

function extractTranscriptPath(raw: Record<string, unknown>): string | null {
  return (raw.transcript_path ?? null) as string | null;
}

function extractCwd(raw: Record<string, unknown>): string | null {
  return (raw.cwd ?? raw.projectPath ?? raw.project_path ?? null) as string | null;
}

function computeTruncation(raw: Record<string, unknown>): TruncationMeta | null {
  const serialized = JSON.stringify(raw);
  const originalBytes = Buffer.byteLength(serialized, "utf-8");
  if (originalBytes <= MAX_PAYLOAD_BYTES) return null;
  return {
    field: "raw",
    stored_bytes: Math.min(originalBytes, MAX_PAYLOAD_BYTES),
    original_bytes: originalBytes,
  };
}

/**
 * Truncates a raw payload that exceeds the byte limit by truncating individual
 * large string fields, preserving the object structure and all non-string fields.
 */
export function truncateRawPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(raw);
  const byteLen = Buffer.byteLength(serialized, "utf-8");
  if (byteLen <= MAX_PAYLOAD_BYTES) return raw;

  function truncateStringValue(s: string, maxBytes: number): string {
    const marker = "\n---TRUNCATED---";
    const markerBytes = Buffer.byteLength(marker, "utf-8");
    const effectiveMax = maxBytes - markerBytes;
    if (Buffer.byteLength(s, "utf-8") <= maxBytes) return s;
    let truncated = s.slice(0, effectiveMax);
    while (Buffer.byteLength(truncated, "utf-8") > effectiveMax) {
      truncated = truncated.slice(0, -1);
    }
    return truncated + marker;
  }

  function truncateStrings(obj: unknown, maxStringBytes: number): unknown {
    if (typeof obj === "string") {
      return truncateStringValue(obj, maxStringBytes);
    }
    if (Array.isArray(obj)) {
      return obj.map((v) => truncateStrings(v, maxStringBytes));
    }
    if (obj && typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        result[key] = truncateStrings(value, maxStringBytes);
      }
      return result;
    }
    return obj;
  }

  function countStringFields(obj: unknown): number {
    if (typeof obj === "string") return 1;
    if (Array.isArray(obj)) return obj.reduce((sum: number, v) => sum + countStringFields(v), 0);
    if (obj && typeof obj === "object") {
      return Object.values(obj as Record<string, unknown>).reduce((sum: number, v) => sum + countStringFields(v), 0);
    }
    return 0;
  }

  let currentMax = MAX_STRING_BYTES;
  let truncated = raw;
  for (let pass = 0; pass < 3; pass++) {
    truncated = truncateStrings(raw, currentMax) as Record<string, unknown>;
    truncated.__truncated = true;
    truncated.__original_bytes = byteLen;
    const totalBytes = Buffer.byteLength(JSON.stringify(truncated), "utf-8");
    if (totalBytes <= MAX_PAYLOAD_BYTES) break;
    const stringCount = countStringFields(raw);
    if (stringCount > 0) {
      currentMax = Math.floor(MAX_PAYLOAD_BYTES / stringCount);
    } else {
      break;
    }
  }
  return truncated;
}
