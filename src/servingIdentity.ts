import type { ParticipantKind } from './servingStore.js';

/**
 * Who appears on the serving projection, and under what name.
 *
 * ── THE SPLIT THIS FILE EXISTS TO HONOUR ─────────────────────────────────────
 * The projection separates a DURABLE participant from the VERSION it ran, and
 * the runner does not: `ArmSpec.participantId` is `anthropic-claude-fable-5`,
 * one string carrying both. The projection's participant is the thing a
 * leaderboard groups on and must survive a model upgrade, while the version
 * lives on the per-cohort roster row and is expected to change. So a lab is one
 * participant across every model it ever fields, and each model version is an
 * arm id under it.
 *
 * That is the schema's own design, not a preference: `benchmark_participants
 * .participant_id` is documented as stable across model versions with
 * `lab-anthropic` as the worked example, and the roster's `arm_id` as the
 * version-scoped id that "a model deprecation mints a new one of, under the
 * SAME participant_id". Publishing the runner's compound id as the participant
 * would split every leaderboard on the next model release, permanently.
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
 * The frontend is free to render any label it likes over `participant_id` and
 * change it daily. The database row cannot be touched, which is why the stored
 * name is a lab rather than a model's marketing name — nobody renames
 * "Anthropic".
 *
 * ⚠ APPEND ONLY. Add entries; never edit one that has been published.
 */

export interface ProjectionParticipant {
  /** Durable and global. `lab-<vendor>` for a model, the policy id for a control. */
  readonly participantId: string;
  readonly kind: ParticipantKind;
  /**
   * The vendor, for models only.
   *
   * Null on every control, and not by convention: the projection refuses a
   * non-model carrying a lab, because a leaderboard grouped by lab must never
   * bucket a deterministic control under a vendor.
   */
  readonly labId: string | null;
  /** Shown publicly. A role or organisation label — never a person's name. */
  readonly displayName: string;
  /**
   * The version-scoped id for the per-cohort roster row, when the registry
   * knows it. Null means the version is a property of the RUN rather than of
   * the participant — which is the case for the controls, whose version is the
   * baseline policy the run derived them under. Resolve with `armIdFor`.
   */
  readonly armId: string | null;
}

/**
 * Keyed on the RUNNER's participant id — the string that appears in an
 * artifact — and mapping it to the projection's own identity. The key and
 * `participantId` are deliberately different for models and identical for
 * controls, because a control's id is already durable and version-free.
 */
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

const MODELS: Readonly<Record<string, ProjectionParticipant>> =
  Object.freeze({
    'openai-gpt-5.6-sol': Object.freeze({
      participantId: 'lab-openai',
      kind: 'model',
      labId: 'openai',
      displayName: 'OpenAI',
      armId: 'openai-gpt-5.6-sol',
    }),
    'anthropic-claude-fable-5': Object.freeze({
      participantId: 'lab-anthropic',
      kind: 'model',
      labId: 'anthropic',
      displayName: 'Anthropic',
      armId: 'anthropic-claude-fable-5',
    }),
    'google-gemini-3.1-pro-preview': Object.freeze({
      participantId: 'lab-google',
      kind: 'model',
      labId: 'google',
      displayName: 'Google',
      armId: 'google-gemini-3.1-pro-preview',
    }),
    'xai-grok-4.5': Object.freeze({
      participantId: 'lab-xai',
      kind: 'model',
      labId: 'xai',
      displayName: 'xAI',
      armId: 'xai-grok-4.5',
    }),
  });

/**
 * Every participant the projection admits, keyed on the RUNNER's id.
 *
 * A control's durable id IS its runner id — it names a fixed rule, carries no
 * version, and survives a policy bump unchanged — so the key and the
 * `participantId` coincide there and differ for a model.
 */
export const PROJECTION_PARTICIPANTS: Readonly<Record<string, ProjectionParticipant>> =
  Object.freeze({
    ...MODELS,
    ...Object.fromEntries(
      CONTROLS.map(([id, displayName]) => [
        id,
        Object.freeze({
          participantId: id,
          kind: 'baseline' as const,
          labId: null,
          displayName,
          armId: null,
        }),
      ]),
    ),
  });

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
 * The roster's version-scoped id: the registry's when it has one, otherwise the
 * run's baseline policy version, which is the exact analogue for a control — a
 * policy bump is a control's version change, the way a model deprecation is a
 * model's.
 */
export function armIdFor(
  participant: ProjectionParticipant,
  baselinePolicyVersion: string | null,
): string | null {
  return participant.armId ?? baselinePolicyVersion;
}
