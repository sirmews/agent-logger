import { readStdinSync } from './utils/stdin.js';
import { writeToBuffer } from './utils/buffer-writer.js';
import { createEnvelope } from './utils/envelope.js';
import { getSessionStartGitContext, getStopGitContext } from './utils/git-context.js';
import type { CodexPermissionMode, CodexSessionSource } from './types.js';

async function main() {
  try {
    const isStart = process.argv.includes('--start');
    const isStop = process.argv.includes('--stop');

    if (!isStart && !isStop) {
      console.log(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const stdinText = readStdinSync().trim();
    let payload: Record<string, unknown> = {};
    if (stdinText) {
      try {
        payload = JSON.parse(stdinText);
      } catch (e) {
        payload = { rawStdin: stdinText };
      }
    }

    const cwd = (payload.cwd ?? process.cwd()) as string;

    if (isStart) {
      const eventName = 'SessionStart';
      const model = typeof payload.model === 'string'
        ? payload.model
        : typeof payload.model === 'object' && payload.model !== null
          ? ((payload.model as Record<string, unknown>).modelID ?? (payload.model as Record<string, unknown>).modelId ?? null) as string | null
          : null;
      const permissionMode = (payload.permission_mode ?? null) as CodexPermissionMode | null;
      const sessionSource = (payload.source ?? null) as CodexSessionSource | null;

      const gitContext = getSessionStartGitContext(cwd);

      const normalized: Record<string, unknown> = {
        session_source: sessionSource,
      };

      const envelope = createEnvelope({
        source_agent: 'codex',
        source_event: eventName,
        raw: payload,
        normalized,
        session_id: (payload.sessionID ?? payload.session_id) as string | null,
        cwd,
        model,
        permission_mode: permissionMode,
        session_source: sessionSource,
        transcript_path: payload.transcript_path as string | null,
        git_context: gitContext,
      });

      writeToBuffer(envelope);
      console.log(JSON.stringify({ continue: true, systemMessage: null }));
    } else {
      const eventName = 'Stop';
      const stopHookActive = (payload.stop_hook_active ?? null) as boolean | null;

      const gitContext = getStopGitContext(cwd);

      const normalized: Record<string, unknown> = {
        finish_reason: payload.finishReason ?? payload.finish_reason ?? null,
        stop_hook_active: stopHookActive,
      };

      const envelope = createEnvelope({
        source_agent: 'codex',
        source_event: eventName,
        raw: payload,
        normalized,
        session_id: (payload.sessionID ?? payload.session_id) as string | null,
        cwd,
        stop_hook_active: stopHookActive,
        transcript_path: payload.transcript_path as string | null,
        git_context: gitContext,
      });

            writeToBuffer(envelope);
      
      // Auto-ingest offline for seamless dashboard/export integration
      if (!process.env.AGENT_LOGGER_DISABLE_AUTO_INGEST) {
        try {
          const { spawn } = await import("child_process");
          // Spawn the agent-logger ingest command completely detached so it doesn't block Codex
          const child = spawn("bun", ["run", "agent-logger", "ingest"], {
            detached: true,
            stdio: "ignore",
          });
          child.on('error', () => {}); // Prevent unhandled exceptions
          child.unref();
        } catch (e) {
          // Fail silently
        }
      }
      
      console.log(JSON.stringify({ continue: true }));
    }

    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

main();
