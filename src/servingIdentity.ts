import { ARMS } from './providers/index.js';
import type { ParticipantKind } from './servingStore.js';

/**
 * Who appears on the serving projection, and under what name.
 *
 * ── ONE PARTICIPANT PER ARM, NOT PER LAB ─────────────────────────────────────
 * A participant is a MODEL AS RUN — `openai-gpt-5.6-sol` — and its vendor is a
 * separate column. It is not the lab.
 *
 * That is a requirement rather than a preference, and it is structural. Every
 * key in the projection is scoped by participant: the roster is
 * (cohort, participant), an attempt is (cohort, participant, game, ordinal), a
 * decision is (cohort, participant, game, market). Make the participant a lab
 * and two models from that lab cannot coexist in one cohort at all — the second
 * one's roster row contradicts the first's arm id, its provider call collides
 * with the first's, and its picks are refused. Running two models from the same
 * lab against each other is exactly the kind of comparison this benchmark is
 * for, so the participant has to be the thing being compared.
 *
 * Grouping by lab is not lost, it just comes from `labId`. A leaderboard rolls
 * up by lab with a GROUP BY rather than by having thrown the distinction away
 * at write time — and the distinction cannot be recovered once discarded, while
 * the rollup can always be computed.
 *
 * ⚠ The schema's own column comment still describes the older reading, giving
 *   `lab-anthropic` as the worked participant id and calling `arm_id` the
 *   version-scoped one. Nothing enforces it — `participant_id` is a bare text
 *   primary key — but that comment needs correcting where it lives, or the next
 *   reader will implement the model this file deliberately does not.
 *
 * What a version bump costs, stated plainly: a new model is a NEW participant,
 * so a lab's history does not accumulate under one row. For a benchmark that
 * measures models that is the honest answer — pooling one model's closing-line
 * value with its successor's would report a number neither of them earned — and
 * the lab-level view is a GROUP BY away.
 *
 * ── ONE PARTICIPANT PER COMPETING CONFIGURATION ──────────────────────────────
 * The rule generalises past "one per model", and deliberately so. The same
 * model run at two reasoning levels is two things being compared, so it is two
 * participants: `participantId` is whatever the runner dispatches as a distinct
 * arm, and every projection key is scoped by it. Supporting that needs no
 * change here — a second entry in `ARMS` and a second entry below, and the two
 * variants get their own roster rows, provider calls and picks.
 *
 * **The id is a KEY, not a data structure.** It has to be unique and stable and
 * nothing else; do not parse a configuration out of it. Which knob was turned
 * belongs in queryable columns, and the labs do not agree on what the knobs are
 * called — one exposes a reasoning level, another a thinking budget, another an
 * effort setting. That inconsistency is expected and must not be normalised
 * away at write time, because a normalisation is a permanent claim of
 * equivalence between settings nobody can defend as equal.
 *
 * ⚠ There is no column for those traits yet, and adding one is a schema change
 *   in the repo that owns these tables — NOT this file. Two things to know
 *   before that lands, both of which argue for deciding it before the first
 *   live write rather than after:
 *
 *     - a participant row is insert-once and this writer holds no UPDATE, so a
 *       row created without traits cannot be given them later by anything this
 *       code can do;
 *     - numbered generic columns (`custom1`, `custom2`) plus a mapping table
 *       are the shape to avoid. The slot carries no meaning without the map,
 *       nothing enforces that the two agree, and a mapping that drifts silently
 *       relabels published rows. A key/value column keeps the name attached to
 *       the value, so `{"reasoning": "high"}` still means that in five years.
 *
 *   When the column exists, a `traits` field goes on the entries below and
 *   flows through `ParticipantFacts`.
 *
 * ── WHY EVERY VALUE HERE IS A FROZEN LITERAL ─────────────────────────────────
 * These four columns are written once, globally, by whichever run reaches a
 * participant first, and the writer holds no UPDATE. A later write supplying
 * anything different is not merely ignored — it is reported as a contradiction
 * and the whole write is dropped, the decision row included. So a derivation is
 * the hazard rather than the convenience: any edit to a rule that computes a
 * display name would block every future write for that participant, in every
 * cohort, with nothing thrown. A literal cannot drift.
 *
 * The stored name is a sensible default rather than a constraint on what anyone
 * sees. A reader can compose any label it likes from `labId` and `arm_id`
 * alongside it, and change that daily; the row cannot be touched.
 *
 * ⚠ APPEND ONLY. Add entries; never edit one that has been published.
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
   * The exact model string this participant requested, recorded per cohort.
   *
   * Distinct from `participantId`, which names the arm across every cohort it
   * ever runs in. Null means the version is a property of the RUN rather than
   * of the participant — the case for the controls, whose version is the
   * baseline policy the run derived them under. Resolve with `armIdFor`.
   */
  readonly armId: string | null;
}

/**
 * The models, keyed on the runner's own participant id.
 *
 * Two entries may share a `labId`; nothing here or in the schema prevents it,
 * and the conformance suite proves the database admits it.
 */
const MODELS: Readonly<Record<string, ProjectionParticipant>> = Object.freeze({
  'openai-gpt-5.6-sol': model('openai', 'GPT-5.6 Sol', 'gpt-5.6-sol'),
  'anthropic-claude-fable-5': model('anthropic', 'Claude Fable 5', 'claude-fable-5'),
  'google-gemini-3.1-pro-preview': model('google', 'Gemini 3.1 Pro Preview', 'gemini-3.1-pro-preview'),
  'xai-grok-4.5': model('xai', 'Grok 4.5', 'grok-4.5'),
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
function model(labId: string, displayName: string, armId: string): ProjectionParticipant {
  return Object.freeze({ participantId: '', kind: 'model' as const, labId, displayName, armId });
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
          armId: null,
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
 * The roster's per-cohort version: the exact model string a model requested, or
 * for a control the baseline policy the run derived it under — a policy bump is
 * a control's version change the way a new model release is an arm's.
 */
export function armIdFor(
  participant: ProjectionParticipant,
  baselinePolicyVersion: string | null,
): string | null {
  return participant.armId ?? baselinePolicyVersion;
}

/** Every lab with at least one enrolled arm. What a lab-level view groups on. */
export function enrolledLabs(): string[] {
  const labs = new Set<string>();
  for (const entry of Object.values(PROJECTION_PARTICIPANTS)) {
    if (entry.labId !== null) labs.add(entry.labId);
  }
  return [...labs].sort();
}

/** The runner's roster, for a test that must not restate the arm list. */
export const ENROLLED_ARM_IDS: readonly string[] = ARMS.map((arm) => arm.participantId);
