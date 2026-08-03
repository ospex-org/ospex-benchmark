import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCampaignAuthorization } from './campaignAuthorization.js';
import type { CampaignAuthorization, CampaignAuthorizationPort } from './campaignAuthorization.js';
import { buildCampaignManifest } from './campaignProfile.js';
import { armCampaign, stopCampaign, tickCampaign } from './campaignMain.js';
import type { CampaignDeps } from './campaignMain.js';
import { cohortBoot } from './cohortBoot.js';
import type { CohortTickInput, CohortTickResult, FireOutcomeSummary } from './cohortRunner.js';
import type { AtomicStore } from './store/contract.js';
import type { LineOpenFireOutcome } from './lineOpenSpine.js';
import { defaultExpectedArms } from './scoring.js';

/**
 * The campaign owner-level flows — arm, tick, stop — driven WITHOUT a database, a network,
 * or a provider. Every seam is injected, so these prove the decisions the CLI owns: the
 * attended arming gate, the unattended tick's refusal-without-authorization, and the
 * escalation auto-disarm.
 */

const NOW = Date.parse('2026-08-05T00:00:00.000Z');
const WEEK_MS = 7 * 24 * 3_600_000;
const ROSTER = defaultExpectedArms().map((a) => a.participantId);

const SYNTHETIC_ENV: Record<string, string | undefined> = {
  STORE_DATABASE_URL: 'postgres://synthetic/none',
  SUPABASE_URL: 'http://unused.invalid',
  SUPABASE_ANON_KEY: 'unused',
  OPENAI_API_KEY: 'synthetic-test-credential',
  ANTHROPIC_API_KEY: 'synthetic-test-credential',
  GEMINI_API_KEY: 'synthetic-test-credential',
  GOOGLE_API_KEY: undefined,
  XAI_API_KEY: 'synthetic-test-credential',
};

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** An in-memory authorization port that records every call. */
class MemoryAuthPort implements CampaignAuthorizationPort {
  readonly records = new Map<string, CampaignAuthorization>();
  readonly calls: string[] = [];
  async read(cohortId: string): Promise<unknown | null> {
    this.calls.push(`read:${cohortId}`);
    return this.records.get(cohortId) ?? null;
  }
  async arm(record: CampaignAuthorization): Promise<'armed' | 'already_armed'> {
    this.calls.push(`arm:${record.cohortId}`);
    if (this.records.has(record.cohortId)) return 'already_armed';
    this.records.set(record.cohortId, record);
    return 'armed';
  }
  async disarm(cohortId: string, at: string): Promise<'disarmed' | 'not_found'> {
    this.calls.push(`disarm:${cohortId}`);
    const existing = this.records.get(cohortId);
    if (existing === undefined) return 'not_found';
    if (existing.disarmedAt === null) this.records.set(cohortId, { ...existing, disarmedAt: at });
    return 'disarmed';
  }
}

/** A store whose budget init succeeds; nothing else is reachable in these tests. */
function fakeStore(): AtomicStore {
  const unreached = (): never => {
    throw new Error('the faked tick never exercises the store beyond initCohortBudget');
  };
  return {
    initCohortBudget: async () => ({ outcome: 'initialized' as const }),
    admitDispatch: unreached,
    acquireRepairLease: unreached,
    releaseLease: unreached,
    completeClaim: unreached,
  };
}

function tickResult(fireOutcomes: FireOutcomeSummary[] = []): CohortTickResult {
  return { discoveredCount: fireOutcomes.length, dispositions: [], fireOutcomes, admittedCount: 0 };
}

const escalatedOutcome = (): LineOpenFireOutcome =>
  ({
    kind: 'InstalledEscalated',
    install: { path: '/out/fire.json', created: true },
    sidecar: { path: '/out/fire-spend.json', created: true, sha256: 'ab'.repeat(32) },
    reason: 'spend_attempt_over_reservation',
    offenders: [{ participantId: ROSTER[0]!, role: 'initial', status: 'breach', derivedActualUsdMicros: 100_000_010 }],
  }) as unknown as LineOpenFireOutcome;

function deps(over: Partial<CampaignDeps> & { auth?: MemoryAuthPort } = {}): CampaignDeps & { auth: MemoryAuthPort } {
  const auth = over.auth ?? new MemoryAuthPort();
  const base: CampaignDeps = {
    openStore: async () => ({ store: fakeStore(), authorizations: auth, close: async () => {} }),
    runTick: async () => tickResult(),
    observeCredentials: (ids) => new Map(ids.map((id) => [id, true])),
    confirm: async () => 'y',
    now: () => NOW,
    ...over,
  };
  return { ...base, auth };
}

function options(over: Record<string, unknown> = {}): Parameters<typeof armCampaign>[0] {
  return {
    command: 'arm',
    calls: 800,
    days: 7,
    startIso: null,
    dispatches: 1,
    manifestPath: null,
    emitPath: join(mkdtempSync(join(tmpdir(), 'campaign-')), 'campaign-manifest.json'),
    outDir: null,
    ...over,
  } as Parameters<typeof armCampaign>[0];
}

