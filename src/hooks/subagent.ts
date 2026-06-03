import { readStdinSync } from './utils/stdin.js';
import { writeToBuffer } from './utils/buffer-writer.js';
import { createEnvelope } from './utils/envelope.js';

function main() {
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
    const eventName = isStart ? 'SubagentStart' : 'SubagentStop';

    const normalized: Record<string, unknown> = {
      subagent_id: payload.subagent_id ?? null,
      parent_turn_id: payload.parent_turn_id ?? payload.turn_id ?? null,
      agent_type: payload.agent_type ?? null,
    };

    const envelope = createEnvelope({
      source_agent: 'codex',
      source_event: eventName,
      raw: payload,
      normalized,
      session_id: (payload.sessionID ?? payload.session_id) as string | null,
      turn_id: (payload.turn_id ?? null) as string | null,
      cwd,
      transcript_path: payload.transcript_path as string | null,
    });

    writeToBuffer(envelope);
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

main();
