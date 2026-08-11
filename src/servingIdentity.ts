import { CONFIGURATION_DIGEST_VERSION, configurationSha256 } from './participantConfiguration.js';
import type { ParticipantConfiguration } from './participantConfiguration.js';
import type { ParticipantFacts, ParticipantKind } from './servingStore.js';

/**
 * Who appears on the serving projection, and under what name.
 *
 * ── ONE PARTICIPANT PER COMPETING CONFIGURATION ──────────────────────────────
 * A participant is a MODEL AS RUN, AT ONE SETTING — its vendor is a separate
 * column and its settings are their own. It is not the lab, and it is not the
 * model line either.
 *
 * That is structural rather than a preference. Every key in the projection is
 * scoped by participant: the roster is (cohort, participant), an attempt is
 * (cohort, participant, game, ordinal), a decision is (cohort, participant,
 * game, market). Make the participant a lab and two models from that lab cannot
 * coexist in one cohort at all — the second one's provider call collides with
 * the first's and its picks are refused. Make it a model line and the same model
 * at two reasoning levels collides with itself. Running either comparison is
 * exactly what this benchmark is for, so the participant has to be the thing
 * being compared.
 *
 * Grouping is not lost, it is deferred: `labId` rolls up by vendor and `modelId`
 * by model line, both with a GROUP BY. A distinction discarded at write time
 * cannot be recovered — these rows are insert-once — while a rollup can always
 * be computed.
 *
 * **The id is a KEY, not a data structure.** It has to be unique and stable and
 * nothing else; do not parse a configuration out of it. Which knob was turned
 * lives in `configuration`, in the lab's own vocabulary, because the labs do not
 * agree on what the knobs are called — one exposes a reasoning level, another a
 * thinking budget, another an effort setting. That inconsistency is expected and
 * is not normalised away, since a normalisation is a permanent claim of
 * equivalence between settings nobody can defend as equal.
 *
 * What a version bump costs, stated plainly: a new model is a NEW participant,
 * so a lab's history does not accumulate under one row. For a benchmark that
 * measures models that is the honest answer — pooling one model's closing-line
 * value with its successor's would report a number neither of them earned.
 *
 * ── WHY EVERY VALUE HERE IS A FROZEN LITERAL ─────────────────────────────────
 * These columns are written once, globally, by whichever run reaches a
 * participant first, and the writer holds no UPDATE. A later write supplying
 * anything different is not merely ignored — it is reported as a contradiction
 * and the whole write is dropped, the decision row included. So a derivation is
 * the hazard rather than the convenience: any edit to a rule that computes a
 * display name would block every future write for that participant, in every
 * cohort, with nothing thrown. A literal cannot drift.
 *
 * ── WHY THIS DUPLICATES `ARMS` INSTEAD OF DERIVING FROM IT ───────────────────
 * `ARMS` is what THIS BUILD dispatches. This is an append-only ledger of every
 * arm that has ever been enrolled, and the difference is what makes recovery
 * possible: republishing a months-old artifact judges it against the arms it
 * actually ran, not against whichever four the current build happens to ship.
 * Deriving this from `ARMS` would make every artifact unpublishable the day a
 * fifth arm is added — and republishing is the ONLY way to recover a write the
 * fail-soft publisher lost.
 *
 * The duplication is held honest by a test rather than by care: every entry in
 * `ARMS` must have an entry here agreeing on provider, model and configuration
 * digest. That test goes red on the build, which is where a mismatch should be
 * found — the alternative is finding it when a night's artifact turns out to be
 * unpublishable.
 *
 * ⚠ APPEND ONLY. Add entries; never edit one that has been published. Changing
 *   what an arm competes at is a NEW participant id, not an edit to an old one —
 *   that is the same rule the database enforces with a unique index over
 *   (lab_id, model_id, configuration).
 */

