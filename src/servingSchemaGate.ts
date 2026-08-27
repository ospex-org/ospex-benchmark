import { pathToFileURL } from 'node:url';
import {
  SCORES_SERVING_CAPABILITY,
  SERVING_POOL_MAX,
  servingPoolConfig,
} from './benchmarkServingClient.js';
import { resolveBenchmarkWriterConnection } from './benchmarkServingConfig.js';
import { describeError, describeErrorWithStack } from './config.js';
import { printError, printLine } from './console.js';
import { dsnFacts, isLocalHost } from './dsnFacts.js';
import { loadDotEnv } from './env.js';
import { SERVING_STATEMENTS, SERVING_TABLES } from './servingStore.js';
import type { BenchmarkWriterConnection } from './benchmarkServingConfig.js';

/**
 * Ask a LIVE database whether it can hold this publisher's writes — before one
 * is sent.
 *
 * ── WHY A SEPARATE COMMAND, AND WHY IT GATES NOTHING AUTOMATICALLY ───────────
 * The publisher already refuses to write against a schema that does not report
 * the capability it needs, and that refusal is fail-SOFT by design: a benchmark
 * night must never be lost to a database. Fail-soft means quiet, and quiet is
 * the wrong mode for the one moment that matters — an operator pointing this at
 * a real database for the first time. Every row the projection writes is
 * insert-once with no UPDATE grant, so a schema that is subtly wrong does not
 * produce a fixable mistake, it produces a permanent one.
 *
 * So this is the loud version: run by hand, once, before the credential goes in.
 * It is deliberately NOT called from `yarn watch`, `yarn smoke` or `yarn
 * project`, and it must not become so. A preflight that can fail for its own
 * reasons has no business standing between a slate and a fire.
 *
 * ── IT CANNOT WRITE, AND THE SERVER IS WHAT ENFORCES THAT ────────────────────
 * The connection requests `default_transaction_read_only=on` as a startup
 * parameter, then explicitly SETs the same GUC after checking out the one client
 * this gate holds. PostgreSQL then refuses any write with 25006. That is PROVEN
 * rather than assumed — a pooler is free to drop a startup option, and a gate
 * that believed its own configuration would be exactly as safe as no gate.
 * Before any check runs, the connection must demonstrate the refusal, using a
 * statement that is a no-op even if it executes (measured: on a writable
 * connection the same statement reports `INSERT 0` and the row count does not
 * move). The check that a write is refused cannot itself be the write that gets
 * through.
 *
 * As a second, independent proof, the row counts are read at the start and again
 * at the end and must be identical. Nothing the gate did may have moved them.
 *
 * ── EVERY QUESTION IS PUT TO THE DATABASE, NOT TO A MODEL OF IT ──────────────
 * The publisher's statements are handed to the server's own planner; privileges
 * are read with `has_table_privilege`, the function the executor itself
 * consults; the entrant index is read out of `pg_index` rather than
 * reconstructed. A second definition of the schema kept in this repo would be a
 * second thing to drift, and it would drift in the direction of agreeing with
 * itself.
 */

/** Startup defence in depth. A pooler may drop it; the explicit SET and probe
 * below are the authoritative guard. */
export const READ_ONLY_STARTUP_OPTION = '-c default_transaction_read_only=on';

/** Applied to the checked-out client before any probe or schema question. */
export const READ_ONLY_SESSION_SQL = 'set default_transaction_read_only = on';

/**
 * The startup parameter that PINS the schema search path to `public`.
 *
 * Why the gate needs it, and why only after the identity-args change: the
 * definer census renders each function's arguments with
 * `pg_get_function_identity_arguments`, and PostgreSQL renders a type name
 * SCHEMA-QUALIFIED (`public.network`) exactly when that schema is not on the
 * session search path, BARE (`network`) when it is. The declared exemptions
 * were captured with `public` on the path and use the bare spellings, so a
 * connection whose role or database default excludes `public` — e.g. an
 * `ALTER ROLE … SET search_path = ''` hardening — would render the protocol's
 * twelve custom-typed RPCs as `public.network`, match none of them, and turn
 * a healthy database RED on its own functions. The old name-only census had
 * no type names in it and so no such coupling; this pin removes the coupling
 * the identity-args form introduced. It also makes the emission deterministic
 * for the conformance suite, which proves the pin holds under a hostile
 * `search_path`.
 *
 * `pg_catalog` is always searched ahead of this whether or not it is named, so
 * the built-in types (`bigint`, `jsonb`, `timestamp with time zone`, …) render
 * bare regardless; naming only `public` is what the exemption spellings need.
 * It is a GUC set at connection time, not a statement, so it is issued under
 * the read-only option without contradiction.
 */
export const SEARCH_PATH_STARTUP_OPTION = '-c search_path=public';

/** Every startup option the gate connection carries, in one place so the
 *  conformance suite can open a connection with EXACTLY these. */
export const GATE_STARTUP_OPTIONS = `${READ_ONLY_STARTUP_OPTION} ${SEARCH_PATH_STARTUP_OPTION}`;

/**
 * The statement that proves the refusal is real.
 *
 * `where false` is what makes it safe to point at a real database: if the
 * read-only setting somehow did not take effect, this executes and inserts
 * nothing. Measured on PostgreSQL 17 both ways — 25006 on the read-only
 * connection, `INSERT 0` with an unchanged row count on a writable one.
 */
const REFUSAL_PROBE =
  "insert into public.benchmark_runs (cohort_id) select 'serving-schema-gate' where false";

const READ_ONLY_SQLSTATE = '25006';

/**
 * Below this, several checks would ERROR rather than fail.
 *
 * `NULLS NOT DISTINCT` is PostgreSQL 15, and so is the catalog column that
 * reports it. On 14 the entrant index cannot exist in the form the identity
 * contract requires, so this is a floor on the schema as much as on the gate.
 */
const MINIMUM_SERVER_VERSION_NUM = 150000;
/** `EXPLAIN (GENERIC_PLAN)` — the strongest form of the statement check. */
const GENERIC_PLAN_VERSION_NUM = 160000;

export interface GateQuery {
  (sql: string, params?: readonly unknown[]): Promise<ReadonlyArray<Record<string, unknown>>>;
}

export interface GateVerdict {
  readonly ok: boolean;
  readonly detail: string;
}

export interface GateCheck {
  readonly name: string;
  /**
   * Reported, never decisive.
   *
   * An informational check exists so an operator SEES a number they should look
   * at, without that number becoming a condition the command refuses on.
   * Reporting a fact and refusing to proceed are different jobs, and a row count
   * is a fact about history rather than a fault.
   */
  readonly informational?: boolean;
  run(query: GateQuery): Promise<GateVerdict>;
}

export interface GateFinding extends GateVerdict {
  readonly name: string;
  readonly informational: boolean;
}

