import { redactSecrets } from './config.js';

/**
 * Console chokepoint: every dynamic line the harness prints goes through
 * secret redaction, exactly like the NDJSON/summary write chokepoint —
 * provider-derived content (reported model IDs, response IDs, error
 * messages, identity failures) included.
 */
export function printLine(line: string): void {
  console.log(redactSecrets(line));
}

export function printError(line: string): void {
  console.error(redactSecrets(line));
}
