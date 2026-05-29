import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import {
  computeEfficiency,
  evaluateSessionForCorpusQuality,
  getBuiltinRedactionPatterns,
  getExtraRedactionPatterns,
  createRedactionState,
  redactPayloadForExport,
} from "../index";

interface ExportArgs {
  dbPath: string | null;
  outputPath: string | null;
  minEfficiency: number;
  qualityProfile: string;
  minQualityScore: number;
  redact: boolean;
  limit: number;
}

/**
 * Safe parser for finite floats.
 * @param v - Input string value.
 * @param fallback - Fallback number if non-numeric or infinite.
 * @returns The parsed float or fallback.
 */
function toFiniteFloat(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Safe parser for finite integers.
 * @param v - Input string value.
 * @param fallback - Fallback number if non-numeric or infinite.
 * @returns The parsed integer or fallback.
 */
function toFiniteInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parses CLI string arguments into structured ExportArgs options.
 * @param args - Array of CLI arguments.
 * @returns The parsed arguments.
 */
export function parseArgs(args: string[]): ExportArgs {
  let dbPath: string | null = null;
  let outputPath: string | null = null;
  let minEfficiency = 0.0;
  let qualityProfile = "default";
  let minQualityScore = 0.0;
  let redact = true;
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db") {
      dbPath = args[++i] ?? null;
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.substring(5);
    } else if (arg === "--output") {
      outputPath = args[++i] ?? null;
    } else if (arg.startsWith("--output=")) {
      outputPath = arg.substring(9);
    } else if (arg === "--min-efficiency") {
      minEfficiency = toFiniteFloat(args[++i], 0.0);
    } else if (arg.startsWith("--min-efficiency=")) {
      minEfficiency = toFiniteFloat(arg.substring(17), 0.0);
    } else if (arg === "--quality-profile") {
      qualityProfile = args[++i] ?? "default";
    } else if (arg.startsWith("--quality-profile=")) {
      qualityProfile = arg.substring(18);
    } else if (arg === "--min-quality-score") {
      minQualityScore = toFiniteFloat(args[++i], 0.0);
    } else if (arg.startsWith("--min-quality-score=")) {
      minQualityScore = toFiniteFloat(arg.substring(20), 0.0);
    } else if (arg === "--redact") {
      const nextVal = args[i + 1];
      if (nextVal === "false") {
        redact = false;
        i++;
      } else if (nextVal === "true") {
        redact = true;
        i++;
      } else {
        redact = true;
      }
    } else if (arg.startsWith("--redact=")) {
      redact = arg.substring(9) !== "false";
    } else if (arg === "--limit") {
      limit = toFiniteInt(args[++i], 50);
    } else if (arg.startsWith("--limit=")) {
      limit = toFiniteInt(arg.substring(8), 50);
    }
  }

  return {
    dbPath,
    outputPath,
    minEfficiency,
    qualityProfile,
    minQualityScore,
    redact,
    limit,
  };
}

/**
 * Runs the SFT export process by reading and evaluating sessions from a SQLite DB.
 * @param args - Parsed ExportArgs configuration.
 * @returns A promise resolving on completion.
 */
export async function runExport(args: ExportArgs): Promise<void> {
  if (!args.dbPath) {
    throw new Error("Missing required argument: --db <dbPath>");
  }
  if (!args.outputPath) {
    throw new Error("Missing required argument: --output <outputPath>");
  }

  // Open Database in standard mode
  const db = new Database(args.dbPath);

  try {
    // Enable WAL and foreign keys
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");

    // Read all sessions from codex_sessions, with stable ordering to ensure deterministic exports
    const sessions = db.prepare("SELECT * FROM codex_sessions ORDER BY start_time ASC").all() as any[];

    // Define Redaction
    const redactionPatterns = args.redact
      ? [
          ...getBuiltinRedactionPatterns(),
          ...getExtraRedactionPatterns(process.env.AGENT_LOGGER_EXTRA_REDACTION_PATTERNS),
        ]
      : [];
    const redactionState = args.redact ? createRedactionState() : null;

    const exportedLines: string[] = [];

    for (const session of sessions) {
      const sessionId = session.session_id;

      // Retrieve all messages for the session sorted by timestamp ASC
      const messages = db
        .prepare(
          "SELECT role, content, timestamp FROM codex_messages WHERE session_id = ? ORDER BY timestamp ASC",
        )
        .all(sessionId) as any[];

      // Retrieve all tool calls for the session
      const toolCalls = db
        .prepare(
          "SELECT tool_name, status, duration_ms FROM codex_tool_calls WHERE session_id = ?",
        )
        .all(sessionId) as any[];

      // Compute quality signals
      const userMessages = messages.filter((m) => m.role === "user").length;
      const assistantMessages = messages.filter((m) => m.role === "assistant").length;
      const toolTotal = toolCalls.length;
      const toolCompleted = toolCalls.filter((t) => t.status === "completed").length;
      const toolErrors = toolCalls.filter((t) => t.status === "error").length;
      const toolDurationMs = toolCalls.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0);

      const uniqueToolNames = new Set(toolCalls.map((t) => t.tool_name).filter(Boolean));
      const uniqueToolCount = uniqueToolNames.size;

      const hasSystemPrompt = messages.some((m) => m.role === "system");
      const taskSuccess = session.finish_reason !== "error" && toolErrors === 0;

      const efficiencyScore = computeEfficiency({
        total: toolTotal,
        completed: toolCompleted,
        errors: toolErrors,
        totalDurationMs: toolDurationMs,
      });

      const qualitySignal = {
        efficiencyScore,
        taskSuccess,
        toolTotal,
        toolCompleted,
        toolErrors,
        toolDurationMs,
        uniqueToolCount,
        userMessages,
        assistantMessages,
        hasSystemPrompt,
      };

      // Evaluate session quality score
      const quality = evaluateSessionForCorpusQuality(qualitySignal, args.qualityProfile);

      // Filter out sessions that fail minEfficiency or minQualityScore
      if (efficiencyScore < args.minEfficiency || quality.score < args.minQualityScore) {
        continue;
      }

      // Reconstruct SFT payload
      const sftPayload: any = {
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        metadata: {
          session_id: sessionId,
          project: session.project_path,
          efficiency: efficiencyScore,
          quality: {
            score: quality.score,
            profile: quality.profileName,
          },
        },
      };

      // Apply deterministic redaction if requested
      const finalPayload =
        args.redact && redactionState
          ? redactPayloadForExport(sftPayload, redactionState, redactionPatterns)
          : sftPayload;

      exportedLines.push(JSON.stringify(finalPayload));
    }

    // Slice to limit
    const finalLines = exportedLines.slice(0, args.limit);

    // Write to output file
    const outDir = path.dirname(args.outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    fs.writeFileSync(args.outputPath, finalLines.join("\n") + "\n", "utf-8");
  } finally {
    db.close();
  }
}

// Execution block
if (import.meta.main) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    await runExport(parsed);
    process.exit(0);
  } catch (error) {
    console.error(`Export failed: ${String(error)}`);
    process.exit(1);
  }
}