/** The SQLSTATE of a driver error, when it carries one. */
function sqlstate(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** Collapse whitespace, so a definition that wraps differently still matches. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// The read-only precondition, and the bookend that confirms it held
// ---------------------------------------------------------------------------

/**
 * Prove the connection refuses writes, or refuse to use it.
 *
 * Measured rather than inferred from the startup option or explicit SET: either
 * can be acknowledged or dropped by connection infrastructure, while this
 * reports what the server DOES on the checked-out client.
 */
export async function proveReadOnly(query: GateQuery): Promise<GateVerdict> {
  try {
    await query(REFUSAL_PROBE);
  } catch (error) {
    const code = sqlstate(error);
    if (code === READ_ONLY_SQLSTATE) {
      return { ok: true, detail: `the server refuses writes on this connection (${READ_ONLY_SQLSTATE})` };
    }
    // Any other refusal leaves the question unanswered. A missing table or a
    // missing grant says nothing about whether a write would be allowed.
    return {
      ok: false,
      detail:
        'could not prove this connection is read-only: the probe failed with ' +
        `${code ?? 'no SQLSTATE'} instead of ${READ_ONLY_SQLSTATE} (${describeError(error)})`,
    };
  }
  return {
    ok: false,
    detail:
      'this connection ACCEPTED a write. The read-only startup option did not take effect — ' +
      'a pooler may have dropped it. Refusing to continue: a preflight that can write is not ' +
      'a preflight.',
  };
}

/**
 * Confirm the password did not cross a wire in the clear.
 *
 * A property of the CONNECTION rather than of the schema, which is why it sits
 * here beside the read-only proof instead of among the checks.
 *
 * ⚠ WHETHER THE TARGET IS LOCAL IS A CLIENT-SIDE QUESTION AND THE SERVER CANNOT
 *   ANSWER IT. The obvious source, `pg_stat_activity.client_addr`, reports what
 *   the SERVER sees — and a container with a published port sees the runtime's
 *   NAT gateway, not loopback. Measured: dialling localhost:5436 against a
 *   Docker PostgreSQL presents as 172.x, so a gate reading `client_addr`
 *   declares a connection that never left the machine to be remote and
 *   unencrypted. `isLocalHost` answers the question that was actually asked —
 *   which host did this process dial — and it is the reviewed implementation,
 *   loopback by address rather than by string prefix.
 */
export function proveEncrypted(session: {
  readonly ssl: unknown;
  readonly version: unknown;
}, localTarget: boolean): GateVerdict {
  if (session.ssl === true) return { ok: true, detail: `TLS ${String(session.version)}` };
  if (localTarget) {
    return { ok: true, detail: 'not encrypted, and the target is this machine — nothing reaches a wire' };
  }
  return {
    ok: false,
    detail:
      'this session is NOT encrypted and the target is not this machine. The connection ' +
      "string carries this role's password, so it went out in the clear.",
  };
}

/** What the server reports about the current session's transport. */
export async function readSession(query: GateQuery): Promise<{ ssl: unknown; version: unknown }> {
  const rows = await query('select ssl, version from pg_stat_ssl where pid = pg_backend_pid()');
  return { ssl: rows[0]?.['ssl'], version: rows[0]?.['version'] };
}

/** Row counts for every projection table, as `name=n` pairs. */
export async function readRowCounts(query: GateQuery): Promise<string> {
  const rows = await query(
    `select t as name,
            (xpath('/row/c/text()',
                   query_to_xml(format('select count(*) as c from public.%I', t),
                                false, true, '')))[1]::text::bigint as n
       from unnest($1::text[]) as t`,
    [[...SERVING_TABLES]],
  );
  return rows.map((row) => `${String(row['name'])}=${String(row['n'])}`).join(' ');
}

// ---------------------------------------------------------------------------
// What the schema has to be
// ---------------------------------------------------------------------------

/**
 * The capability table is the odd one out, deliberately: it is the schema's
 * claim about what it can hold, and a publisher able to write that claim would
 * be authorising its own writes. Its absent INSERT is an assertion here, not an
 * omission.
 */
const CAPABILITY_TABLE = 'benchmark_schema_capability';
const needsInsert = (table: string): boolean => table !== CAPABILITY_TABLE;

/**
 * The relations indexer migration 079 adds to this role's grid: SELECT+INSERT,
 * RLS with the same two role-scoped policies as the rest of the projection.
 *
 * They are NOT in SERVING_TABLES, and that is the point of the separate name:
 * that list lives beside the statements that write it, and nothing in this
 * repo writes these three — an operator-side publisher does. What they are to
 * this gate is grid, not write surface.
 */
export const EXECUTION_SURFACE_TABLES: readonly string[] = Object.freeze([
  'benchmark_cohort_wallets',
  'benchmark_execution_fills',
  'benchmark_site_stats',
]);

/**
 * The capability at which the schema HOLDS those three. Deliberately not a
 * requirement and deliberately not SCORES_SERVING_CAPABILITY: this build
 * writes none of them, so a database at 3 is perfectly fine for everything
 * this repo does, and raising the required version would fail-soft-HOLD every
 * scores publication over a migration it never touches.
 */
const EXECUTION_SURFACE_CAPABILITY = 4;

/**
 * Every relation this role's grid must cover, at the capability the schema
 * REPORTS — so one build reads a pre-079 and a post-079 database correctly.
 *
 * ⚠ THE SET CANNOT BE A CONSTANT, and the reason is a Postgres detail rather
 *   than a preference. `has_table_privilege('public.' || t, …)` casts its
 *   argument to regclass, so a name that does not exist raises 42P01 and takes
 *   the whole statement with it — it does not answer false. Adding the three
 *   unconditionally therefore does not merely over-state the surface against a
 *   pre-079 database; it aborts the privilege grid, the browser-key check and
 *   the row-count bookend, and the gate reports three failures that have
 *   nothing to do with the schema in front of it.
 *
 * An unreadable capability row resolves to the NARROW set, which is the
 * fail-safe direction: on a post-079 database the reach check then reports the
 * three as unexpected rather than certifying a grid it could not size, and the
 * capability check above says why in its own line.
 */
async function projectionTables(query: GateQuery): Promise<readonly string[]> {
  let version = 0;
  try {
    const rows = await query(
      `select version from public.${CAPABILITY_TABLE} where capability = $1`,
      ['serving_projection'],
    );
    const answered = rows[0]?.['version'];
    if (typeof answered === 'number' && Number.isInteger(answered)) version = answered;
  } catch {
    // Unreadable is version 0 — see above.
  }
  return version >= EXECUTION_SURFACE_CAPABILITY
    ? [...SERVING_TABLES, ...EXECUTION_SURFACE_TABLES]
    : SERVING_TABLES;
}

/** Verbs no projection writer may hold on any of these tables, ever. */
const FORBIDDEN_VERBS = ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

/**
 * The entrant index, as the identity contract needs it.
 *
 * Three properties, each load-bearing and each failing silently:
 *   - unique, or two rows hold one competitor's identity;
 *   - NULLS NOT DISTINCT, or a model with no lab stops colliding with itself and
 *     the same entrant is admitted twice;
 *   - PARTIAL on models, or the eight deterministic controls — every one of
 *     which declares (null, null, null) — collide with each other, and a
 *     fail-soft publisher turns that into seven missing rows and no error.
 */
const ENTRANT_COLUMNS = ['lab_id', 'model_id', 'configuration'] as const;
const ENTRANT_PREDICATE = "(kind = 'model'::text)";

/**
 * The constraints that make a participant an entrant, listed by the invariant
 * each encodes.
 *
 * Compared against `pg_get_constraintdef`, PostgreSQL's own canonical rendering
 * of the expression it stored — the closest a read-only check gets to
 * evaluating it. That is a text comparison and the bound is worth stating: a
 * failure here means read the definitions the gate prints beside it, which may
 * be an equivalent expression rather than a broken one.
 *
 * Note the asymmetry, which is the schema's intent rather than an oversight:
 * `lab_id` is NOT among the four a model must declare — a self-hosted model
 * legitimately has no lab — only a non-model may not carry one.
 */
const ENTRANT_CONSTRAINTS: ReadonlyArray<{ invariant: string; definition: string }> = [
  {
    invariant: 'a model declares all four identity columns',
    definition:
      "CHECK (((kind <> 'model'::text) OR (num_nonnulls(model_id, configuration, " +
      'configuration_sha256, configuration_digest_version) = 4)))',
  },
  {
    invariant: 'anything that is not a model declares none of them',
    definition:
      "CHECK (((kind = 'model'::text) OR (num_nonnulls(model_id, configuration, " +
      'configuration_sha256, configuration_digest_version) = 0)))',
  },
  {
    invariant: 'only a model carries a lab',
    definition: "CHECK (((kind = 'model'::text) OR (lab_id IS NULL)))",
  },
];

/**
 * The scales the reveal's numbers are stored at.
 *
 * The seal's forecast digest is taken over values ALREADY quantised to these
 * scales, so that a reveal can be checked against the commitment it belongs to.
 * If a scale moves, PostgreSQL rounds on the way in, the recomputed digest stops
 * matching, and nothing anywhere reports it — every published commitment becomes
 * unverifiable at once. It is the quietest way this schema can break, which is
 * why it is checked despite no statement naming a scale.
 */
const REVEAL_SCALES: Readonly<Record<string, readonly [precision: number, scale: number]>> = {
  confidence: [9, 8],
  line: [10, 4],
  observed_decimal: [12, 6],
  prob_loss: [9, 8],
  prob_push: [9, 8],
  prob_win: [9, 8],
};

/** Roles that must not reach the projection at all. Browser-reachable keys
 *  resolve to the first two; the third additionally holds BYPASSRLS, so for it
 *  the privilege grid is the only gate there is. */
const FORBIDDEN_READERS = ['anon', 'authenticated', 'openclaw_readonly'] as const;
/** The public read API's own role: it may read the projection, and it must not
 *  be able to reach the model-authored prose. */
const READ_API_ROLE = 'service_role';
const WITHHELD_TABLE = 'benchmark_decision_rationales';


/** Every table privilege PostgreSQL can grant. Used wherever the claim is "no
 *  privilege of any kind", so a verb cannot be forgotten out of the question. */
const ALL_VERBS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
] as const;

