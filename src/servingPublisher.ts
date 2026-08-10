import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { sha256Hex } from './canonical.js';
import { parseRunArtifact, projectRun, publishableRun, revealMatchesSeal } from './servingProjection.js';
import type { ProjectedDecision, ProjectionPlan } from './servingProjection.js';
import type { BenchmarkServingPort, PublishOutcome, SourceRef } from './servingStore.js';

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
): Promise<PublishSummary> {
  const tally = new Tally();
  tally.skipped.push(...plan.skipped);

  await inBatches(plan.attempts, async (attempt) => {
    const what = `attempt ${attempt.participant.participantId} / ${attempt.gameId} / ordinal ${attempt.facts.attemptOrdinal}`;
    tally.record(await port.publishAttempt(attempt), what, log);
  });

  await inBatches(plan.decisions, async (decision) => {
    await publishDecision(port, decision, tally, log);
  });

  return tally.summary();
}

async function publishDecision(
  port: BenchmarkServingPort,
  decision: ProjectedDecision,
  tally: Tally,
  log: PublishLog,
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

  if (!tally.record(await port.sealDecision(seal), `seal ${what}`, log)) return;
  tally.record(await port.revealDecision(reveal), `reveal ${what}`, log);
  if (rationale !== null) {
    tally.record(await port.publishRationale(rationale), `rationale ${what}`, log);
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
  const text = readFileSync(runFile, 'utf8');
  const records = parseRunArtifact(text);

  const gate = publishableRun(records);
  if (!gate.publishable) {
    log.line(`serving projection: skipped this run (${gate.reason})`);
    return { published: 0, duplicate: 0, rejected: {}, skipped: [gate.reason], disabled: false };
  }

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
