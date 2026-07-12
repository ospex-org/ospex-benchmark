import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader (no dependency): reads a local gitignored `.env` from
 * the working directory when present. Real environment variables always win —
 * a value is only set when the variable is currently unset. Returns the NAMES
 * of the variables it loaded (never values), for a safe log line.
 */
export function loadDotEnv(dir: string = process.cwd()): string[] {
  const path = resolve(dir, '.env');
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value !== '' && process.env[key] === undefined) {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