/** The row counts, or null when they could not be read. Never throws. */
async function countsOrNull(query: GateQuery): Promise<string | null> {
  try {
    return await readRowCounts(query);
  } catch {
    return null;
  }
}

/**
 * SECURITY DEFINER grants decided SAFE, deliberately, once — the branch the
 * definer check's own failure text offers, taken here in reviewed code
 * instead of re-argued in chat on every preflight.
 *
 * Every entry is `role -> schema.function(identity arguments)`, EXACT, where
 * the argument list is `pg_get_function_identity_arguments` verbatim: no
 * wildcard admits a function nobody has looked at, and a protocol refactor
 * that renames one makes the stale entry a visible pruning note rather than a
 * silent widening. The arguments are part of the identity because PostgreSQL
 * overloads are SEPARATE functions — a name-only entry would silently exempt
 * every overload anyone ever creates under that name (measured: an undeclared
 * `rpc_active_recovery_run(hostile text)` passed a name-keyed build of this
 * check). The same property makes an ALTERed signature fail closed: the old
 * entry turns into a pruning note and the new signature arrives as a
 * violation until someone re-reviews and re-declares it.
 *
 * Why these are safe, and the shape any future entry must argue in its own
 * comment: they are the indexer/read-API's OWN write path — the RPCs that
 * mirror public on-chain events into the protocol tables, plus two trigger
 * functions on `games` — owned by the schema owner and granted to
 * `service_role`, the backend's key. None of them reads or writes any
 * `benchmark_*` relation, so none is a path around the projection grid in
 * either direction; and `service_role` is never handed to a browser. The
 * roles this check exists to keep OUT of definer functions — the writer, and
 * every browser-facing or readonly key — have no exemptions and may never
 * gain one: `servingSchemaGate.test.ts` refuses any entry for them by
 * construction.
 *
 * First measured against the live project 2026-08-21, immediately after the
 * scores-capability migration: these eighteen were the whole list, none of
 * their names carried a second overload, the writer and browser keys held
 * EXECUTE on none, and run-path publication had already been operating under
 * exactly this posture since 2026-08-15. The signatures below are the live
 * catalog's own `pg_get_function_identity_arguments` output, read that day.
 */
export const DECLARED_DEFINER_EXEMPTIONS: ReadonlySet<string> = new Set([
  'service_role -> public.rpc_active_recovery_run(p_network network)',
  'service_role -> public.rpc_backfill_range(p_network text, p_from_block bigint, p_to_block bigint, p_fresh_events jsonb)',
  'service_role -> public.rpc_commitment_matched(p_network network, p_speculation_id bigint, p_contest_id bigint, p_commitment_hash text, p_maker_address text, p_taker_address text, p_maker_position_type position_type, p_taker_position_type position_type, p_maker_risk_amount numeric, p_taker_risk_amount numeric, p_odds_tick smallint, p_block_time timestamp with time zone, p_tx_hash text, p_log_index integer, p_source_block bigint, p_commitment_risk_amount numeric, p_nonce numeric, p_expiry timestamp with time zone, p_speculation_key text)',
  'service_role -> public.rpc_leaderboard_funded(p_network network, p_leaderboard_id bigint, p_amount numeric, p_funder text, p_tx_hash text, p_log_index integer, p_block_number bigint, p_block_time timestamp with time zone, p_source_block bigint)',
  'service_role -> public.rpc_leaderboard_new_highest_roi(p_network network, p_leaderboard_id bigint, p_new_highest_roi numeric, p_winner_address text, p_block_time timestamp with time zone, p_source_block bigint)',
  'service_role -> public.rpc_leaderboard_position_added(p_network network, p_leaderboard_id bigint, p_speculation_id bigint, p_user_address text, p_position_type position_type, p_contest_id bigint, p_risk_amount numeric, p_profit_amount numeric, p_block_time timestamp with time zone, p_source_block bigint)',
  'service_role -> public.rpc_leaderboard_prize_claimed(p_network network, p_leaderboard_id bigint, p_user_address text, p_share numeric, p_block_time timestamp with time zone, p_tx_hash text, p_log_index integer)',
  'service_role -> public.rpc_position_fill_upsert(p_network network, p_speculation_id bigint, p_contest_id bigint, p_commitment_hash text, p_maker_address text, p_taker_address text, p_maker_position_type position_type, p_taker_position_type position_type, p_maker_risk_amount numeric, p_taker_risk_amount numeric, p_odds_tick smallint, p_block_time timestamp with time zone, p_tx_hash text, p_log_index integer, p_source_block bigint)',
  'service_role -> public.rpc_position_matched_pair(p_network network, p_speculation_id bigint, p_maker_address text, p_taker_address text, p_maker_pt position_type, p_taker_pt position_type, p_maker_risk numeric, p_taker_risk numeric, p_block_time timestamp with time zone, p_source_block bigint, p_tx_hash text, p_log_index integer)',
  'service_role -> public.rpc_position_sold(p_network network, p_speculation_id bigint, p_seller text, p_position_type position_type, p_risk_amount numeric, p_profit_amount numeric, p_purchase_price numeric, p_block_time timestamp with time zone, p_tx_hash text, p_log_index integer)',
  'service_role -> public.rpc_position_transferred(p_network network, p_speculation_id bigint, p_from_address text, p_to_address text, p_position_type position_type, p_risk_amount numeric, p_profit_amount numeric, p_block_time timestamp with time zone, p_source_block bigint, p_tx_hash text, p_log_index integer)',
  'service_role -> public.rpc_recovery_run_complete(p_id bigint)',
  'service_role -> public.rpc_recovery_run_fail(p_id bigint, p_phase text, p_error text)',
  'service_role -> public.rpc_recovery_run_phase(p_id bigint, p_phase text)',
  'service_role -> public.rpc_recovery_run_start(p_network network, p_kind text, p_from_block bigint, p_to_block bigint, p_fork_point bigint, p_plan jsonb)',
  'service_role -> public.rpc_user_registered(p_network network, p_leaderboard_id bigint, p_user_address text, p_declared_bankroll numeric, p_block_time timestamp with time zone, p_source_block bigint)',
  'service_role -> public.tg_games_maintain_earliest_match_time()',
  'service_role -> public.tg_games_touch_contest_on_match_time()',
]);

