import { createInterface } from 'node:readline';
import { assertBootedCohort } from './cohortBoot.js';
import type { BootedCohort } from './cohortBoot.js';
import { CROSSING_PROFILE, crossingPinViolations } from './crossingProfile.js';
import { SPEND_GUARD_PRICE_TABLE_VERSION, modelPriceTableDigest } from './modelPriceTable.js';
import { createRealAdapters } from './providers/index.js';
import type { CanaryAuthorization } from './cohortAdapterCapability.js';

/**
 * TRI-STATE live-intent resolution — the impure CLI-side owner of "may this
 * invocation fire real (billable) adapters?". The resolver returns exactly one of:
 *
 *   - `MockRequested` — `--live` was not passed; the caller selects the known-zero
 *     mock capability exactly as before. This is the only path that may run mock.
 *   - `LiveAuthorized` — `--live` was passed, every prerequisite held, AND the
 *     operator confirmed the printed terms at the `[Y/n]` prompt; carries the
 *     exact `CanaryAuthorization` the gated billable producer will re-validate.
 *   - `LiveRefused` — `--live` was passed and ANYTHING was missing or invalid, or
 *     the confirmation was declined/EOF. The caller MUST exit nonzero. A live
 *     request is NEVER reinterpreted as "authorization absent → run mock":
 *     silently downgrading an intended paid run to a mock one would report a
 *     rehearsal as if it were the crossing.
 *
 * Boot stays pure (`cohortBoot` validates manifests and derives identity; it owns
 * no live decision); this resolver is the impure complement, and the gated
 * producer (`gateRealCohortAdapterCapability`) is the positive authority that
 * actually mints billable adapters. The producer independently re-derives the
 * cohort binding, the crossing pins, and the credential observations, so a buggy
 * or bypassed resolver cannot widen WHAT can be minted — which cohort shape,
 * which adapters, which caps. The attended confirmation itself is enforced by
 * THIS resolution flow (the production CLI's only route to a `LiveAuthorized`);
 * the producer consumes it as validated data and cannot re-derive that a human
 * answered — making the confirmation a structural (branded) guarantee rather
 * than a flow-enforced one is a deliberate follow-up decision, not part of this
 * slice.
 *
 * For a live request the resolver, in order: authenticates the booted cohort,
 * checks it against the pinned one-fire crossing profile, observes every roster
 * credential through the injected probe (production: the real adapters' own
 * `hasCredential`, which for the Google arm credits its supported credential
 * alias), and — only with zero violations — prints the exact terms (cohortId, the
 * $ reservation ceiling, the call cap, the one-fire limit) and asks the standard
 * `[Y/n]` confirmation with the convention's normal semantics: `y` / `yes`
 * (case-insensitive) or an EMPTY answer (Enter accepts the capital-Y default)
 * authorizes; `n`, any other text, or a closed input stream (EOF) refuses. The
 * deliberate arm signal is the explicit `--live` flag plus the printed terms —
 * the prompt is the attended second look. EOF is NOT Enter: a stream that closes
 * without producing a line always refuses. An actual empty line — interactive or
 * deliberately piped — is Enter and accepts the default.
 */

export type LiveIntentResolution =
  | { readonly kind: 'MockRequested' }
  | { readonly kind: 'LiveAuthorized'; readonly authorization: CanaryAuthorization }
  | { readonly kind: 'LiveRefused'; readonly violations: readonly string[] };

export interface LiveIntentRequest {
  /** True IFF the invocation passed `--live`. */
  readonly live: boolean;
  /** The booted cohort the live run would fire under (the crossing cohort). */
  readonly booted: BootedCohort;
  /**
   * Observe which roster participants hold a usable credential. Production:
   * {@link observeRealAdapterCredentials} (the real adapters' own probes).
   * Injected so resolution is testable without touching the environment.
   */
  readonly observeCredentials: (participantIds: readonly string[]) => ReadonlyMap<string, boolean>;
  /** Print one operator-facing line (production: the CLI's stdout printer). */
  readonly print: (line: string) => void;
  /**
   * Obtain the confirmation answer for `prompt`; `null` means the input stream
   * closed (EOF) before an answer. Production: {@link askLiveConfirmation}.
   */
  readonly confirm: (prompt: string) => Promise<string | null>;
}

/** Freeze a refusal, so the resolution record is immutable like every other outcome. */
function refused(violations: readonly string[]): LiveIntentResolution {
  return Object.freeze({ kind: 'LiveRefused' as const, violations: Object.freeze([...violations]) });
}

/**
 * Resolve the invocation's live intent. See the module header for the contract;
 * the returned resolution (and any carried authorization) is frozen.
 */
