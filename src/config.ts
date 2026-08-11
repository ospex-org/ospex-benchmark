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

/**
 * The protocol deployment these runs are measured against.
 *
 * Required and non-empty on every projected run, and part of the composite
 * foreign key a decision uses to reach its provider call — so it is a frozen
 * literal rather than an environment read. A variable mis-set halfway through a
 * slate would make every subsequent seal fail that key, and the publisher is
 * fail-soft, so the loss would be silent.
 *
 * It is also the only thing that separates two rounds' data: R5 restarted the
 * contest-id counter, so a contest id is not comparable across rounds and this
 * label is what says which deployment a row belongs to.
 *
 * ⚠ An R6 redeploy must change this deliberately. A test pins the literal so
 *   the change is a decision someone makes, not one that drifts in.
 */
export const DEPLOYMENT_ROUND = 'R5';

// Every credential this process can hold. A new one belongs here BEFORE the code
// that uses it: redactSecrets() knows nothing it is not told, so an unenrolled
// value passes through error messages and records verbatim.
const SECRET_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'SUPABASE_ANON_KEY',
  // The serving publisher's database credentials. Enrolled because that
  // publisher writes to Postgres directly and so does not pass through
  // writeNdjson(), which redacts every line it emits. BOTH shapes are listed:
  // the DSN takes precedence over the bare password, so a host configured that
  // way sets no BENCHMARK_WRITER at all and enrolling only the password would
  // leave redaction a no-op for everything the publisher touches.
  //
  // Note the bound: this is exact-value substitution, so it catches a whole DSN
  // echoed into a message, not the password alone lifted out of one. The
  // resolver deliberately never parses the DSN, so there is no parsed password
  // to enrol.
  'BENCHMARK_WRITER',
  'BENCHMARK_DB_URL',
  // The campaign store's connection string, which carries that database's
  // password in its userinfo. Enrolled for the same reason as the two above:
  // the store path builds a driver config from it and reports driver errors,
  // and an unenrolled value passes through those messages verbatim.
  'STORE_DATABASE_URL',
] as const;

export function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The Gemini credential; both common variable names are accepted. */
export function googleApiKey(): string | undefined {
  return envValue('GEMINI_API_KEY') ?? envValue('GOOGLE_API_KEY');
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

/**
 * Redaction ALWAYS precedes truncation: truncating first can split a
 * credential at the boundary, leaving a prefix the full-value redactor can
 * no longer recognize. Every truncated provider-derived string goes through
 * this helper.
 */
export function redactAndTruncate(text: string, limit: number): string {
  return redactSecrets(text).slice(0, limit);
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