/** The one place membership is decided, on the FULL `role -> function` pair
 *  where `fn` carries the routine's whole identity, `schema.name(identity
 *  arguments)` — extracted so a test can hold it to exactly that and nothing
 *  looser (a role-only, name-only or prefix match would exempt functions
 *  nobody has looked at, name-only via any overload of a declared name). */
export function isExemptDefiner(role: string, fn: string): boolean {
  return DECLARED_DEFINER_EXEMPTIONS.has(`${role} -> ${fn}`);
}

export const SERVING_SCHEMA_CHECKS: readonly GateCheck[] = [
  {
    name: 'the server is new enough for the identity contract',
    async run(query) {
      const rows = await query("select current_setting('server_version_num')::int as v");
      const version = Number(rows[0]?.['v']);
      if (!Number.isInteger(version)) return { ok: false, detail: 'the server did not report a version' };
      return {
        ok: version >= MINIMUM_SERVER_VERSION_NUM,
        detail:
          `server_version_num ${version}` +
          (version >= MINIMUM_SERVER_VERSION_NUM
            ? ''
            : ` — below ${MINIMUM_SERVER_VERSION_NUM}, where NULLS NOT DISTINCT does not exist, ` +
              'so the entrant index cannot hold the form the identity contract requires'),
      };
    },
  },

  {
    name: 'the connected role is scoped, not privileged',
    async run(query) {
      const rows = await query(
        `select rolname, rolcanlogin, rolsuper, rolbypassrls, rolreplication, rolcreaterole,
                rolconnlimit,
                (rolvaliduntil is not null and rolvaliduntil < now()) as expired
           from pg_roles where rolname = current_user`,
      );
      const row = rows[0];
      if (row === undefined) return { ok: false, detail: 'the current role is not in pg_roles' };
      const faults: string[] = [];
      if (row['rolcanlogin'] !== true) faults.push('cannot log in');
      // A superuser bypasses every grant, so every privilege check below would
      // pass by bypass rather than by grant — and the publisher would in fact
      // hold UPDATE and DELETE on rows the design says can never be altered.
      if (row['rolsuper'] !== false) faults.push('is a SUPERUSER, which makes every privilege check below vacuous');
      if (row['rolbypassrls'] !== false) faults.push('holds BYPASSRLS');
      if (row['rolreplication'] !== false) faults.push('holds REPLICATION, which reads protocol writes over an ordinary connection');
      if (row['rolcreaterole'] !== false) faults.push('holds CREATEROLE');
      if (row['expired'] === true) faults.push('the password has expired, which looks identical to a wrong credential');
      const limit = Number(row['rolconnlimit']);
      // Past the role's limit PostgreSQL answers 53300 instead of writing, which
      // the publisher classifies as `unavailable` and, being fail-soft, drops.
      if (limit !== -1 && limit < SERVING_POOL_MAX) {
        faults.push(`CONNECTION LIMIT ${limit} is below the publisher's pool maximum of ${SERVING_POOL_MAX}`);
      }
      return faults.length === 0
        ? { ok: true, detail: `${String(row['rolname'])}: login only, no bypass, connection limit ${limit === -1 ? 'unlimited' : limit}` }
        : { ok: false, detail: `${String(row['rolname'])} ${faults.join('; ')}` };
    },
  },

  {
    name: 'the connected role inherits nothing',
    async run(query) {
      // The one hole no privilege probe can see: a NOINHERIT member reports
      // FALSE for every table privilege above and can still SET ROLE into the
      // whole protocol schema.
      const rows = await query(
        `select r.rolname as held from pg_auth_members m
           join pg_roles r on r.oid = m.roleid
          where m.member = (select oid from pg_roles where rolname = current_user)`,
      );
      return rows.length === 0
        ? { ok: true, detail: 'the role is a member of nothing, so no grant boundary can be stepped around' }
        : {
            ok: false,
            detail:
              `the role is a member of ${rows.map((row) => String(row['held'])).join(', ')} — ` +
              'membership is an escape from every privilege check here, including a NOINHERIT one',
          };
    },
  },

  {
    // The gate preflights the WHOLE write surface — the scores statement
    // included — so it asks for the highest capability any of this build's
    // publishers needs. The run paths themselves still open at the lower
    // REQUIRED_SERVING_CAPABILITY: a schema this check fails can be fine for a
    // watch night, and the statement-planning check below says which half is
    // affected.
    name: `the schema reports serving_projection capability ${SCORES_SERVING_CAPABILITY} or higher`,
    async run(query) {
      const rows = await query(
        `select version from public.${CAPABILITY_TABLE} where capability = $1`,
        ['serving_projection'],
      );
      if (rows.length > 1) {
        return { ok: false, detail: `${rows.length} rows for serving_projection — "the version" is ambiguous` };
      }
      const version = rows[0]?.['version'];
      if (typeof version !== 'number' || !Number.isInteger(version)) {
        return {
          ok: false,
          detail:
            'no capability row. The publisher reads absence as version 0 and writes nothing, ' +
            'so this is what an unmigrated database looks like from here.',
        };
      }
      return {
        ok: version >= SCORES_SERVING_CAPABILITY,
        detail: `serving_projection = ${version} (this build requires ${SCORES_SERVING_CAPABILITY})`,
      };
    },
  },

  {
    name: 'every statement the publisher will run is valid against this schema',
    async run(query) {
      // Handed to the server's own planner. This is the one check that covers
      // the whole write surface at once, because it IS the write surface: a
      // renamed column, a dropped relation, a drifted type, a missing ON
      // CONFLICT constraint all fail here rather than at four in the morning,
      // one row at a time, into a fail-soft log.
      //
      // EXPLAIN (GENERIC_PLAN) is preferred over PREPARE because it PLANS as
      // well as parses, and arbiter inference happens in the planner. Measured:
      // an `on conflict (col)` with no matching unique index PREPAREs cleanly
      // and fails GENERIC_PLAN with 42P10. Neither executes, which is what makes
      // this askable of a live database — verified by the row-count bookend.
      const versionRows = await query("select current_setting('server_version_num')::int as v");
      const generic = Number(versionRows[0]?.['v']) >= GENERIC_PLAN_VERSION_NUM;
      const broken: string[] = [];
      let index = 0;
      for (const [name, sql] of Object.entries(SERVING_STATEMENTS)) {
        index += 1;
        try {
          await query(generic ? `explain (generic_plan) ${sql}` : `prepare serving_gate_${index} as ${sql}`);
        } catch (error) {
          broken.push(`${name}: ${sqlstate(error) ?? '?'} ${describeError(error)}`);
        }
      }
      const total = Object.keys(SERVING_STATEMENTS).length;
      // The bound is stated rather than implied: on a pre-16 server the fallback
      // parses but does not plan, so a missing ON CONFLICT arbiter would not be
      // caught here.
      const how = generic
        ? 'planned (EXPLAIN GENERIC_PLAN, so ON CONFLICT arbiters are covered)'
        : 'parsed only (PREPARE — this server predates GENERIC_PLAN, so a missing ON CONFLICT arbiter would NOT be caught)';
      return broken.length === 0
        ? { ok: true, detail: `${total} statements ${how}` }
        : { ok: false, detail: `${broken.length} of ${total} failed — ${broken.join(' | ')}` };
    },
  },

  {
    name: 'the role holds exactly the privileges the design gives it',
    async run(query) {
      const tables = await projectionTables(query);
      // Column-level as well as table-level. A column-scoped UPDATE is invisible
      // to has_table_privilege, and one column of UPDATE is all it takes for a
      // sealed forecast to stop being immutable.
      const rows = await query(
        `select t as name,
                has_table_privilege('public.' || t, 'SELECT')                 as "SELECT",
                has_table_privilege('public.' || t, 'INSERT')                 as "INSERT",
                has_any_column_privilege('public.' || t, 'UPDATE')            as "UPDATE",
                has_table_privilege('public.' || t, 'DELETE')                 as "DELETE",
                has_table_privilege('public.' || t, 'TRUNCATE')               as "TRUNCATE",
                has_any_column_privilege('public.' || t, 'REFERENCES')        as "REFERENCES",
                has_table_privilege('public.' || t, 'TRIGGER')                as "TRIGGER"
           from unnest($1::text[]) as t`,
        [[...tables]],
      );
      if (rows.length !== tables.length) {
        return { ok: false, detail: `asked about ${tables.length} tables, the catalog answered for ${rows.length}` };
      }
      const wrong: string[] = [];
      for (const row of rows) {
        const table = String(row['name']);
        if (row['SELECT'] !== true) {
          wrong.push(`${table}: no SELECT, and every statement reads the stored row to detect drift`);
        }
        const insertable = needsInsert(table);
        if (row['INSERT'] !== insertable) {
          wrong.push(
            insertable
              ? `${table}: no INSERT, so every row for it would be refused`
              : `${table}: holds INSERT, and must not — this role could write the capability row that authorises its own writes`,
          );
        }
        for (const verb of FORBIDDEN_VERBS) {
          if (row[verb] !== false) wrong.push(`${table}: holds ${verb}, so a published row is not immutable`);
        }
      }
      return wrong.length === 0
        ? {
            ok: true,
            detail: `${rows.length} tables: SELECT on all, INSERT on ${tables.filter(needsInsert).length}, and no mutating verb anywhere (table or column level)`,
          }
        : { ok: false, detail: wrong.join(' | ') };
    },
  },

  {
    name: 'the role reaches nothing outside the projection',
    async run(query) {
      const tables = await projectionTables(query);
      // The only justification for a scoped login instead of the widely-held
      // service key is that it cannot reach protocol state. A single grant
      // elsewhere removes that, and sequences are the class a table-and-view
      // sweep misses.
      const rows = await query(
        `select c.relname as name, c.relkind as kind
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
            and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
            and not (n.nspname = 'public' and c.relname = any($1::text[]))
            -- EVERY verb, and at COLUMN level where the verb is column-grantable.
            -- Asking only SELECT and INSERT at table level reads a role holding
            -- UPDATE on a protocol table — or SELECT on one column of it — as
            -- reaching nothing at all. A sequence answers a different family of
            -- functions entirely, and is the class a table-and-view sweep misses.
            and case when c.relkind = 'S' then
                      has_sequence_privilege(c.oid, 'USAGE')
                   or has_sequence_privilege(c.oid, 'SELECT')
                   or has_sequence_privilege(c.oid, 'UPDATE')
                 else
                      has_any_column_privilege(c.oid, 'SELECT')
                   or has_any_column_privilege(c.oid, 'INSERT')
                   or has_any_column_privilege(c.oid, 'UPDATE')
                   or has_any_column_privilege(c.oid, 'REFERENCES')
                   or has_table_privilege(c.oid, 'DELETE')
                   or has_table_privilege(c.oid, 'TRUNCATE')
                   or has_table_privilege(c.oid, 'TRIGGER')
                 end
          order by c.relname limit 25`,
        [[...tables]],
      );
      return rows.length === 0
        ? { ok: true, detail: 'no relation outside the projection is readable or writable by this role' }
        : {
            ok: false,
            detail: `reaches ${rows.length}: ${rows.map((row) => `${String(row['name'])}(${String(row['kind'])})`).join(', ')}`,
          };
    },
  },

  {
    name: 'an entrant is unique on (lab_id, model_id, configuration), nulls not distinct, models only',
    async run(query) {
      const rows = await query(
        `select i.relname                          as name,
                x.indisunique                      as uniq,
                x.indnullsnotdistinct              as nulls_not_distinct,
                x.indisvalid                       as valid,
                pg_get_expr(x.indpred, x.indrelid) as predicate,
                -- Cast to text, because attname has type "name" and the driver
                -- carries no parser for an array of it: it hands back the raw
                -- {a,b,c} literal as a string, which compares equal to nothing
                -- and fails this check closed against a correct index. Measured.
                (select array_agg(a.attname::text order by k.ord)
                   from unnest(x.indkey) with ordinality as k(attnum, ord)
                   join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum) as cols
           from pg_index x
           join pg_class i on i.oid = x.indexrelid
          where x.indrelid = 'public.benchmark_participants'::regclass`,
      );
      // Found by SHAPE, never by name. What protects the identity is the
      // definition, and a rename is not a defect — whereas an index of the right
      // NAME over the wrong columns is exactly the defect a name lookup accepts.
      const wanted = ENTRANT_COLUMNS.join(',');
      const over = rows.filter((row) => {
        const cols = row['cols'];
        return Array.isArray(cols) && cols.join(',') === wanted;
      });
      if (over.length === 0) {
        const seen = rows.map((row) => `${String(row['name'])}(${String(row['cols'])})`).join(', ');
        return { ok: false, detail: `no index over (${ENTRANT_COLUMNS.join(', ')}). Present: ${seen || 'none'}` };
      }
      const faults: string[] = [];
      const good = over.filter((row) => {
        const problems: string[] = [];
        if (row['uniq'] !== true) problems.push('not unique');
        if (row['valid'] !== true) problems.push('not valid, so it is not enforcing anything');
        if (row['nulls_not_distinct'] !== true) {
          problems.push('nulls are DISTINCT, so a model with no lab stops colliding with itself');
        }
        const predicate = row['predicate'];
        if (typeof predicate !== 'string') {
          problems.push('not partial, so the deterministic controls all collide on (null, null, null)');
        } else if (normalise(predicate) !== ENTRANT_PREDICATE) {
          problems.push(`partial on ${normalise(predicate)}, expected ${ENTRANT_PREDICATE}`);
        }
        if (problems.length > 0) faults.push(`${String(row['name'])}: ${problems.join('; ')}`);
        return problems.length === 0;
      });
      return good.length > 0
        ? { ok: true, detail: `${String(good[0]?.['name'])} — unique, nulls not distinct, partial on ${ENTRANT_PREDICATE}` }
        : { ok: false, detail: faults.join(' | ') };
    },
  },

  {
    name: 'a model declares its identity and a control declares none',
    async run(query) {
      const rows = await query(
        `select pg_get_constraintdef(oid) as def
           from pg_constraint
          where conrelid = 'public.benchmark_participants'::regclass and contype = 'c'`,
      );
      const present = new Set(rows.map((row) => normalise(String(row['def']))));
      const missing = ENTRANT_CONSTRAINTS.filter((wanted) => !present.has(normalise(wanted.definition)));
      return missing.length === 0
        ? { ok: true, detail: `${ENTRANT_CONSTRAINTS.length} identity constraints present` }
        : {
            ok: false,
            detail:
              `${missing.length} not found — ${missing.map((entry) => entry.invariant).join('; ')}. ` +
              `The table's CHECK constraints are: ${[...present].join(' | ') || 'none'}`,
          };
    },
  },

  {
    name: 'the reveal stores its numbers at the scales the commitment was taken over',
    async run(query) {
      const rows = await query(
        `select column_name as name, numeric_precision as p, numeric_scale as s
           from information_schema.columns
          where table_schema = 'public' and table_name = 'benchmark_decision_reveals'
            and column_name = any($1::text[])`,
        [Object.keys(REVEAL_SCALES)],
      );
      const seen = new Map(rows.map((row) => [String(row['name']), [Number(row['p']), Number(row['s'])] as const]));
      const wrong: string[] = [];
      for (const [column, [precision, scale]] of Object.entries(REVEAL_SCALES)) {
        const actual = seen.get(column);
        if (actual === undefined) {
          wrong.push(`${column} is absent or not numeric`);
        } else if (actual[0] !== precision || actual[1] !== scale) {
          wrong.push(`${column} is numeric(${actual[0]},${actual[1]}), expected numeric(${precision},${scale})`);
        }
      }
      return wrong.length === 0
        ? { ok: true, detail: `${Object.keys(REVEAL_SCALES).length} columns at their committed scales` }
        : {
            ok: false,
            detail:
              `${wrong.join('; ')} — a moved scale rounds on the way in, so the recomputed digest ` +
              'stops matching its seal and every published commitment becomes unverifiable, silently',
          };
    },
  },

  {
    name: 'the public read keys reach only what they should',
    async run(query) {
      const tables = await projectionTables(query);
      // Two separate properties, checked together because both are grants held
      // by roles OTHER than the one connected. Any role may ask about another's
      // privileges, so this is answerable from here — and it has to be asked
      // from somewhere, because nothing else in the system ever looks.
      const existing = await query('select rolname from pg_roles where rolname = any($1::text[])', [
        [...FORBIDDEN_READERS, READ_API_ROLE],
      ]);
      const present = new Set(existing.map((row) => String(row['rolname'])));
      const faults: string[] = [];

      const browserKeys = FORBIDDEN_READERS.filter((role) => present.has(role));
      if (browserKeys.length > 0) {
        // EVERY verb. Asking only about reads was a false negative with teeth:
        // measured, a DELETE granted to a browser-facing key passed this check
        // while that role really could delete published rows.
        const reach = await query(
          `select r as role, t as name, v as verb
             from unnest($1::text[]) as r, unnest($2::text[]) as t, unnest($3::text[]) as v
            where case when v in ('DELETE', 'TRUNCATE', 'TRIGGER')
                       then has_table_privilege(r, 'public.' || t, v)
                       else has_any_column_privilege(r, 'public.' || t, v) end`,
          [browserKeys, [...tables], [...ALL_VERBS]],
        );
        for (const row of reach) {
          faults.push(`${String(row['role'])} holds ${String(row['verb'])} on ${String(row['name'])}`);
        }
      }

      if (present.has(READ_API_ROLE)) {
        // The withheld prose. The publisher writes model-authored rationale on
        // the stated basis that the read API's key holds no privilege of ANY
        // kind there, so publishing it later is a deliberate GRANT plus an
        // endpoint rather than an oversight nobody notices.
        // The whole grid. "No privilege of ANY kind" is the claim, and a DELETE
        // grant satisfies a check that only asked about SELECT and UPDATE —
        // while being strictly worse than a read, because a credential that can
        // destroy evidence it cannot see leaves nothing downstream able to tell.
        const prose = await query(
          `select v as verb from unnest($3::text[]) as v
            where case when v in ('DELETE', 'TRUNCATE', 'TRIGGER')
                       then has_table_privilege($1, 'public.' || $2, v)
                       else has_any_column_privilege($1, 'public.' || $2, v) end`,
          [READ_API_ROLE, WITHHELD_TABLE, [...ALL_VERBS]],
        );
        for (const row of prose) {
          faults.push(`${READ_API_ROLE} holds ${String(row['verb'])} on ${WITHHELD_TABLE}`);
        }
      }

      const checked = [...present].join(', ') || 'none of them exist here';
      return faults.length === 0
        ? { ok: true, detail: `${checked}: no browser-reachable key touches the projection, and the read API cannot reach ${WITHHELD_TABLE}` }
        : { ok: false, detail: faults.join(' | ') };
    },
  },

  {
    name: 'row level security is enabled on every projection table',
    async run(query) {
      const tables = await projectionTables(query);
      const rows = await query(
        `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any($1::text[]) and c.relrowsecurity = false`,
        [[...tables]],
      );
      return rows.length === 0
        ? { ok: true, detail: `RLS on all ${tables.length}` }
        : { ok: false, detail: `off on ${rows.map((row) => String(row['name'])).join(', ')}` };
    },
  },

  {
    name: 'the writer can actually write THROUGH row level security',
    async run(query) {
      const tables = await projectionTables(query);
      // RLS being ENABLED is not the same as this role being able to write. A
      // table whose only permissive policy stops naming the writer denies every
      // insert while every grant in the grid still says yes — measured: the gate
      // passed, and the real write came back
      // `new row violates row-level security policy`, 42501.
      //
      // This is a policy-SHAPE check and the bound is worth stating: it asks
      // whether a permissive policy covering the command applies to this role
      // with an unconditional expression, which is the house shape. Anything
      // else is reported rather than judged, and the policy names are printed
      // so a reader can go and look.
      const rows = await query(
        `select c.relname as name,
                count(p.oid) filter (
                  where p.polpermissive and p.polcmd in ('*', 'a')
                    and (0 = any(p.polroles) or exists (
                          select 1 from pg_roles r
                           where r.oid = any(p.polroles) and r.rolname = current_user))
                    and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'true') = 'true'
                ) as writable,
                count(p.oid) filter (
                  where p.polpermissive and p.polcmd in ('*', 'r')
                    and (0 = any(p.polroles) or exists (
                          select 1 from pg_roles r
                           where r.oid = any(p.polroles) and r.rolname = current_user))
                    and coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'true'
                ) as readable,
                count(p.oid) filter (where not p.polpermissive) as restrictive,
                coalesce(string_agg(p.polname, ' | '), '(no policies at all)') as policies
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           left join pg_policy p on p.polrelid = c.oid
          where n.nspname = 'public' and c.relname = any($1::text[]) and c.relrowsecurity
          group by c.relname order by c.relname`,
        [[...tables]],
      );
      const faults: string[] = [];
      for (const row of rows) {
        const table = String(row['name']);
        const needsWrite = needsInsert(table);
        if (needsWrite && Number(row['writable']) === 0) {
          faults.push(`${table}: no permissive policy lets this role INSERT — ${String(row['policies'])}`);
        }
        // Every statement reads the stored row to detect drift, so SELECT is
        // required on every one of them, the capability table included.
        if (Number(row['readable']) === 0) {
          faults.push(`${table}: no permissive policy lets this role SELECT — ${String(row['policies'])}`);
        }
        if (Number(row['restrictive']) > 0) {
          faults.push(`${table}: a RESTRICTIVE policy applies, which can deny with nothing in the grid showing why`);
        }
      }
      return faults.length === 0
        ? { ok: true, detail: `${rows.length} RLS-protected tables admit this role's reads and writes` }
        : { ok: false, detail: faults.join(' | ') };
    },
  },

  {
    name: 'no SECURITY DEFINER function carries any checked role past its grants',
    // Exemptions are DECLARED, per role-and-function pair, in
    // DECLARED_DEFINER_EXEMPTIONS below — the "decide deliberately that it is
    // safe" branch of this check's own failure text, decided once and
    // reviewed, instead of re-decided in chat every time the gate runs.
    async run(query) {
      // The grid and the relation sweep both answer "what may this role touch
      // DIRECTLY". A SECURITY DEFINER function runs as its OWNER, so EXECUTE on
      // one is a door around both — measured: with no grant of any kind on a
      // table outside the projection, the writer inserted into it through such a
      // function, and the reachability check reported it reached nothing.
      //
      // SECURITY INVOKER functions are not listed: they run with this role's own
      // privileges, so they cannot reach past what the checks above already
      // cover. That is the whole reason this can be a short list rather than
      // every function in the database.
      // Asked for EVERY role the gate has an opinion about, not just the one
      // connected. For the writer such a function is a way OUT of its grants;
      // for a browser-facing key it is a way IN to the projection. Same
      // mechanism, and a check that asked only about the connected role would
      // close one half of it — which is the exact shape of mistake this commit
      // is repairing elsewhere.
      //
      // Roles that do not exist here are dropped by the join rather than
      // erroring, so this asks what it can and says which roles it asked about.
      //
      // ⚠ SCOPED TO `public`, AND THE BOUND IS WORTH STATING. That is where the
      //   projection, the protocol objects and anything this project authors
      //   live, and it is the exact shape that was demonstrated: a definer
      //   function in `public` granted to the writer. A managed platform ships
      //   definer functions in its own schemas by the dozen, none of them
      //   actionable by a reader of this repo, and a preflight that is red on
      //   every healthy database is a preflight people learn to skip. What this
      //   therefore does NOT catch: a definer function in a platform schema that
      //   writes to the projection.
      const rows = await query(
        // A subquery rather than a leading CTE, so the statement still begins
        // with `select`. The suite sweeps every statement these checks issue and
        // admits only reads by their opening verb; widening that to accept
        // `with` would also admit `WITH … INSERT`, which is exactly the thing
        // the sweep exists to refuse.
        // The fn is the routine's FULL identity — name AND identity arguments —
        // because overloads are separate functions and each must stand or fall
        // on its own declaration. And there is deliberately NO row limit: this
        // statement is the census the verdict is computed from, and a capped
        // census lets an undeclared row hide behind enough declared ones to
        // fill the cap (measured: 40 overloads of a declared name sorted ahead
        // of an undeclared function and a limited build passed). Only the
        // failure DETAIL truncates, below, and it says when it does.
        `select named.role,
                n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
                exists (select 1 from pg_depend d
                         where d.objid = p.oid
                           and d.classid = 'pg_proc'::regclass
                           and d.deptype = 'e') as from_extension
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join (select rolname::text as role from pg_roles
                        where rolname = any($1::text[]) or rolname = current_user) as named
          where n.nspname = 'public'
            and p.prosecdef
            and has_function_privilege(named.role, p.oid, 'EXECUTE')
          order by 1, 2`,
        [[...FORBIDDEN_READERS, READ_API_ROLE]],
      );
      if (rows.length === 0) {
        return { ok: true, detail: 'no role this gate checks may execute a SECURITY DEFINER function' };
      }
      const exempt: string[] = [];
      const violating: string[] = [];
      const present = new Set<string>();
      for (const row of rows) {
        const entry = `${String(row['role'])} -> ${String(row['fn'])}`;
        present.add(entry);
        const platform = row['from_extension'] === true ? ' [extension]' : '';
        (isExemptDefiner(String(row['role']), String(row['fn'])) ? exempt : violating)
          .push(`${entry}${platform}`);
      }
      if (violating.length > 0) {
        // The verdict was computed over EVERY row; only the display truncates,
        // and it says so with the count, so nothing red can look green.
        const shown = violating.slice(0, 20);
        const elided = violating.length - shown.length;
        return {
          ok: false,
          detail:
            `${violating.length} executable as their owner: ${shown.join(', ')}` +
            (elided > 0 ? ` … and ${elided} more not displayed` : '') +
            '. Each one is a path around the ' +
            'privilege grid above; revoke EXECUTE, or decide deliberately that it is safe by ' +
            'adding the exact pair to DECLARED_DEFINER_EXEMPTIONS with its reasoning. ' +
            'Entries marked [extension] belong to an installed extension rather than to this schema.',
        };
      }
      // Pruning hint, not a failure: an exemption whose function is gone should
      // be removed, but a gate that reddens on a healthy database because the
      // protocol refactored an RPC is a gate people learn to skip.
      const unused = [...DECLARED_DEFINER_EXEMPTIONS].filter((entry) => !present.has(entry));
      return {
        ok: true,
        detail:
          `${exempt.length} definer grant(s), every one a declared exemption ` +
          `(service_role's own protocol write path)` +
          (unused.length > 0 ? `; declared but no longer present, prune: ${unused.join(', ')}` : ''),
      };
    },
  },

  {
    name: 'lifetime row counts',
    informational: true,
    async run(query) {
      // Reported, never decisive. Zero across the board is what a projection
      // that has never been written looks like, and an operator enabling one for
      // the first time should see that before they do. A non-zero count is a
      // fact about history, not a fault, and this command has no business
      // refusing a database for having been used.
      return { ok: true, detail: await readRowCounts(query) };
    },
  },
];

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export const GATE_EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
  unconfigured: 3,
  refused: 4,
  crashed: 5,
});