export interface ProjectionParticipant {
  /**
   * Durable, global, and the same string the runner uses — so a model is one
   * participant, and two models from one lab are two participants.
   */
  readonly participantId: string;
  readonly kind: ParticipantKind;
  /**
   * The vendor, for models only. This is what a lab-level leaderboard groups
   * on.
   *
   * Null on every control, and not by convention: the projection refuses a
   * non-model carrying a lab, because a leaderboard grouped by lab must never
   * bucket a deterministic control under a vendor.
   */
  readonly labId: string | null;
  /** Shown publicly. A model or role label — never a person's name. */
  readonly displayName: string;
  /**
   * The exact model string this participant requests, and one third of the
   * entrant key `(lab_id, model_id, configuration)`.
   *
   * Distinct from `participantId`, which is the arbitrary durable key. Null on
   * a control, which requests no model — the database refuses a non-model that
   * carries one.
   */
  readonly modelId: string | null;
  /**
   * The settings this arm competes under, in the lab's own vocabulary. `{}` is
   * a real value meaning "sets no knobs", and is precommitted and hashed like
   * any other.
   *
   * Null on a control, for the same reason `modelId` is: a deterministic rule
   * has no provider knobs to set, and the database refuses a non-model that
   * declares any.
   */
  readonly configuration: ParticipantConfiguration | null;
  /**
   * The provider that serves this arm, and the response-reported model ids that
   * are acceptable from it.
   *
   * Here so an artifact's identity can be checked against something OTHER THAN
   * ITSELF. The scorer's integrity verifier needs an expected roster, and
   * deriving that roster from the very records it verifies makes the check
   * self-approving: a file declaring an arbitrary requested model under a real
   * participant id passed, and the projector then published that contradictory
   * identity.
   *
   * Null on a control, which makes no provider call.
   */
  readonly provider: string | null;
  readonly approvedReportedModelIds: readonly string[];
}

/**
 * The models, keyed on the runner's own participant id.
 *
 * Two entries may share a `labId`, and two may share a `modelId` while differing
 * in configuration; nothing here or in the schema prevents either, and the
 * conformance suite proves the database admits both.
 */
const MODELS: Readonly<Record<string, ProjectionParticipant>> = Object.freeze({
  'openai-gpt-5.6-sol': model('openai', 'GPT-5.6 Sol', 'gpt-5.6-sol', {}, 'openai', ['gpt-5.6-sol']),
  'anthropic-claude-fable-5': model('anthropic', 'Claude Fable 5', 'claude-fable-5', {}, 'anthropic', ['claude-fable-5']),
  'google-gemini-3.1-pro-preview': model('google', 'Gemini 3.1 Pro Preview', 'gemini-3.1-pro-preview', {}, 'google', ['gemini-3.1-pro-preview']),
  'xai-grok-4.5': model('xai', 'Grok 4.5', 'grok-4.5', {}, 'xai', ['grok-4.5']),
});

/**
 * The deterministic controls, id beside label so the two cannot drift apart.
 *
 * Each name states the MARKET as well as the rule, because the rule is not the
 * same across markets: a moneyline favorite is the shorter PRICE, while a
 * run-line favorite is the side LAYING the runs and the price plays no part in
 * choosing it. One unqualified "Favorite" would publish two different rules
 * under a single public label.
 *
 * The wording follows the participant ids, which are the baseball-shaped names
 * the baseline policy actually mints. A sport whose spread is not a run line
 * would mint its own ids and get its own rows.
 */
const CONTROLS: readonly (readonly [id: string, displayName: string])[] = [
  ['baseline-favorite-ml', 'Moneyline favorite'],
  ['baseline-underdog-ml', 'Moneyline underdog'],
  ['baseline-home-ml', 'Moneyline home'],
  ['baseline-away-ml', 'Moneyline away'],
  ['baseline-over-total', 'Total over'],
  ['baseline-under-total', 'Total under'],
  ['baseline-favorite-rl', 'Run line favorite'],
  ['baseline-underdog-rl', 'Run line underdog'],
];

