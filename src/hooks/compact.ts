import { readStdinSync } from './utils/stdin.js';
import { writeToBuffer } from './utils/buffer-writer.js';
import { createEnvelope } from './utils/envelope.js';

function main() {
  try {
    const isPre = process.argv.includes('--pre');
    const isPost = process.argv.includes('--post');

    if (!isPre && !isPost) {
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
    const turnId = (payload.turn_id ?? null) as string | null;
    const eventName = isPre ? 'PreCompact' : 'PostCompact';

    const normalized: Record<string, unknown> = {
      turn_id: turnId,
      reason: payload.reason ?? null,
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
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

main();