// ===========================================================================
// arm
// ===========================================================================

test('arm prints the exact terms and, on an explicit y, initializes the budget and records the authorization', async () => {
  const printed: string[] = [];
  const original = console.log;
  console.log = (line?: unknown) => printed.push(String(line ?? ''));
  const d = deps();
  const opts = options();
  let code: number;
  try {
    code = await withEnv(SYNTHETIC_ENV, () => armCampaign(opts, d));
  } finally {
    console.log = original;
  }
  assert.equal(code, 0, printed.join('\n'));

  const output = printed.join('\n');
  assert.match(output, /ARM CAMPAIGN/);
  assert.match(output, /at most 800 provider calls \(100 fires/);
  assert.match(output, /\$37\.09 expected at the observed rate/);
  assert.match(output, /hard-stopped above \$100/);
  assert.match(output, /expiry 2026-08-12T00:00:00\.000Z/);

  // The authorization was recorded, and the manifest written for later ticks.
  assert.equal(d.auth.records.size, 1);
  const record = [...d.auth.records.values()][0]!;
  assert.equal(record.disarmedAt, null);
  assert.deepEqual([...record.participantIds], ROSTER);
  const emitted = readFileSync(opts.emitPath, 'utf8');
  assert.equal(cohortBoot({ manifestBytes: emitted }).cohortId, record.cohortId);
});

test('arm records NOTHING when the confirmation is declined or the stream closes', async () => {
  for (const answer of ['n', '', 'yeah', null]) {
    const d = deps({ confirm: async () => answer });
    const code = await withEnv(SYNTHETIC_ENV, () => armCampaign(options(), d));
    assert.notEqual(code, 0, `answer ${JSON.stringify(answer)}`);
    assert.equal(d.auth.records.size, 0, `answer ${JSON.stringify(answer)}: nothing armed`);
    assert.deepEqual(d.auth.calls, [], 'the authorization port was never touched');
  }
});

test('arm REFUSES before any prompt when a roster credential is missing', async () => {
  const d = deps({
    observeCredentials: (ids) => new Map(ids.map((id) => [id, id !== ROSTER[2]])),
    confirm: async () => {
      throw new Error('must not prompt for an unarmable campaign');
    },
  });
  const code = await withEnv(SYNTHETIC_ENV, () => armCampaign(options(), d));
  assert.equal(code, 2);
  assert.equal(d.auth.records.size, 0);
});

test('arm REFUSES a second campaign for the same cohort — no silent re-arm of live terms', async () => {
  const auth = new MemoryAuthPort();
  const first = await withEnv(SYNTHETIC_ENV, () => armCampaign(options(), deps({ auth })));
  assert.equal(first, 0);
  const second = await withEnv(SYNTHETIC_ENV, () => armCampaign(options(), deps({ auth })));
  assert.equal(second, 2, 'the second arm is refused');
  assert.equal(auth.records.size, 1);
});

test('arm REFUSES a size outside the campaign bounds', async () => {
  for (const calls of [7, 4_001]) {
    const d = deps();
    const code = await withEnv(SYNTHETIC_ENV, () => armCampaign(options({ calls }), d));
    assert.equal(code, 2, `calls=${calls}`);
    assert.equal(d.auth.records.size, 0);
  }
});

// ===========================================================================
// tick
// ===========================================================================

/** Arm a campaign and return its manifest path + the shared port. */
async function armed(over: { dispatches?: number } = {}): Promise<{ manifestPath: string; auth: MemoryAuthPort }> {
  const auth = new MemoryAuthPort();
  const opts = options(over);
  const code = await withEnv(SYNTHETIC_ENV, () => armCampaign(opts, deps({ auth })));
  assert.equal(code, 0);
  return { manifestPath: opts.emitPath, auth };
}

test('a tick with NO armed authorization fires nothing and exits 2 — never a mock fallback', async () => {
  const { bytes } = buildCampaignManifest(NOW, { callCap: 800, windowForwardMs: WEEK_MS });
  const dir = mkdtempSync(join(tmpdir(), 'campaign-tick-'));
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, bytes);

  let ticked = false;
  const d = deps({
    runTick: async () => {
      ticked = true;
      return tickResult();
    },
  });
  const code = await withEnv(SYNTHETIC_ENV, () => tickCampaign(options({ command: 'tick', manifestPath }), d));
  assert.equal(code, 2);
  assert.equal(ticked, false, 'no tick ran without an authorization');
});

test('a tick against a DISARMED campaign fires nothing and exits 2', async () => {
  const { manifestPath, auth } = await armed();
  const booted = cohortBoot({ manifestBytes: readFileSync(manifestPath, 'utf8') });
  await auth.disarm(booted.cohortId, new Date(NOW).toISOString());

  let ticked = false;
  const code = await withEnv(SYNTHETIC_ENV, () =>
    tickCampaign(
      options({ command: 'tick', manifestPath }),
      deps({
        auth,
        runTick: async () => {
          ticked = true;
          return tickResult();
        },
      }),
    ),
  );
  assert.equal(code, 2);
  assert.equal(ticked, false);
});

