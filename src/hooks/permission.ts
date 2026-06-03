import { readStdinSync } from './utils/stdin.js';
import { writeToBuffer } from './utils/buffer-writer.js';
import { createEnvelope } from './utils/envelope.js';
import type { CodexPermissionMode } from './types.js';

function main() {
  try {
    const stdinText = readStdinSync().trim();
    let payload: Record<string, unknown> = {};
    if (stdinText) {
      try {
        payload = JSON.parse(stdinText);
      } catch (e) {
        payload = { rawStdin: stdinText };
      }
    }

    const eventName = 'PermissionRequest';
    const cwd = (payload.cwd ?? process.cwd()) as string;

    const toolName = (payload.tool_name ?? payload.tool ?? null) as string | null;
    const toolInput = payload.tool_input ?? payload.input ?? null;
    const turnId = (payload.turn_id ?? null) as string | null;
    const permissionMode = (payload.permission_mode ?? null) as CodexPermissionMode | null;
    const agentId = (payload.agent_id ?? null) as string | null;
    const agentType = (payload.agent_type ?? null) as string | null;

    const normalized: Record<string, unknown> = {
      tool_name: toolName,
      tool_input: toolInput,
      turn_id: turnId,
      permission_mode: permissionMode,
      agent_id: agentId,
      agent_type: agentType,
    };

    const envelope = createEnvelope({
      source_agent: 'codex',
      source_event: eventName,
      raw: payload,
      normalized,
      session_id: (payload.sessionID ?? payload.session_id) as string | null,
      turn_id: turnId,
      cwd,
      permission_mode: permissionMode,
      transcript_path: payload.transcript_path as string | null,
    });

    writeToBuffer(envelope);
    // Intentional: this hook is capture-only / observational. Auto-allowing ensures
    // the agent is never blocked by the logger, consistent with passive telemetry design.
    console.log(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  } catch (err) {
    // Same as above: fail-safe auto-allow on error to never block the agent.
    console.log(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  }
}

main();