export async function resolveLiveIntent(request: LiveIntentRequest): Promise<LiveIntentResolution> {
  // Capture every caller field once, before any await.
  const live = request.live;
  const booted = request.booted;
  const observeCredentials = request.observeCredentials;
  const print = request.print;
  const confirm = request.confirm;

  // The cohort must be genuine on BOTH paths — a forged cohort fails loudly, never
  // resolves. (A refusal is a decision about a real cohort; a forgery is not one.)
  assertBootedCohort(booted);

  if (!live) return Object.freeze({ kind: 'MockRequested' as const });

  const manifest = booted.manifest;
  const rosterIds = manifest.expectedArmRoster.map((arm) => arm.participantId);

  // Accumulate EVERY violation (profile + credentials) so the operator sees the full
  // list at once, mirroring canonical boot. All checks precede the confirmation: a
  // prompt is only ever shown for a run that could actually be authorized.
  const violations: string[] = [...crossingPinViolations(manifest)];
  const observedMap = observeCredentials(rosterIds);
  const observedIds: string[] = [];
  for (const participantId of rosterIds) {
    if (observedMap.get(participantId) === true) {
      observedIds.push(participantId);
    } else {
      violations.push(
        `participant "${participantId}" has no usable credential (its adapter's credential probe returned false)`,
      );
    }
  }
  if (violations.length > 0) return refused(violations);

  // The exact terms, from the AUTHENTICATED manifest (equal to the pins at this point),
  // printed BEFORE the confirmation is requested.
  const spendCapUsd = (manifest.cohortSpendCapUsdMicros / 1_000_000).toFixed(2);
  print('ATTENDED LIVE CROSSING — real provider spend on confirmation:');
  print(`  cohortId ${booted.cohortId}`);
  print(
    `  full-fire reservation ceiling $${spendCapUsd} (cohortSpendCapUsdMicros ${manifest.cohortSpendCapUsdMicros})`,
  );
  print(
    `  provider call cap ${manifest.cohortCallCap} (roster ${rosterIds.length} × ` +
      `${1 + manifest.constants.maxRepairAttemptsPerArm} attempts)`,
  );
  print(`  one fire maximum this invocation (maxDispatchesPerTick ${manifest.constants.maxDispatchesPerTick})`);
  print("  Enter or 'y' proceeds; 'n', any other answer, or EOF refuses");

  const answer = await confirm('proceed with the attended live crossing? [Y/n] ');
  if (answer === null) {
    return refused(['live confirmation stream closed (EOF) before an answer — refusing']);
  }
  const normalized = answer.trim().toLowerCase();
  // The standard [Y/n] semantics: Enter (an empty answer) accepts the capital-Y default,
  // and 'y'/'yes' accept explicitly; anything else refuses. EOF was refused ABOVE — a
  // stream that closes without producing a line is not Enter, while an actual empty line
  // (interactive or deliberately piped) is Enter and accepts the default.
  if (normalized !== '' && normalized !== 'y' && normalized !== 'yes') {
    return refused([
      `live confirmation declined (answer ${JSON.stringify(answer)}); Enter or 'y' proceeds`,
    ]);
  }

  // The authorization: identity from the authenticated booted cohort, the price identity
  // and caps from the PINNED crossing profile (not re-read from the manifest — the gated
  // producer's equality checks are what bind pin to manifest), and the credential
  // observation made above. Frozen, like every resolution record.
  const authorization: CanaryAuthorization = Object.freeze({
    cohortId: booted.cohortId,
    participantIds: Object.freeze([...rosterIds]),
    modelPriceTableVersion: SPEND_GUARD_PRICE_TABLE_VERSION,
    modelPriceTableDigest: modelPriceTableDigest(SPEND_GUARD_PRICE_TABLE_VERSION),
    liveOptIn: true,
    observedCredentialedParticipantIds: Object.freeze(observedIds),
    cohortSpendCapUsdMicros: CROSSING_PROFILE.cohortSpendCapUsdMicros,
    cohortCallCap: CROSSING_PROFILE.cohortCallCap,
    maxConcurrentProviderRequests: CROSSING_PROFILE.maxConcurrentProviderRequests,
    maxDispatchesPerTick: CROSSING_PROFILE.maxDispatchesPerTick,
    maxRepairAttemptsPerArm: CROSSING_PROFILE.maxRepairAttemptsPerArm,
  });
  return Object.freeze({ kind: 'LiveAuthorized' as const, authorization });
}

/**
 * The production credential probe: construct the real adapters and ask each one
 * whether its credential is usable (`hasCredential()` — env-based, no network).
 * A participant with no real adapter reads as not credentialed.
 */
export function observeRealAdapterCredentials(participantIds: readonly string[]): ReadonlyMap<string, boolean> {
  const adapters = createRealAdapters();
  return new Map(participantIds.map((id) => [id, adapters.get(id)?.hasCredential() === true]));
}

/**
 * The production confirmation seam: one readline question on the process stdin.
 * Resolves the raw answer, or `null` if the input closes (EOF / piped-empty stdin)
 * before an answer — which the resolver treats as a refusal. The callback API is
 * used deliberately: a close during a pending promise-API question has had
 * version-dependent behavior, while the callback + `close` listener pair settles
 * deterministically on every supported Node.
 */
export function askLiveConfirmation(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    rl.question(prompt, (answer) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    });
    rl.on('close', () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
  });
}
