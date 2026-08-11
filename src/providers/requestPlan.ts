import { applyConfiguration } from '../participantConfiguration.js';
import type { ParticipantConfiguration } from '../participantConfiguration.js';

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
  const body = applyConfiguration(spec.body, spec.configuration);
  const prompt = new Set(spec.promptKeys);
  const requestParams: Record<string, unknown> = { endpoint: spec.endpoint };
  for (const [key, value] of Object.entries(spec.recordedNonBody ?? {})) {
    requestParams[key] = value;
  }
  for (const key of Object.keys(body)) {
    // The body wins a name clash with a recorded non-body parameter: what went
    // on the wire is the fact, and the other entry is a description of it.
    if (!prompt.has(key)) requestParams[key] = body[key];
  }
  return { endpoint: spec.endpoint, body, requestParams };
}
