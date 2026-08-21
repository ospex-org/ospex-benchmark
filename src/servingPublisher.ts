import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sha256Hex } from './canonical.js';
import { describeError } from './config.js';
import {
  parseScoredArtifact,
  projectScoredRun,
  publishableScoredRun,
} from './scoredProjection.js';
import {
  parseRunArtifact,
  projectRun,
  publishableRun,
  revealMatchesSeal,
  verifyArtifactIntegrity,
} from './servingProjection.js';
import type { ProjectedDecision, ProjectionPlan } from './servingProjection.js';
import type { BenchmarkServingPort, DecisionScore, PublishOutcome, SourceRef } from './servingStore.js';

/**
 * Writes a run artifact onto the serving projection, and says what happened.
 *
 * ── IT CANNOT FAIL A RUN, AND THEREFORE MUST BE LOUD ─────────────────────────
 * Every publish resolves to a typed outcome and none of them throws, because a
 * benchmark night must not be lost to a database being unreachable. The cost of
 * that property is that `published`, `duplicate`, `parent_missing`, `refused`
 * and `contradiction` all look identical to a caller who ignores the return
 * value — so a wiring bug that drops every decision would run for months in
 * perfect silence.
 *
 * This module is the answer to that. Every outcome is counted, everything that
 * is not a clean write or a benign repeat is logged with the field or SQLSTATE
 * that explains it, and a one-line summary is printed whether or not anything
 * went wrong. What it never does is change the exit code: reporting a problem
 * and failing the run are different things, and only one of them is this
 * layer's business.
 */

export interface PublishLog {
  line(message: string): void;
  error(message: string): void;
}

export interface PublishSummary {
  /** Rows the projection accepted. */
  readonly published: number;
  /** Already present — a repeat of a write that had already landed. */
  readonly duplicate: number;
  /** Everything the projection would not take, by outcome. */
  readonly rejected: Readonly<Record<string, number>>;
  /** Rows this module declined to send, with a reason each. */
  readonly skipped: readonly string[];
  /** True when the publisher was not configured, so nothing was attempted. */
  readonly disabled: boolean;
  /**
   * Set when the artifact was refused before anything was sent — a dry run, a
   * failed identity check, a file that does not pass its own integrity check.
   *
   * Distinct from an empty `rejected`, and the distinction matters to a caller
   * that exists only to publish: nothing being written because there was
   * nothing to write is success, while nothing being written because the file
   * was turned away is not.
   */
  readonly gateRefusal: string | null;
}

/**
 * How long the whole publication may take before it gives up.
 *
 * The projection is documented as unable to halt a run, and a bounded failure
 * is the only version of that which is true. Returning a typed outcome instead
 * of throwing covers a database that says no; it does nothing about one that
 * says nothing at all, and an unbounded await inside a fire is a stalled fire,
 * a stalled watch tick, and a night that quietly stops.
 *
 * The deadline is generous against the real shape of the work — a fire is on
 * the order of forty writes at four in flight — and small against the fire's
 * own timeout, so a projection that has stopped answering costs one tick's
 * delay rather than the night. Racing does not cancel the underlying request;
 * it stops this module waiting on it, which is the property being bought.
 */
export const PUBLICATION_DEADLINE_MS = 45_000;

/** No single write may hold the whole budget. */
export const PER_WRITE_TIMEOUT_MS = 10_000;

/**
 * The clock the deadline is measured on — MONOTONIC, not wall-clock.
 *
 * `Date.now` moves backwards: an NTP correction, a host suspend and resume, an
 * operator setting the clock. A backward step during publication pushes the
 * budget's expiry away, so `spent()` stops ever returning true and the only
 * remaining bound is the per-write cap — which for a fifteen-game slate is tens
 * of minutes rather than the forty-five seconds this module advertises. The
 * budget only ever computes differences, so nothing here wants a wall time.
 *
 * Exported so a test can hold the property rather than the wiring: the default
 * must not be readable from `Date.now`, whatever `Date.now` is made to say.
 */
export const publicationNowMs = (): number => performance.now();