const USAGE = `usage: yarn gate:serving

Ask the configured serving database whether it can hold this publisher's writes.

Read-only: after connecting through the pool, the checked-out client explicitly
sets default_transaction_read_only=on. The startup option remains as defence in
depth; the server must still prove it refuses a write before anything else is
asked, and row counts are compared before and after to confirm nothing moved.

Run this by hand before enabling publication against a database for the first
time. Nothing in yarn watch / yarn smoke / yarn project calls it, deliberately.

Exit codes:
  0  every check passed
  1  a check failed — the line beside it says what
  2  usage
  3  no serving credential is configured, so there was nothing to ask
  4  refused — no connection this gate is willing to use
  5  the command itself failed`;

export type GateConnection =
  | {
      readonly kind: 'ready';
      readonly query: GateQuery;
      /** Whether the host this process DIALLED is this machine. Client-side
       *  knowledge; see proveEncrypted for why the server cannot supply it. */
      readonly localTarget: boolean;
      close(): Promise<void>;
    }
  | { readonly kind: 'unconfigured'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string };

export interface SchemaGateDeps {
  readonly argv: readonly string[];
  readonly open: () => Promise<GateConnection>;
  readonly checks: readonly GateCheck[];
  readonly log: { line(message: string): void; error(message: string): void };
}

