/**
 * Environment access and credential redaction.
 *
 * This repo is public: credentials come from environment variables only, and
 * every string that could reach a log, record, or error message passes
 * through redactSecrets() first.
 */

export const DEFAULT_OSPEX_API_URL = 'https://ospex-core-api-195f635df864.herokuapp.com';

/** All markets/games are Polygon-mainnet-scoped rows upstream. */
export const NETWORK = 'polygon';

const SECRET_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'SUPABASE_ANON_KEY',
] as const;

export function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function presentSecretValues(): string[] {
  const values: string[] = [];
  for (const name of SECRET_ENV_VARS) {
    const value = envValue(name);
    if (value !== undefined && value.length >= 8) values.push(value);
  }
  return values;
}

/**
 * Replace any occurrence of a configured credential value with [REDACTED].
 * Applied to raw provider responses, error messages, and stack traces before
 * they are recorded or printed.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const secret of presentSecretValues()) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(`${error.name}: ${error.message}`);
  }
  return redactSecrets(String(error));
}

export function describeErrorWithStack(error: unknown): string {
  if (error instanceof Error && typeof error.stack === 'string') {
    return redactSecrets(error.stack);
  }
  return describeError(error);
}