/**
 * The clock and the bounds, injectable so the suite can prove them.
 *
 * A deadline no test exercises is a comment, and this one is load-bearing: it
 * is the difference between "the projection cannot halt a run" being a property
 * and being a wish.
 */
export interface PublishTiming {
  readonly nowMs?: () => number;
  readonly deadlineMs?: number;
  readonly perWriteTimeoutMs?: number;
}

class Timeout extends Error {}

/**
 * What is left of the publication's time, and how much of it one write may have.
 *
 * A budget consulted only at the top of a unit of work is not a budget: the last
 * unit admitted still runs to its own timeout, and a decision is three writes
 * deep. Measured at twelve times the configured deadline, with nothing reported
 * as abandoned. `slice()` hands out no more than remains, so the deadline binds
 * the final write as tightly as the first.
 */
class Budget {
  abandoned = 0;

  constructor(
    private readonly nowMs: () => number,
    private readonly expiresAt: number,
    private readonly perWrite: number,
  ) {}

  /** True once the budget is gone, counting the work being turned away. */
  spent(): boolean {
    if (this.nowMs() < this.expiresAt) return false;
    this.abandoned += 1;
    return true;
  }

  /** The timeout for the next write: the per-write bound, or the remainder. */
  slice(): number {
    return Math.max(1, Math.min(this.perWrite, this.expiresAt - this.nowMs()));
  }
}

/**
 * Run one write, and answer for it whatever happens.
 *
 * A port that rejects and a port that never settles are both reported as
 * `unavailable`, which is what they are from here — the row did not land and
 * the run must continue. The documented port never rejects; this does not rely
 * on that being true of every implementation, because the cost of being wrong
 * is a benchmark night.
 */
