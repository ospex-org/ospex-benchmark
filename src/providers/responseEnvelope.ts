import { z } from 'zod';
import { redactSecrets } from '../config.js';
import { sha256Hex } from '../canonical.js';
import type { ProviderResponseEnvelope } from '../types.js';

/**
 * The evidence-era stamp written into `run_meta.evidenceEra`.
 *
 * It NAMES the era a run was produced under, and that is all it does. It does
 * not decide whether the envelope-presence rule applies: retention is the
 * default, and exemption is earned by `isCoherentPreRetentionArchive` reading
 * the whole file. An earlier build gated presence on this one optional field,
 * so deleting it from a modern artifact switched the rule off — see that
 * function for what replaced it.
 */
export const EVIDENCE_ERA = 'response-envelope-v1';

/**
 * A retained provider response envelope as archived — the ONE definition,
 * imported by every reader of these bytes (the scorer's run parser and the
 * offline search-audit replay).
 *
 * `.strict()` because this is a self-verifying record: the digest is only worth
 * anything if it covers exactly the fields beside it, and a key nobody planned
 * for is bytes nothing checks. The `sha256` pattern and the non-negative
 * integer `bytes` are the same argument for the other two fields — a value that
 * cannot be a digest, or a length that cannot be a length, is a damaged record
 * whatever its JavaScript type.
 *
 * It lives here rather than in either reader because the two DISAGREED while
 * each described itself as agreeing. The scorer refused a whole file over an
 * envelope carrying an extra key; the replay read the same bytes with three
 * bare `typeof` checks, reported the leg as fully replayed and exited 0. One
 * schema with two importers makes that parity structural instead of asserted.
 */