export async function runSchemaGate(deps: SchemaGateDeps): Promise<number> {
  const { line, error } = deps.log;
  if (deps.argv.includes('--help') || deps.argv.includes('-h')) {
    line(USAGE);
    return GATE_EXIT.ok;
  }

  const connection = await deps.open();
  if (connection.kind === 'unconfigured') {
    line(`serving schema gate: nothing to check — ${connection.reason}`);
    return GATE_EXIT.unconfigured;
  }
  if (connection.kind === 'refused') {
    error(`serving schema gate: ${connection.reason}`);
    return GATE_EXIT.refused;
  }

  try {
    // A pooler can drop startup GUCs. Apply the guard after connecting, on the
    // same checked-out client that every probe and check below will use.
    await connection.query(READ_ONLY_SESSION_SQL);

    // Before ANY check: prove the explicit guard actually makes writes fail. A
    // gate that could write would be running statements against a database whose
    // rows can never be deleted, in order to find out whether that was safe.
    const readOnly = await proveReadOnly(connection.query);
    line(`${readOnly.ok ? 'ok  ' : 'FAIL'}  the connection is read-only: ${readOnly.detail}`);
    if (!readOnly.ok) return GATE_EXIT.refused;

    const encrypted = proveEncrypted(await readSession(connection.query), connection.localTarget);
    line(`${encrypted.ok ? 'ok  ' : 'FAIL'}  the session is encrypted: ${encrypted.detail}`);

    // Read through a catch: an unreadable count is a FINDING, not a crash. The
    // command exists to report on a database that may be misconfigured, and the
    // shape it is most likely to be misconfigured in — a missing grant on one
    // table — is exactly what makes this query throw.
    const before = await countsOrNull(connection.query);
    const findings = await runChecks(deps.checks, connection.query);
    for (const finding of findings) {
      line(`${finding.informational ? 'note' : finding.ok ? 'ok  ' : 'FAIL'}  ${finding.name}: ${finding.detail}`);
    }

    // The second, independent proof that this command changed nothing. The
    // 25006 refusal says writes are impossible; this says none happened.
    const after = await countsOrNull(connection.query);
    // Unreadable is NOT unchanged. Two nulls compare equal and would report the
    // gate as having proven something it never measured.
    const unmoved = before !== null && after !== null && before === after;
    line(
      unmoved
        ? 'ok    the gate wrote nothing: row counts unchanged'
        : `FAIL  the gate wrote nothing: ${before === null || after === null
            ? 'the row counts could not be read, so nothing was proven either way'
            : `row counts MOVED — ${before} -> ${after}`}`,
    );

    // Everything decisive, counted in one place: the schema checks, the
    // transport, and the gate's own proof that it changed nothing. The
    // read-only precondition is not here because it returns above.
    const failed =
      findings.filter((finding) => !finding.informational && !finding.ok).length +
      (encrypted.ok ? 0 : 1) +
      (unmoved ? 0 : 1);
    if (failed > 0) {
      error(
        `serving schema gate: ${failed} check(s) FAILED. Do not enable publication against ` +
          'this database — its rows are insert-once, so what is written wrong stays wrong.',
      );
      return GATE_EXIT.failed;
    }
    line("serving schema gate: PASS — this database can hold the publisher's writes.");
    return GATE_EXIT.ok;
  } finally {
    await connection.close();
  }
}