/**
 * `participantId` is filled in from the key by `PROJECTION_PARTICIPANTS` below,
 * so a durable id can never disagree with the key it is stored under.
 */
function model(
  labId: string,
  displayName: string,
  modelId: string,
  configuration: ParticipantConfiguration,
  provider: string,
  approvedReportedModelIds: readonly string[],
): ProjectionParticipant {
  return Object.freeze({
    participantId: '',
    kind: 'model' as const,
    labId,
    displayName,
    modelId,
    configuration: Object.freeze({ ...configuration }),
    provider,
    approvedReportedModelIds: Object.freeze([...approvedReportedModelIds]),
  });
}

/** Every participant the projection admits, keyed on the runner's id — which
 *  IS the durable participant id, for models and controls alike. */
export const PROJECTION_PARTICIPANTS: Readonly<Record<string, ProjectionParticipant>> =
  Object.freeze(
    Object.fromEntries([
      ...Object.entries(MODELS).map(([id, entry]) => [id, Object.freeze({ ...entry, participantId: id })]),
      ...CONTROLS.map(([id, displayName]) => [
        id,
        Object.freeze({
          participantId: id,
          kind: 'baseline' as const,
          labId: null,
          displayName,
          // A control is a rule, not a model at a setting. The database refuses
          // a non-model that carries either, so both are null rather than a
          // stand-in — and the version a control ran under is a property of the
          // RUN, recorded once as `benchmark_runs.baseline_policy_version`.
          modelId: null,
          configuration: null,
          // A control makes no provider call, so it has no provider identity to
          // check and never appears in an integrity roster.
          provider: null,
          approvedReportedModelIds: Object.freeze([]),
        }),
      ]),
    ]) as Record<string, ProjectionParticipant>,
  );

/**
 * The projection identity for a runner-side participant id, or null.
 *
 * Null means NOT ENROLLED, and an unenrolled participant is not published —
 * never given a name minted at write time. A generated display name is written
 * once and cannot be corrected, so an arm that reaches a run before it reaches
 * this file is better absent from the projection than permanently mislabelled
 * in it. The publisher logs the skip.
 */
export function projectionParticipant(runnerParticipantId: string): ProjectionParticipant | null {
  return PROJECTION_PARTICIPANTS[runnerParticipantId] ?? null;
}

/**
 * The participant row this entry writes.
 *
 * One function rather than a literal at each call site, because the identity is
 * kind-dependent in both directions — a model must declare a model and a
 * configuration, a control must declare neither — and four hand-written copies
 * is four chances to satisfy the first rule while breaking the second. The
 * publisher checks the same pair again before it sends anything; this is what
 * makes that check something the projector cannot fail by omission.
 */
export function participantFacts(entry: ProjectionParticipant): ParticipantFacts {
  return {
    participantId: entry.participantId,
    kind: entry.kind,
    labId: entry.labId,
    displayName: entry.displayName,
    modelId: entry.modelId,
    configuration: entry.configuration,
  };
}

/**
 * The entrant key as the database indexes it, for reporting and for tests.
 *
 * `(lab_id, model_id, configuration)` is unique among models with NULLS NOT
 * DISTINCT, so two registry entries colliding here are two participant ids the
 * database will only ever hold one of.
 */
export function entrantKey(entry: ProjectionParticipant): string {
  return JSON.stringify([
    entry.labId,
    entry.modelId,
    entry.configuration === null ? null : configurationSha256(entry.configuration),
    CONFIGURATION_DIGEST_VERSION,
  ]);
}

/** Every lab with at least one enrolled arm. What a lab-level view groups on. */
export function enrolledLabs(): string[] {
  const labs = new Set<string>();
  for (const entry of Object.values(PROJECTION_PARTICIPANTS)) {
    if (entry.labId !== null) labs.add(entry.labId);
  }
  return [...labs].sort();
}