test('a tick after EXPIRY fires nothing and exits 2', async () => {
  const { manifestPath, auth } = await armed();
  let ticked = false;
  const code = await withEnv(SYNTHETIC_ENV, () =>
    tickCampaign(
      options({ command: 'tick', manifestPath }),
      deps({
        auth,
        now: () => NOW + WEEK_MS + 1,
        runTick: async () => {
          ticked = true;
          return tickResult();
        },
      }),
    ),
  );
  assert.equal(code, 2);
  assert.equal(ticked, false);
});

test('a live tick mints BILLABLE authority and runs — the unattended path never prompts', async () => {
  const { manifestPath, auth } = await armed();
  let captured: CohortTickInput | undefined;
  const code = await withEnv(SYNTHETIC_ENV, () =>
    tickCampaign(
      options({ command: 'tick', manifestPath }),
      deps({
        auth,
        confirm: async () => {
          throw new Error('an unattended tick must never prompt');
        },
        runTick: async (input) => {
          captured = input;
          return tickResult();
        },
      }),
    ),
  );
  assert.equal(code, 0);
  assert.ok(captured);
  assert.equal(captured!.capability.billingClass, 'billable');
  assert.deepEqual([...captured!.capability.adapters().keys()], ROSTER);
});

test('a spend-guard ESCALATION auto-disarms the campaign and exits nonzero', async () => {
  const { manifestPath, auth } = await armed();
  const booted = cohortBoot({ manifestBytes: readFileSync(manifestPath, 'utf8') });
  const code = await withEnv(SYNTHETIC_ENV, () =>
    tickCampaign(
      options({ command: 'tick', manifestPath }),
      deps({
        auth,
        runTick: async () =>
          tickResult([{ fireId: 'f1', gameId: 'g1', market: 'moneyline', outcome: escalatedOutcome() }]),
      }),
    ),
  );
  assert.equal(code, 1, 'an escalated tick is loud');
  assert.notEqual(auth.records.get(booted.cohortId)!.disarmedAt, null, 'the campaign disarmed itself');

  // And the very next tick refuses — the mispricing cannot repeat on the next cron interval.
  let ticked = false;
  const next = await withEnv(SYNTHETIC_ENV, () =>
    tickCampaign(
      options({ command: 'tick', manifestPath }),
      deps({
        auth,
        runTick: async () => {
          ticked = true;
          return tickResult();
        },
      }),
    ),
  );
  assert.equal(next, 2);
  assert.equal(ticked, false);
});

// ===========================================================================
// stop
// ===========================================================================

test('stop disarms an armed campaign, is idempotent, and refuses an unknown cohort', async () => {
  const { manifestPath, auth } = await armed();
  const booted = cohortBoot({ manifestBytes: readFileSync(manifestPath, 'utf8') });

  const first = await withEnv(SYNTHETIC_ENV, () => stopCampaign(options({ command: 'stop', manifestPath }), deps({ auth })));
  assert.equal(first, 0);
  const disarmedAt = auth.records.get(booted.cohortId)!.disarmedAt;
  assert.notEqual(disarmedAt, null);

  // Idempotent, and the FIRST stop instant is preserved — a repeat must not rewrite history.
  const second = await withEnv(SYNTHETIC_ENV, () =>
    stopCampaign(options({ command: 'stop', manifestPath }), deps({ auth, now: () => NOW + 60_000 })),
  );
  assert.equal(second, 0);
  assert.equal(auth.records.get(booted.cohortId)!.disarmedAt, disarmedAt);

  // A cohort that was never armed.
  const { bytes } = buildCampaignManifest(NOW + 3_600_000, { callCap: 800, windowForwardMs: WEEK_MS });
  const otherPath = join(mkdtempSync(join(tmpdir(), 'campaign-other-')), 'manifest.json');
  writeFileSync(otherPath, bytes);
  const unknown = await withEnv(SYNTHETIC_ENV, () =>
    stopCampaign(options({ command: 'stop', manifestPath: otherPath }), deps({ auth })),
  );
  assert.equal(unknown, 2);
});

test('the recorded authorization is bound to the armed cohort and expires with the window', async () => {
  const { manifestPath, auth } = await armed();
  const booted = cohortBoot({ manifestBytes: readFileSync(manifestPath, 'utf8') });
  const record = auth.records.get(booted.cohortId)!;
  const expected = buildCampaignAuthorization({
    booted,
    observedCredentialedParticipantIds: ROSTER,
    armedAtMs: NOW,
    expiresAtMs: NOW + WEEK_MS,
  });
  assert.deepEqual(
    { ...record, participantIds: [...record.participantIds], observedCredentialedParticipantIds: [...record.observedCredentialedParticipantIds] },
    { ...expected, participantIds: [...expected.participantIds], observedCredentialedParticipantIds: [...expected.observedCredentialedParticipantIds] },
  );
});