/**
 * Run every check, in order, and let none of them stop the others.
 *
 * A thrown query error becomes a FAILED finding rather than an escaped
 * exception: the command's job is to report what it found, and "the question
 * could not be asked" is one of the things it can find. Sequential rather than
 * concurrent because the answers are read together by a person, and an
 * interleaved report is harder to act on than a slow one.
 */
export async function runChecks(
  checks: readonly GateCheck[],
  query: GateQuery,
): Promise<readonly GateFinding[]> {
  const findings: GateFinding[] = [];
  for (const check of checks) {
    const informational = check.informational === true;
    try {
      findings.push({ name: check.name, informational, ...(await check.run(query)) });
    } catch (caught) {
      findings.push({
        name: check.name,
        informational,
        ok: false,
        detail: `the check could not be run: ${describeError(caught)}`,
      });
    }
  }
  return findings;
}

/**
 * Open the same connection the publisher would, minus the ability to write.
 *
 * Deliberately the SAME resolver and the SAME pool configuration, so this also
 * proves the parts of publication that have nothing to do with the schema: that
 * the credential resolves, that the TLS decision is one the resolver accepts,
 * and that the host answers. A gate that connected its own way could pass while
 * the publisher could not connect at all.
 */
/**
 * Whether the resolved connection dials this machine.
 *
 * Answered by the same pair the publisher's own resolver uses, rather than by a
 * second opinion: `dsnFacts` for which host the driver will actually dial —
 * which a `?host=` parameter can override — and `isLocalHost` for whether that
 * host is here, by address and never by string prefix.
 *
 * Unknown counts as REMOTE. That direction costs a spurious failure on an
 * unusual spelling of a local address; the other direction would quietly bless
 * a cleartext password sent to another machine.
 */
