import * as fs from 'fs';

/**
 * Cleanly and synchronously reads all inputs from stdin.
 * Uses fs.readFileSync(0, 'utf-8') for maximum speed on the hot path.
 */
export function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch (error) {
    // Gracefully handle missing/closed stdin by returning empty string
    return '';
  }
}