async function settle(
  write: () => Promise<PublishOutcome>,
  timeoutMs: number,
): Promise<PublishOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      write(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout('write did not settle')), timeoutMs);
      }),
    ]);
  } catch (error) {
    return {
      outcome: 'unavailable',
      detail: error instanceof Timeout ? `no answer within ${timeoutMs}ms` : describeError(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * At most this many writes in flight.
 *
 * Matches the pool, which is itself below the writer role's connection limit.
 * Each serialized write checks out a dedicated connection for the length of a
 * lock plus a statement, so more concurrency here buys queueing inside the pool
 * at best and a connection-limit refusal at worst — and that refusal arrives as
 * a fail-soft `unavailable`, i.e. as a silently missing row.
 */
const IN_FLIGHT = 4;

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += IN_FLIGHT) {
    await Promise.all(items.slice(start, start + IN_FLIGHT).map(run));
  }
}

class Tally {
  published = 0;
  duplicate = 0;
  readonly rejected: Record<string, number> = {};
  readonly skipped: string[] = [];
  disabled = false;
  gateRefusal: string | null = null;

  /** Records an outcome, and returns whether the write landed (or already had). */
  record(outcome: PublishOutcome, what: string, log: PublishLog): boolean {
    switch (outcome.outcome) {
      case 'published':
        this.published += 1;
        return true;
      case 'duplicate':
        // Not a problem, and not silence either: a re-published artifact is
        // expected to be almost entirely duplicates, which is the signal that
        // recovery worked rather than that it did nothing.
        this.duplicate += 1;
        return true;
      case 'disabled':
        this.disabled = true;
        return false;
      default:
        this.rejected[outcome.outcome] = (this.rejected[outcome.outcome] ?? 0) + 1;
        log.error(`serving projection refused ${what}: ${detail(outcome)}`);
        return false;
    }
  }

  summary(): PublishSummary {
    return {
      published: this.published,
      duplicate: this.duplicate,
      rejected: { ...this.rejected },
      skipped: [...this.skipped],
      disabled: this.disabled,
      gateRefusal: this.gateRefusal,
    };
  }
}

/** Everything the outcome knows about why, so a reader can fix the producer
 *  rather than bisect a payload. */
function detail(outcome: PublishOutcome): string {
  switch (outcome.outcome) {
    case 'contradiction':
      return `contradiction on ${outcome.field} — the stored row disagrees, and nothing was written`;
    case 'invalid_input':
      return `invalid_input ${outcome.reason} on ${outcome.field}`;
    case 'attempt_not_eligible':
      return `attempt_not_eligible (${outcome.reason})`;
    case 'parent_missing':
      return 'parent_missing — the row it hangs off was never written';
    case 'refused':
      return `refused ${outcome.sqlstate}${outcome.constraint === null ? '' : ` on ${outcome.constraint}`}: ${outcome.detail}`;
    case 'unavailable':
      return `unavailable: ${outcome.detail}`;
    default:
      return outcome.outcome;
  }
}

/**
 * Publish a plan.
 *
 * Attempts first, all of them, then decisions — a seal resolves the provider
 * call it cites, and the measured failure of getting this wrong was three
 * markets sealed together landing one: the losers' inserts were skipped while
 * their snapshot, taken before the winner committed, could not yet see the
 * call. Once the attempts are committed the decisions are independent, and
 * within one decision the reveal and the rationale hang off the seal, so those
 * three go in order.
 */
export async function publishPlan(
  port: BenchmarkServingPort,
  plan: ProjectionPlan,
  log: PublishLog,
  timing: PublishTiming = {},
): Promise<PublishSummary> {
  const nowMs = timing.nowMs ?? publicationNowMs;
  const deadlineMs = timing.deadlineMs ?? PUBLICATION_DEADLINE_MS;
  const perWriteTimeoutMs = timing.perWriteTimeoutMs ?? PER_WRITE_TIMEOUT_MS;
  const tally = new Tally();
  tally.skipped.push(...plan.skipped);

  // One budget for the whole publication, and it has to bind EVERY write rather
  // than every group of them.
  const budget = new Budget(nowMs, nowMs() + deadlineMs, perWriteTimeoutMs);

  await inBatches(plan.attempts, async (attempt) => {
    if (budget.spent()) return;
    const what = `attempt ${attempt.participant.participantId} / ${attempt.gameId} / ordinal ${attempt.facts.attemptOrdinal}`;
    tally.record(await settle(() => port.publishAttempt(attempt), budget.slice()), what, log);
  });

  await inBatches(plan.decisions, async (decision) => {
    if (budget.spent()) return;
    await publishDecision(port, decision, tally, log, budget);
  });

  const abandoned = budget.abandoned;

  if (abandoned > 0) {
    // Loud, and recoverable: everything the projection did not take is still in
    // the artifact, and republishing that file is a no-op for the rows that did
    // land. Silence here would read as a complete publication.
    const reason =
      `${abandoned} write(s) abandoned — the projection did not finish within ` +
      `${deadlineMs}ms. Republish this run's artifact to complete it.`;
    tally.skipped.push(reason);
    log.error(`serving projection: ${reason}`);
  }

  return tally.summary();
}

async function publishDecision(
  port: BenchmarkServingPort,
  decision: ProjectedDecision,
  tally: Tally,
  log: PublishLog,
  budget: Budget,
): Promise<void> {
  const { seal, reveal, rationale } = decision;
  const what = `${seal.participant.participantId} / ${seal.gameId} / ${seal.market}`;

  // The reveal write carries no drift check of its own, so a reveal that
  // disagrees with its seal is stored without complaint and the commitment is
  // unverifiable from then on with nothing reporting it. Doing the verifier's
  // job here is the only place a transposed pair or a dropped quantiser can be
  // caught, and a decision that fails it is not published at all — half of an
  // inconsistent pair is worse than neither.
  if (!revealMatchesSeal(decision)) {
    tally.skipped.push(`decision ${what}: the reveal does not reproduce its own commitment`);
    log.error(
      `serving projection SKIPPED ${what}: recomputing the digest from the reveal did not ` +
        'match the seal. This is a producer bug — nothing was published for this decision.',
    );
    return;
  }

  // The budget binds each of the three, not just the decision as a whole.
  if (!tally.record(await settle(() => port.sealDecision(seal), budget.slice()), `seal ${what}`, log)) return;
  if (budget.spent()) return;
  tally.record(await settle(() => port.revealDecision(reveal), budget.slice()), `reveal ${what}`, log);
  if (rationale !== null) {
    if (budget.spent()) return;
    tally.record(
      await settle(() => port.publishRationale(rationale), budget.slice()),
      `rationale ${what}`,
      log,
    );
  }
}

/**
 * Read a written run artifact and mirror it onto the projection.
 *
 * The single entry point, used both by a fire publishing the file it has just
 * written and by an operator republishing one from months ago. That is the
 * point: the artifact is the canonical record and the projection is a view of
 * it, so a recovery is not a different code path with different values, it is
 * the same call on the same bytes.
 *
 * Reading the file back rather than hashing the in-memory records is
 * deliberate. The writer redacts on the way out, so the array and the file are
 * not the same bytes whenever a credential appears in a response — and it is
 * the file a reader can check. It also means nothing is published until the
 * artifact is durable, which turns a crash between two writes into a command
 * someone can re-run instead of a permanent hole.
 */
export async function publishRunArtifact(
  port: BenchmarkServingPort,
  runFile: string,
  log: PublishLog,
): Promise<PublishSummary> {
  const refuse = (reason: string): PublishSummary => {
    log.line(`serving projection: skipped this run (${reason})`);
    return {
      published: 0,
      duplicate: 0,
      rejected: {},
      skipped: [reason],
      disabled: false,
      gateRefusal: reason,
    };
  };

  let text: string;
  try {
    text = readFileSync(runFile, 'utf8');
  } catch (error) {
    return refuse(`the artifact could not be read (${describeError(error)})`);
  }

  // Integrity BEFORE anything else reads the file, and answered by the scorer's
  // own reader rather than by this module's. See verifyArtifactIntegrity.
  //
  // Guarded, because a corrupt artifact is a file to REFUSE and not a command to
  // crash. The verifier re-hashes the frozen bundle, and canonicalisation throws
  // rather than returning on two shapes a file can actually hold — both measured
  // end to end against a real fired artifact:
  //
  //   a number that overflows a double (`1e400` parses to Infinity, and the
  //   schema's validators accept it)  -> Error, non-finite number
  //   JSON nested about ten thousand deep under the passthrough bundle
  //                                    -> RangeError, call stack exceeded
  //
  // Either one used to leave this function through the gap between the two
  // existing catches, which on `yarn project` printed a stack under exit 5 and
  // in a fire would have been counted as a lost game.
  let broken: string | null;
  try {
    broken = verifyArtifactIntegrity(text);
  } catch (error) {
    broken = `the artifact could not be verified (${describeError(error)})`;
  }
  if (broken !== null) return refuse(broken);

  let records: readonly Parameters<typeof publishableRun>[0][number][];
  try {
    records = parseRunArtifact(text);
  } catch (error) {
    return refuse(describeError(error));
  }

  const gate = publishableRun(records);
  if (!gate.publishable) return refuse(gate.reason);

  const source: SourceRef = {
    // The basename, never the full path: an absolute path here is an
    // operator's home directory, written into a database whose rows are
    // destined for a public page, and redaction knows nothing about usernames.
    // The artifact's filename already identifies it uniquely.
    sourcePath: basename(runFile),
    sourceSha256: sha256Hex(text),
  };

  const plan = projectRun(records, gate.header, source, { now: () => new Date().toISOString() });
  const summary = await publishPlan(port, plan, log);
  log.line(describeSummary(summary));
  for (const reason of summary.skipped) log.line(`  not published — ${reason}`);
  return summary;
}

/**
 * The same publication, from a path where the projection must never be the
 * reason a benchmark night failed.
 *
 * ── WHY publishRunArtifact IS NOT ALREADY SAFE TO CALL FROM A FIRE ───────────
 * It is fail-soft about the DATABASE — every port method returns a typed outcome
 * and `settle` converts a rejection or a silence into `unavailable`. It is not
 * total about ITSELF. Reading, integrity-checking, parsing and PROJECTING the
 * artifact all happen before any port method is reached, and `projectRun` is not
 * inside a try. Neither is the summary line at the end, and a log sink can
 * throw: `printLine` writes to stdout, and stdout raises EPIPE when the run is
 * piped into something that exits first.
 *
 * On `yarn project` a throw is correct and wanted — the command's own catch
 * reports `crashed`, and the answer is to read the stack. Inside a fire it is
 * not. The artifact is already written and the benchmark run SUCCEEDED; a throw
 * here would unwind into the watcher's per-game handler, be recorded in the
 * ledger as a fire error, count against `summary.failed`, and turn `--once` into
 * a non-zero exit. A projection defect would present as a lost game.
 *
 * ── WHY IT RETURNS null RATHER THAN AN EMPTY SUMMARY ─────────────────────────
 * A crash can land after rows have been written, so `{published: 0, ...}` would
 * be a measurement this function did not make. `null` says the counts are
 * unknown, which is the only true thing available. The reason is logged either
 * way, and the recovery is the same one line of `yarn project`.
 */
export async function mirrorRunArtifact(
  port: BenchmarkServingPort,
  runFile: string,
  log: PublishLog,
): Promise<PublishSummary | null> {
  try {
    return await publishRunArtifact(port, runFile, log);
  } catch (error) {
    try {
      log.error(
        `serving projection: the publisher itself failed (${describeError(error)}). The run ` +
          `artifact is written and complete — republish it with \`yarn project ${basename(runFile)}\`.`,
      );
    } catch {
      // The log sink is the thing that broke. There is nowhere left to report
      // it, and the run still must not fail.
    }
    return null;
  }
}

/**
 * Publish the scores of one scored artifact.
 *
 * The scored sibling of `publishPlan`, under the same budget discipline: one
 * budget for the whole publication, consulted before EVERY write. Score rows
 * are independent of each other — each resolves its own decision — so there is
 * no phase ordering here, just batches at the pool's own width.
 */
export async function publishScores(
  port: BenchmarkServingPort,
  scores: readonly DecisionScore[],
  log: PublishLog,
  timing: PublishTiming = {},
): Promise<PublishSummary> {
  const nowMs = timing.nowMs ?? publicationNowMs;
  const deadlineMs = timing.deadlineMs ?? PUBLICATION_DEADLINE_MS;
  const perWriteTimeoutMs = timing.perWriteTimeoutMs ?? PER_WRITE_TIMEOUT_MS;
  const tally = new Tally();
  const budget = new Budget(nowMs, nowMs() + deadlineMs, perWriteTimeoutMs);

  await inBatches(scores, async (score) => {
    if (budget.spent()) return;
    const what = `score ${score.decision.participantId} / ${score.decision.gameId} / ${score.decision.market}`;
    tally.record(await settle(() => port.publishScore(score), budget.slice()), what, log);
  });

  if (budget.abandoned > 0) {
    const reason =
      `${budget.abandoned} write(s) abandoned — the projection did not finish within ` +
      `${deadlineMs}ms. Republish this scored artifact to complete it.`;
    tally.skipped.push(reason);
    log.error(`serving projection: ${reason}`);
  }

  return tally.summary();
}

/**
 * Read a written scored artifact and mirror it onto the projection.
 *
 * The scored sibling of `publishRunArtifact`, and the same shape on purpose:
 * the artifact is the canonical record, the projection is a view of it, and a
 * recovery republish is this same call on the same bytes. The file is read
 * back rather than trusting anything in memory, so nothing is published until
 * the artifact is durable and `source_sha256` names bytes a reader can check.
 *
 * There is no `verifyArtifactIntegrity` analog here, and that is a property of
 * the artifact rather than a gap: a scored file carries no frozen bundle to
 * re-hash and no seal/reveal pair to reconcile. Its reader IS the gate's
 * schema — the strictest one in the repo for these records, because it is the
 * only one — and everything else it claims is bound to the run artifact the
 * scorer verified before writing it.
 */
export async function publishScoredArtifact(
  port: BenchmarkServingPort,
  scoredFile: string,
  log: PublishLog,
): Promise<PublishSummary> {
  const refuse = (reason: string): PublishSummary => {
    log.line(`serving projection: skipped this scored artifact (${reason})`);
    return {
      published: 0,
      duplicate: 0,
      rejected: {},
      skipped: [reason],
      disabled: false,
      gateRefusal: reason,
    };
  };

  let text: string;
  try {
    text = readFileSync(scoredFile, 'utf8');
  } catch (error) {
    return refuse(`the artifact could not be read (${describeError(error)})`);
  }

  let records: ReturnType<typeof parseScoredArtifact>;
  try {
    records = parseScoredArtifact(text);
  } catch (error) {
    return refuse(describeError(error));
  }

  const gate = publishableScoredRun(records);
  if (!gate.publishable) return refuse(gate.reason);

  const source: SourceRef = {
    // The basename, never the full path — same reasoning as the run path: an
    // absolute path here is an operator's home directory destined for a public
    // page, and redaction knows nothing about usernames.
    sourcePath: basename(scoredFile),
    sourceSha256: sha256Hex(text),
  };

  const summary = await publishScores(port, projectScoredRun(gate.header, gate.decisions, source), log);
  log.line(describeSummary(summary));
  for (const reason of summary.skipped) log.line(`  not published — ${reason}`);
  return summary;
}

/**
 * How many of one file's rows a publish-only command must answer for.
 *
 * FOUR ways such a command fails, and every one of them has to reach the exit
 * code. Its whole contract is that it exists only to publish, so anything
 * short of publishing the artifact is a failure — and a partial success is the
 * most dangerous of them, because it looks like a success to a script and
 * leaves a gap nobody goes looking for.
 *
 *   rejected      the projection would not take a row.
 *   gateRefusal   the file was turned away before anything was sent.
 *   skipped       rows this side declined — work abandoned at the deadline,
 *                 or (on the run path) a reveal that did not reproduce its
 *                 seal. Measured: a run published 16 rows, silently omitted an
 *                 entire model, and exited 0.
 *   nothing       an enabled publisher that wrote no row and found none
 *                 already present did not do the one thing it is for.
 *
 * Shared by `yarn project`, `yarn project:scores` and `yarn score --publish`,
 * because three hand-written copies of a failure taxonomy are three chances
 * for one of them to lose a case. ⚠ The run paths (`watch`, `smoke`) must
 * never consult this — there the projection is a side effect and a missing
 * row must not fail a night.
 */
export function unpublishedCount(summary: PublishSummary, file: string, log: PublishLog): number {
  let failed = Object.values(summary.rejected).reduce((total, count) => total + count, 0);
  failed += summary.skipped.length;
  if (summary.gateRefusal !== null) {
    log.error(`${file}: nothing was published — ${summary.gateRefusal}`);
    failed += 1;
  } else if (summary.published === 0 && summary.duplicate === 0) {
    log.error(`${file}: the publisher is enabled but wrote nothing and found nothing`);
    failed += 1;
  } else if (summary.skipped.length > 0) {
    log.error(
      `${file}: PARTIAL — ${summary.published} written, ${summary.skipped.length} not sent. ` +
        'The projection does not hold this artifact in full.',
    );
  }
  return failed;
}

export function describeSummary(summary: PublishSummary): string {
  if (summary.disabled && summary.published === 0 && summary.duplicate === 0) {
    return 'serving projection: disabled, nothing written';
  }
  const rejected = Object.entries(summary.rejected)
    .map(([outcome, count]) => `${count} ${outcome}`)
    .join(', ');
  const parts = [`${summary.published} written`];
  if (summary.duplicate > 0) parts.push(`${summary.duplicate} already present`);
  if (rejected !== '') parts.push(`REFUSED: ${rejected}`);
  if (summary.skipped.length > 0) parts.push(`${summary.skipped.length} not sent`);
  return `serving projection: ${parts.join(', ')}`;
}