export const responseEnvelopeSchema = z
  .object({
    body: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The three KEYS whose presence places one archived leg in an era.
 *
 * PRESENCE, never value. A `responseEnvelope` explicitly set to `null` is still
 * a key a retaining build wrote, and reading that as "absent" is exactly the
 * downgrade this exists to refuse.
 */
export interface ArchiveEraSignals {
  answerText: boolean;
  rawResponse: boolean;
  responseEnvelope: boolean;
}

/**
 * Read those three facts off a raw archived leg — the parsed JSON object, not a
 * schema's output. A schema that makes a field optional cannot report which
 * name the file actually used, and that is the whole question here.
 */
export function archiveEraSignals(rawLeg: unknown): ArchiveEraSignals {
  const record = asLeg(rawLeg);
  return {
    answerText: Object.hasOwn(record, 'answerText'),
    rawResponse: Object.hasOwn(record, 'rawResponse'),
    responseEnvelope: Object.hasOwn(record, 'responseEnvelope'),
  };
}

/** A raw archived leg as a plain record; `{}` for anything that is not one, so
 *  every key reads as absent rather than throwing. */
function asLeg(rawLeg: unknown): Record<string, unknown> {
  return typeof rawLeg === 'object' && rawLeg !== null && !Array.isArray(rawLeg)
    ? (rawLeg as Record<string, unknown>)
    : {};
}

/**
 * Whether a raw archived leg carried an `httpStatus` KEY at all — presence,
 * never value, and read off the raw record for the same reason the era signals
 * are: an optional field's absence and its explicit `null` are one value in a
 * schema's output, and here they mean opposite things.
 */
export function recordsHttpStatus(rawLeg: unknown): boolean {
  return Object.hasOwn(asLeg(rawLeg), 'httpStatus');
}

/**
 * Whether a run file is a COHERENT PRE-RETENTION ARCHIVE — the one shape exempt
 * from the envelope-presence requirement.
 *
 * Retention is the DEFAULT and exemption has to be asserted by the whole file,
 * because the rule this replaces read a single optional field: deleting
 * `run_meta.evidenceEra` from a modern artifact turned every presence check
 * off, and writing `responseEnvelope: null` on every leg bought the same
 * exemption a different way. Both are one-line edits.
 *
 * A retaining build stamps its era in 2N+1 independent places for N legs — the
 * run's `evidenceEra`, and per leg an `answerText` key and a `responseEnvelope`
 * key — while every pre-#92 build wrote `rawResponse` and neither of the other
 * two. So all three must hold at once:
 *
 *   1. run_meta carries no `evidenceEra`;
 *   2. every leg carries `rawResponse` and no leg carries `answerText`;
 *   3. no leg carries a `responseEnvelope` key at all.
 *
 * Measured over the 47 run files in this repo's `out/` on 2026-08-22: 44
 * separate as coherent archives, 3 as era-stamped, none mixed.
 *
 * WHAT THIS IS NOT. A coherent whole-file rewrite still passes. The envelope is
 * bound to nothing outside the file, so re-sealing an invented body (new text,
 * recomputed `sha256` and `bytes`) verifies clean — and the cheapest known
 * rewrite needs no digest work at all: renaming every `answerText` to
 * `rawResponse`, dropping every envelope key and dropping the stamp is one
 * `sed`, and this predicate then reads the result as a genuine archive.
 * Cross-checking the other modern stamps a rewritten file still carries
 * (`promptScaffoldVersion`, `armRoster`, `watch`, `projection`) would raise
 * that cost further and is NOT done here. What this predicate buys is that no
 * SINGLE field decides the exemption; it is not tamper resistance, and nothing
 * here should be read as claiming it.
 *
 * A file with no legs satisfies clause 2 and 3 vacuously, which changes
 * nothing: with no leg to enforce on, both branches produce the same empty
 * result.
 */
export function isCoherentPreRetentionArchive(run: {
  evidenceEraStamped: boolean;
  legs: readonly ArchiveEraSignals[];
}): boolean {
  if (run.evidenceEraStamped) return false;
  return run.legs.every((leg) => leg.rawResponse && !leg.answerText && !leg.responseEnvelope);
}

/**
 * The fields on one archived leg that say whether a provider response came
 * back. `answerText` covers both archive names for the answer — a reader that
 * consulted only the modern one would exempt every pre-rename leg.
 */
export interface ReceiptSignals {
  answerText: string | null;
  reportedModelId: string | null;
  providerResponseId: string | null;
  /** The status this leg settled on; `null` when it never got one. */
  httpStatus: number | null;
  /**
   * Whether the record carried an `httpStatus` KEY at all — presence, never
   * value. Every build that has ever written a leg wrote this key, so its
   * absence is an edit rather than an era, and it is read fail-closed below.
   */
  httpStatusRecorded: boolean;
  /**
   * The leg's own error text, which on a failed call restates the status in
   * prose. A SECOND carrier of the same fact, in the same record, so no single
   * field decides whether a leg with no content was a receipt.
   */
  errorDetail: string | null;
}

/**
 * The status a leg's own `errorDetail` says it settled on, or `null` when the
 * text does not name one.
 *
 * `ProviderHttpError`'s message is `<provider> returned HTTP <status>: <detail>`
 * and the runner stores it verbatim (redacted), so the status survives in prose
 * beside the numeric field. ANCHORED at the start deliberately: the leading
 * clause is this call's own status, while a later "returned HTTP 200" can only
 * be text a provider echoed back inside a detail, which describes some other
 * exchange.
 */
export function statusFromErrorDetail(errorDetail: string | null): number | null {
  if (errorDetail === null) return null;
  const match = /^\S+ returned HTTP (\d{1,3}):/.exec(errorDetail);
  return match === null ? null : Number(match[1]);
}

/** Whether a status is a 2xx — the window in which a body arrived. */
function isSuccessStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/**
 * A response came back AND carried identifying content. Any one of these three
 * is only ever written from a received response, so a leg carrying one but
 * missing recorded evidence has lost that evidence rather than never having
 * had it.
 */
export function reachedProviderByContent(signals: ReceiptSignals): boolean {
  return (
    signals.answerText !== null ||
    signals.reportedModelId !== null ||
    signals.providerResponseId !== null
  );
}

/**
 * A response came back AT ALL — the three content signals, plus every way the
 * record says a 2xx arrived with nothing else to show for it.
 *
 * The status disjuncts are the receipt half of #92's second hole. A 200 whose
 * body did not parse used to be recorded with every content field null, so it
 * was indistinguishable from "nothing came back" and the envelope rule read the
 * second: a discarded 200 exempted itself.
 *
 * THREE CARRIERS, because one was one edit. A reviewer showed that nulling the
 * single `httpStatus` field on such a leg — the exact leg class this rule was
 * added to protect — switched the requirement back off without touching the
 * era stamp. So the same fact is read from every place the record states it:
 *
 *   1. the numeric `httpStatus`, when it is a 2xx;
 *   2. the status `errorDetail` names in prose, when that is a 2xx;
 *   3. the ABSENCE of the `httpStatus` key, read fail-closed — every build
 *      that has written a leg wrote that key (630 of 630 legs across the 47
 *      run files in this repo's `out/`, measured 2026-08-22), so a leg without
 *      it is an edited record and is treated as owing evidence.
 *
 * THE BOUND, since a reviewer will and should look for it: erasing an errored
 * leg still works if all three are rewritten into one consistent story —
 * envelope gone, `httpStatus` null, `errorDetail` silent. That is three fields
 * on one leg rather than one, and it is the same residual as the whole-file
 * rewrite `isCoherentPreRetentionArchive` names. It is not tamper resistance.
 *
 * Deliberately WIDER than `reachedProviderByContent`, and used only by the
 * envelope-presence rule. The sibling rule about recorded request parameters
 * keeps the narrower predicate: extending it is a change to a pre-existing
 * surface, not part of closing this hole.
 */
export function receivedProviderResponse(signals: ReceiptSignals): boolean {
  return (
    reachedProviderByContent(signals) ||
    isSuccessStatus(signals.httpStatus) ||
    isSuccessStatus(statusFromErrorDetail(signals.errorDetail)) ||
    !signals.httpStatusRecorded
  );
}

/**
 * Bind a received response body into retained evidence.
 *
 * Two decisions carry this function, and both are the point of the issue it
 * closes (#92):
 *
 *  - REDACT, THEN DIGEST. `redactSecrets` is exact-value substitution of the
 *    credentials this process holds, and it runs BEFORE the hash so the digest
 *    covers exactly the string that is stored. Digesting the received text
 *    first would bind bytes no artifact contains, and every later verification
 *    would fail on evidence that was never altered.
 *
 *  - DO NOT CANONICALIZE. The stored body is the received text, not a
 *    re-serialization of its parse. Canonicalizing would normalize key order,
 *    whitespace and number formatting — the very details that let an
 *    unrecognized response shape be identified after the fact — so the thing
 *    retained to preserve an unknown shape would arrive already reshaped.
 *
 * Both properties are load-bearing on the way to disk, and the second is the
 * one that actually fires: `writeNdjson` redacts EVERY line it writes, so the
 * stored body meets `redactSecrets` a second time after its digest was taken.
 * Because the seal redacted first, that pass finds nothing left to substitute
 * and the body still reproduces the digest beside it — and sealing an
 * already-sealed body likewise reproduces the same body, digest and length.
 * Both are pinned with a credential present, which is the state the suite would
 * otherwise never reach: only the entry points load `.env`, so redaction is the
 * identity under `yarn test` and a test written credential-free asserts nothing
 * about either.
 */
export function sealResponseEnvelope(receivedBodyText: string): ProviderResponseEnvelope {
  const body = redactSecrets(receivedBodyText);
  return {
    body,
    sha256: sha256Hex(body),
    // UTF-8 length, not character count: a multibyte body's two measures
    // disagree, and the byte count is the one that describes the evidence.
    bytes: Buffer.byteLength(body, 'utf8'),
  };
}

/** Stable reasons a retained envelope failed verification. */
export const ENVELOPE_VIOLATION = Object.freeze({
  DIGEST: 'the retained response envelope does not match its recorded sha256',
  BYTES: 'the retained response envelope does not match its recorded byte length',
} as const);

/**
 * Verify a retained envelope against its own recorded binding. Returns the
 * reasons it fails; an empty array means the stored body reproduces both the
 * digest and the byte count it was stored with.
 *
 * The two checks are not redundant. A same-length edit is invisible to the
 * length check and caught only by the digest; a truncation is caught by both.
 * Reporting them separately says which binding broke.
 */
export function envelopeVerificationFailures(
  envelope: ProviderResponseEnvelope,
): string[] {
  const failures: string[] = [];
  if (sha256Hex(envelope.body) !== envelope.sha256) failures.push(ENVELOPE_VIOLATION.DIGEST);
  if (Buffer.byteLength(envelope.body, 'utf8') !== envelope.bytes) {
    failures.push(ENVELOPE_VIOLATION.BYTES);
  }
  return failures;
}
