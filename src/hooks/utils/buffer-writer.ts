import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Resolves the path of the telemetry-buffer.jsonl file.
 * Must resolve path ~/.local/share/codex/telemetry-buffer.jsonl.
 * Cross-platform, fallback to %APPDATA% on Windows.
 * Supports CODEX_TELEMETRY_BUFFER_PATH environment variable override for testing.
 */
export function getBufferPath(): string {
  if (process.env.CODEX_TELEMETRY_BUFFER_PATH) {
    return path.resolve(process.env.CODEX_TELEMETRY_BUFFER_PATH);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'codex', 'telemetry-buffer.jsonl');
  } else {
    const home = os.homedir();
    return path.join(home, '.local', 'share', 'codex', 'telemetry-buffer.jsonl');
  }
}

/**
 * Appends the stringified payload + '\n' atomically using the O_APPEND file-system flag.
 * Wraps everything in try...catch so that if directory creation or file writing fails,
 * it does NOT throw.
 */
export function writeToBuffer(payload: unknown): void {
  try {
    const bufferPath = getBufferPath();
    const dir = path.dirname(bufferPath);

    // Recursively create directory
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(payload) + '\n';
    
    // Append atomically with O_APPEND flag 'a'
    fs.appendFileSync(bufferPath, line, { flag: 'a', encoding: 'utf-8' });
  } catch (error) {
    // Suppress errors as per fail-safe requirements
  }
}
