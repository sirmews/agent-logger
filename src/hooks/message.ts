import { readStdinSync } from './utils/stdin.js';
import { writeToBuffer } from './utils/buffer-writer.js';

function main() {
  try {
    const isPrompt = process.argv.includes('--prompt');

    if (!isPrompt) {
      console.log(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const stdinText = readStdinSync().trim();
    let payload: any = {};
    if (stdinText) {
      try {
        payload = JSON.parse(stdinText);
      } catch (e) {
        payload = { rawStdin: stdinText };
      }
    }

    const eventName = 'UserPromptSubmit';
    
    // Add event name and local timestamp
    const record = {
      ...payload,
      event: eventName,
      localTimestamp: Date.now()
    };

    writeToBuffer(record);

    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  } catch (err) {
    // Top-level catch to ensure zero-latency/fail-safe operation
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
}

main();
