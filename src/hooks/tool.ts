import { readStdinSync } from './utils/stdin.js';
import { writeToBuffer } from './utils/buffer-writer.js';
import { createEnvelope, truncateRawPayload } from './utils/envelope.js';

const MAX_TOOL_RESPONSE_BYTES = 200_000;

function main() {
  try {
    const isBefore = process.argv.includes('--before');
    const isAfter = process.argv.includes('--after');

    if (!isBefore && !isAfter) {
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
    const toolName = (payload.tool ?? payload.tool_name ?? null) as string | null;
    const toolUseId = (payload.callID ?? payload.call_id ?? payload.tool_use_id ?? null) as string | null;
    const turnId = (payload.turn_id ?? payload.turnID ?? null) as string | null;

    if (isBefore) {
      const eventName = 'PreToolUse';

      let command: string | null = null;
      let target: string | null = null;

      const args = payload.args ?? payload.tool_input ?? null;
      if (args && typeof args === 'object') {
        command = (args as Record<string, unknown>).command as string | null ?? null;
        target = (args as Record<string, unknown>).filePath as string | null
          ?? (args as Record<string, unknown>).file_path as string | null
          ?? null;
      }

      const normalized: Record<string, unknown> = {
        tool_name: toolName,
        tool_use_id: toolUseId,
        turn_id: turnId,
        command,
        target,
        tool_input: args ?? null,
      };

      const envelope = createEnvelope({
        source_agent: 'codex',
        source_event: eventName,
        raw: payload,
        normalized,
        session_id: (payload.sessionID ?? payload.session_id) as string | null,
        turn_id: turnId,
        cwd,
        transcript_path: payload.transcript_path as string | null,
      });

      writeToBuffer(envelope);
    } else {
      const eventName = 'PostToolUse';

      const status = (payload.status ?? 'completed') as string;
      const toolResponse = payload.output ?? payload.tool_response ?? null;
      const exitCode = (payload.exit_code ?? payload.exitCode ?? null) as number | null;

      let truncationField: string | null = null;
      let storedBytes = 0;
      let originalBytes = 0;
      if (typeof toolResponse === 'string' && Buffer.byteLength(toolResponse, 'utf-8') > MAX_TOOL_RESPONSE_BYTES) {
        originalBytes = Buffer.byteLength(toolResponse, 'utf-8');
        truncationField = payload.output !== undefined ? 'raw.output' : 'raw.tool_response';
      }

      const raw = originalBytes > 0 ? truncateRawPayload(payload) : payload;

      if (truncationField) {
        const storedStr = (raw.output ?? raw.tool_response ?? '') as string;
        storedBytes = Buffer.byteLength(storedStr, 'utf-8');
      }

      let command: string | null = null;
      let target: string | null = null;
      const args = payload.args ?? payload.tool_input ?? null;
      if (args && typeof args === 'object') {
        command = (args as Record<string, unknown>).command as string | null ?? null;
        target = (args as Record<string, unknown>).filePath as string | null
          ?? (args as Record<string, unknown>).file_path as string | null
          ?? null;
      }

      const normalized: Record<string, unknown> = {
        tool_name: toolName,
        tool_use_id: toolUseId,
        turn_id: turnId,
        command,
        target,
        status,
        exit_code: exitCode,
      };

      if (truncationField) {
        normalized.truncation = {
          field: truncationField,
          stored_bytes: storedBytes,
          original_bytes: originalBytes,
        };
      }

      const envelope = createEnvelope({
        source_agent: 'codex',
        source_event: eventName,
        raw,
        normalized,
        session_id: (payload.sessionID ?? payload.session_id) as string | null,
        turn_id: turnId,
        cwd,
        transcript_path: payload.transcript_path as string | null,
        skip_raw_truncation: originalBytes > 0,
        truncation: truncationField ? {
          field: truncationField,
          stored_bytes: storedBytes,
          original_bytes: originalBytes,
        } : null,
      });

      writeToBuffer(envelope);
    }

    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

main();
