import { redactSecrets } from '../config.js';
import { sha256Hex } from '../canonical.js';
import type { ProviderResponseEnvelope } from '../types.js';

/**
 * The evidence-era stamp written into `run_meta.evidenceEra`.
 *
 * A run carrying it was produced by a build that retains provider response
 * envelopes, so the scorer may require one on every attempt that reached a
 * provider. A run carrying no stamp predates retention: its attempts are
 * ENVELOPE-UNAVAILABLE, which is reported as unknown rather than backfilled
 * with a "nothing ran" reading the evidence cannot support.
 */
export const EVIDENCE_ERA = 'response-envelope-v1';

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
