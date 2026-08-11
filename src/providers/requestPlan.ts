import { applyConfiguration } from '../participantConfiguration.js';
import type { ParticipantConfiguration } from '../participantConfiguration.js';

/**
 * Raised when a configuration names something the per-attempt record carries
 * from OUTSIDE the body — the endpoint, a header-borne API version, a
 * model that travels in the URL. Setting it would put a value in the evidence
 * that never described the request.
 */
export class ConfigurationRecordCollisionError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `participant configuration may not set "${path}": the recorded request evidence carries it from outside the body ` +
        '(the endpoint, a header, or the URL), so a body member of that name would describe a request that was never made',
    );
    this.name = 'ConfigurationRecordCollisionError';
    this.path = path;
  }
}

/**
 * A provider request and the evidence recorded for it, built ONCE.
 *
 * Each adapter used to write its request body and its `requestParams` record
 * separately, by hand, from the same facts. Two hand-written lists of the same
 * thing are not evidence: a knob added to the body and forgotten in the record
 * is invisible, and a knob in the record that never reached the body is a
 * false claim about what was sent. Here the record is DERIVED from the body,
 * so neither can happen.
 *
 * `requestParams` is the body minus its prompt members, plus the endpoint and
 * any parameter that travelled outside the body (a header or the URL). The
 * prompt is excluded because it is recorded once per run against its own
 * hash — repeating it on every attempt would multiply the artifact by the
 * bundle, and the bundle is what the digests already bind.
 */
export interface ProviderRequestPlan {
  /** The URL this request is POSTed to. */
  readonly endpoint: string;
  /** Exactly the JSON body that goes on the wire. */
  readonly body: Record<string, unknown>;
  /** The per-attempt evidence recorded in the artifact. Never carries a credential. */
  readonly requestParams: Record<string, unknown>;
}

export interface RequestPlanSpec {
  endpoint: string;
  /** The cohort-policy body, BEFORE the participant's configuration is merged. */
  body: Record<string, unknown>;
  /** The participant's declared configuration. `{}` leaves the body untouched. */
  configuration: ParticipantConfiguration;
  /** Body members carrying the prompt itself; excluded from the recorded evidence. */
  promptKeys: readonly string[];
  /**
   * Parameters that travel outside the body — in a header or in the URL — and
   * are worth recording. Never a credential: those go in headers the adapter
   * passes straight to the transport and never names here.
   */
  recordedNonBody?: Record<string, unknown> | undefined;
}

/**
 * Build the wire body and its evidence record together.
 *
 * Throws `ConfigurationCollisionError` if the configuration tries to set
 * something the cohort's policy body already set. That refusal is the reason
 * this is a single function rather than a convention: it happens on the real
 * body, so it cannot drift from a hand-maintained list of reserved names.
 */
export function buildRequestPlan(spec: RequestPlanSpec): ProviderRequestPlan {
  // `applyConfiguration` guards keys the BODY already has, and these are not
  // body keys on the providers that record them: the endpoint is a URL,
  // anthropic's API version is a header, gemini's model is in the path. So a
  // configuration naming one of them merged cleanly and then, in the loop
  // below, overwrote the record entry that was supposed to describe it —
  // publishing an endpoint that was never dialled or a model that was never
  // requested, with `configurationEvidenceViolations` confirming it, because
  // the record faithfully echoed the configuration.
  //
  // Refused rather than resolved by precedence: for these names the wire fact
  // lives outside the body, so there is no reading under which a body member
  // is the better answer.
  const recordOnly = new Set(['endpoint', ...Object.keys(spec.recordedNonBody ?? {})]);
  for (const key of Object.keys(spec.configuration)) {
    if (recordOnly.has(key)) throw new ConfigurationRecordCollisionError(key);
  }

  const body = applyConfiguration(spec.body, spec.configuration);
  const prompt = new Set(spec.promptKeys);
  const requestParams: Record<string, unknown> = { endpoint: spec.endpoint };
  for (const [key, value] of Object.entries(spec.recordedNonBody ?? {})) {
    requestParams[key] = value;
  }
  for (const key of Object.keys(body)) {
    if (!prompt.has(key)) requestParams[key] = body[key];
  }
  return { endpoint: spec.endpoint, body, requestParams };
}