export function dialsThisMachine(connection: BenchmarkWriterConnection): boolean {
  if (connection.kind === 'derived') return isLocalHost(connection.host);
  try {
    return isLocalHost(dsnFacts(connection.connectionString).host);
  } catch {
    // dsnFacts reads sslcert/sslkey/sslrootcert off the disk and throws when one
    // is missing. The driver will throw on the same string a moment later; until
    // then, remote.
    return false;
  }
}

async function openGateConnection(): Promise<GateConnection> {
  const resolution = resolveBenchmarkWriterConnection();
  if (!resolution.resolved) {
    return resolution.reason === 'no_credential'
      ? { kind: 'unconfigured', reason: 'no serving credential is configured' }
      : { kind: 'refused', reason: `the connection settings were refused (${resolution.reason})` };
  }
  let driver: typeof import('pg');
  try {
    driver = await import('pg');
  } catch {
    return { kind: 'refused', reason: 'the PostgreSQL driver is not installed in this environment' };
  }
  const pool = new driver.Pool({
    ...servingPoolConfig(resolution.connection),
    options: GATE_STARTUP_OPTIONS,
    // One connection: the gate checks out and holds it so the explicit SET, the
    // refusal probe and every schema question share one session.
    max: 1,
  });
  // Without this, a reset while the gate is running is an uncaught exception
  // rather than a failed check — the same hazard the publisher's pool carries,
  // and here it would abandon a preflight halfway with no verdict at all.
  const reportConnectionError = (error: unknown): void => {
    try {
      printError(`serving schema gate: the connection failed (${describeError(error)})`);
    } catch {
      // Same reason as the publisher's listener: this runs in an event handler,
      // so a sink that throws is an uncaught exception rather than a lost line.
    }
  };
  pool.on('error', reportConnectionError);
  const client = await pool.connect().catch(async (caught: unknown) => {
    await pool.end().catch(() => undefined);
    throw caught;
  });
  // A checked-out client emits its own idle socket errors rather than routing
  // them through the pool's listener.
  client.on('error', reportConnectionError);
  return {
    kind: 'ready',
    localTarget: dialsThisMachine(resolution.connection),
    query: async (sql, params) =>
      (await client.query(sql, params === undefined ? undefined : [...params])).rows,
    close: async () => {
      client.removeListener('error', reportConnectionError);
      client.release();
      await pool.end().catch(() => undefined);
    },
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  loadDotEnv();
  runSchemaGate({
    argv: process.argv.slice(2),
    open: openGateConnection,
    checks: SERVING_SCHEMA_CHECKS,
    log: { line: printLine, error: printError },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((caught: unknown) => {
      printError(describeErrorWithStack(caught));
      process.exitCode = GATE_EXIT.crashed;
    });
}
