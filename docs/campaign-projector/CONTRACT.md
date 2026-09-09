# Campaign projector contract v1 — PR1 freeze

**Contract only. Not a producer, adapter, migration, executable projector, execution
approval, or activation.** Nothing here changes existing consumers. JSON Schema
2020-12 describes proposed canonical **inputs**; schema-valid is not verified,
entry-eligible, scoreable, publicly safe, or authorized to spend. Fixtures are
synthetic contract examples, not exported fires or evidence of live parity.

## Authority and scope

Baseline: `2c2c05b9aa9e086c3ecf594d0c8f9b131f167044` (`ospex-benchmark`).
Read these named owners at that commit; PR1 neither imports nor replaces them:

| Authority | Contract fact |
| --- | --- |
| `src/fireArtifactProducer.ts`, `src/fireArtifactWriter.ts` | Strict `FireArtifactV1`; retained scoped request; arm/baseline/market evidence; parse plus replay verification, not schema alone. |
| `src/fireArtifact.ts` | Exact arm outcome enum, sent-attempt evidence, accepted response linkage, fingerprint, `armDigest`, market order. |
| `src/schema.ts`, `src/types.ts` | Accepted response versions 1 (replay) and 2; complete forecast including probabilities, rationale, evidence references and v2 analysis. |
| `src/manifest.ts`, `src/canonical.ts`, `src/manifestPublication.ts`, `src/preparedFire.ts` | Strict manifest; cohort content hash; public precommitment evidence; fire/run derivation. |
| `src/spendEscalationSidecar.ts`, `src/verifySpendSidecar.ts` | Separate attempt-level cost evidence; exact pair binding and recomputation; absence is not zero. |
| `docs/SPEC-line-open-evidence-model.md` §§1–6 | Per-market opening evidence, timing/entry eligibility, failed-arm denominator, independent coverage, pinned policy. |
| `src/projectRunMain.ts`, `src/servingProjection.ts`, `src/scoreRun.ts` | Legacy NDJSON consumers, not campaign readers. |

Read-only MVE export authority: `5e45d647b3829f6aa90359a4edf8aa3cc5e40cb2`,
`execute.py`, `postgame.py`, `publish_serving.py`, `SHARED-INVARIANTS.md`; export
hashes are in the author RESULT (not an installed-runtime inspection).

This freezes one complete fire projection envelope, four canonical row families,
source references, states, and invariants. It does **not** define scoring results,
execution receipts, coverage summaries, store tables, transport, SQL, provider
calls, or a new response validator. Baselines are distinct deterministic rows,
never fabricated model forecasts. Future changes to this contract require a new
version, not extra keys silently accepted by v1.

## Envelope and keys

`projection.schema.json` is the closed wire-shape definition. All keys are required
unless explicitly optional in the accepted response's historical shape. Unknown
keys/versions fail. No network `$ref` resolution is needed. The envelope contains:

- `contractVersion = campaign-projector/v1` and `policyVersion = campaign-projector-inputs/v1`.
- `identity`: literal `cohortId`, `fireId`, `runId`, `gameId`, manifest `network`,
  canonical `scopedMarkets`. No generation of an alternative run identifier.
- `sources`: immutable byte references (`uri`, lowercase SHA-256) for manifest,
  fire artifact, optional spend sidecar, origin attestation, and entry assessment.
  URIs are locators, not identity, authorization, or instructions to fetch.
- `origin`: `unattested`, `synthetic`, or `campaign`. Only a separately reviewed,
  bound origin attestation may justify `campaign`; artifact presence, its prompt
  label, public precommitment, and timestamps alone do not prove live execution.
- `revisionKey`: SHA-256 of repo-canonical JSON of exactly
  `{contractVersion, policyVersion, identity, sources}`. This is a projection input
  frontier key, **not** the fire ID, artifact byte hash, or cohort ID. Origin and
  assessment values must be deterministic readings of the cited sources. Pin the
  interpretation implementation with the policy version; never derive facts from
  today's clock, configuration, registry, git tree, or file mtime.
- `arms`: one entry per expected arm, in manifest order, including every failure.
  `armIndex` is its actual index in the immutable fire's `arms`, not a new ordinal.
- `decisions`, `execution`, `scoring`, `serving`: canonical ordered row arrays.
  Their local key is `{participantId, market}`. Their **full** logical key is
  `(cohortId, fireId, runId, network, gameId, participantId, market)` inherited from
  this envelope. A row without its envelope and source set is incomplete.

`cohortId = sha256Hex(canonicalize(strictParsedManifest))`, not the manifest file's
raw byte digest. `sources.manifest.sha256` hashes the actual file bytes, which may
have whitespace; these hashes need not equal. Never substitute a slate day,
`watch-v0-YYYY-MM-DD`, `smoke-v0-YYYY-MM-DD`, directory, or filename for the content
hash. A day may be a display/filter attribute, never a join or deduplication key.

Markets are exactly `moneyline < spread < total`. `spread` maps to
`requestBundle.games[0].markets.runLine`; `runLine` is **not** a market enum.
Moneyline and total map to their same-named blocks. Omitted blocks stay omitted;
one ready market neither waits for nor invents a sibling. Lines/selections/prices
come from the accepted response checked against that exact scoped request;
no home/away line-sign conversion or moneyline null-to-zero normalization occurs
in this contract. Any future protocol-specific conversion belongs to a separately
reviewed execution adapter.

## Accepted body, forecast and rationale mapping

For each `terminalOutcome = valid` arm, `accepted` is mandatory and contains:
`attemptNumber`, `responseSha256`, **exact persisted redacted response text**, and
`parsedResponse` (complete accepted v1/v2 response). Resolve the unique accepted
attempt from `acceptedResponseDigest` **and acceptance evidence**, not “last
attempt”, highest attempt number, newest receipt, or the mere existence of a body.
A valid initial followed by a failed repair is not an accepted repair. Replay via
the existing response owner against retained request/cohort/arm identity; preserve
the accepted version rather than upgrading v1. `responseSha256` is SHA-256 of the
UTF-8 persisted response text, not the JSON serialization of `parsedResponse` and
not the provider `responseEnvelope` digest. Parsing/extraction may handle a wrapped
model answer; do not assume the persisted text is directly `JSON.parse`-able.
The retained provider envelope, its byte length/digest, all failed/initial/repair
attempts, timing, model identity and usage remain reachable through the immutable
fire reference. They are not replaced by this accepted-only view.

A model decision carries `armIndex`, `forecastIndex` into
`parsedResponse.games[0].forecasts`, and an exact complete `forecast` copy:
selection, line, observedDecimal, probabilities, confidence, wouldAbstain,
selectedForExecution, rationale, evidenceRefs, optional reasonCode, and v2
axes/primaryAxis/primaryExpectation. Do not rewrite or infer prose. Preserve
optional-key absence vs null. Game/participant/model/bundle/cohort echoes and
market cardinality must match the fire, manifest and request. Validate probability
coherence, evidence references, axis rules and execution-policy semantics with the
existing response owner; JSON shape alone does not prove these relations.

**Source correction:** at this base, `DecisionFingerprintEntryV1` DOES include
probabilities, confidence and the selection/execution fields (and v2 analysis when
present). It excludes rationale, evidenceRefs and reasonCode. It remains a lossy
repair-preservation projection, NOT an accepted-response reconstruction format.
Neither probability nor prose may be guessed from a fingerprint. Missing or
unverifiable accepted text blocks canonical derivation; never make an otherwise
`valid` arm appear `invalid_schema` merely to get an envelope through validation.

Non-valid arms retain their exact terminal enum and `armDigest`, `accepted = null`,
and one failed model decision per scoped market with null forecast and null
forecast index. Empty `orderedAttempts` means no sent attempts; never synthesize a
sent attempt or turn a gate refusal into a paid response. Shape-invalid source
fires are quarantined/reported outside these canonical rows, not dropped or
partially reinterpreted as ordinary failed arms.

## Four canonical row contracts

All array indices are zero-based, nonnegative safe integers. Order decisions by
manifest model-arm order, then baseline participant ID (code-point order), each in
market order. Execution/scoring/serving use exactly the decision order and one row
per decision, including failed arms and baselines; `decisionIndex` binds the row.
No uniqueness-by-game-only, latest-file-wins or winner-only subset.

| Family | Required content and meaning |
| --- | --- |
| `decisions` | Model-valid: key, kind, terminal outcome, arm/forecast indices, full accepted forecast. Model-failed: same arm provenance and null forecast/index. Baseline: key, `baselineIndex` into fire `baselineDecisions`, policy version and deterministic selection/line/odds/track; no pretend rationale/probabilities or accepted arm. |
| `execution` | Key, decisionIndex, finite `state`, **`authorizesExecution: false`**. This is an evaluation input, not a placement request/receipt. Model selection and wouldAbstain remain the exact independent booleans on its decision. `candidate` means only the contract input prerequisites passed, not wallet, market, cutoff, signer, budget, or approval authorization. Baselines are `baseline_not_executable`; failures are `failed_arm`. |
| `scoring` | Key, decisionIndex, entryEligibility (`eligible/ineligible/unknown`), finite state, **`closeStatus: not_loaded`**. `candidate` still needs independently captured closing evidence, known scoring/uncertainty policies and watermark; it is not a score. Failed/ineligible/unknown rows stay visible. |
| `serving` | Key, decisionIndex, executionIndex, scoringIndex, display (`forecast/failed_arm/baseline`), **`ranking: not_evaluated`**. Resolve forecast/rationale from the same canonical decision, failure from the same arm, spend from this envelope; no fabricated seals, reveal time, deployment round, fills, settlement, scores or rank eligibility. |

`selectedForExecution = true` does not imply entry eligibility or a non-abstention;
`wouldAbstain` is not silently promoted to a new veto or erased. Apply only the
accepted execution policy. Execution state precedence: baseline; failed arm;
`not_selected`; `entry_ineligible`; `entry_unknown`; `origin_unattested` (also
synthetic origin); `spend_blocked`; otherwise `candidate`. Scoring precedence:
failed arm; entry ineligible; entry unknown; otherwise candidate (including
baselines). Model validity is not entry eligibility. Origin and spend do not
rewrite statistical entry eligibility or delete failures from scoring inputs.

Entry assessment is separate, immutable, source-bound evidence for the per-market
opening/dispatch/timing check under the manifest policy. Missing evidence means
`unknown`, never eligible from a well-formed forecast. This PR does not specify
or implement the assessment artifact format or its checker; non-unknown claims
are blocked until a downstream change pins both, and must cite
`sources.entryAssessment`. Provider/store/money policy stays outside PR1.

## Spend and the source frontier

`spend.state` is finite: `absent`, `unverified`, `verified`, `unknown`, `breach`,
`invalid`. `spend.totalUsdMicros` is conservative provider-attempt cost, never stake,
wallet balance, spend reservation, or a provider invoice. Integers are safe and
nonnegative. Null means unknown/not recomputed, not zero. Zero is permitted only
for **verified** evidence with an explicitly recomputed zero total.

- Absent sidecar: source null, state absent, total null. Do not infer free usage.
- Present but not assessed: unverified, total null. A changed byte hash is a new
  frontier; the fire artifact remains immutable and unchanged.
- Verified: exact artifact/sidecar identity and sent-attempt bijection, known
  pricing/reservation pins, and recomputation succeeded; total is explicit.
- Unknown, breach, invalid: retain sidecar source and reason, execution blocked.
  A numerically known breach total may remain visible. An invalid/unknown total
  is null. Never sum nullable fields into zero or use sidecar
  `derivedActualUsdMicros` null/pass as a zero cost; recompute all relevant costs.

The current `verifySpendEvidence` additionally checks crossing-specific cap,
roster and reasoning-observed acceptance. Do not label its entire PASS as a
universal campaign spend predicate. A future pinned assessment policy must name
which checks establish integrity/known cost vs which are crossing acceptance.
PR1's `spend.assessment` is a byte reference plus policy version, not that missing
implementation. `sources.spendAssessment` must equal this reference's source.
No `verified`/`candidate` claim is usable before that policy and format exist.

A sidecar is not part of immutable fire bytes. Record **exact selected sidecar
bytes** (or explicit absence) in the revision. Later sidecar publication or an
assessment upgrade yields another revision, not “duplicate fire, skip”. Conflicting
sidecar candidates require explicit resolution; directory order/mtime is not
recency authority. Do not claim a monotone file exists inside SidecarV1: it has no
sequence or parent field. The future manifest/checkpoint must select the frontier
and compare its expected prior revision; a stale worker cannot overwrite a newer
selected frontier. The earlier revision remains auditable.

## Durable invariants and crash boundary (requirements, not implemented)

1. **Validate before visible state:** strict source formats, known policies,
   digests, manifest publication binding, replay relations, and unique keys all
   pass before any canonical generation can become visible. Keep diagnostics for
   malformed sources; no partially valid fire generation.
2. **Identity conflict:** same `(cohortId, fireId, runId)` with different immutable
   fire bytes is a conflict, not overwrite/duplicate. Same revision key with
   different canonical output bytes is a determinism conflict. Refuse both.
3. **Complete generation:** stage the four families and source set together;
   validate counts/joins; persist files/rows durably; then publish a small atomic
   commit marker referencing every output byte hash. Readers use only complete
   marked generations. A filename or “started” checkpoint is not completion.
4. **Checkpoint ordering:** persist source frontier selection and per-source
   outcomes durably; mark a revision complete only after exact output readback.
   Restart after staging-before-marker retries/cleans orphan staging; restart
   after marker-before-checkpoint recognizes matching hashes as already complete.
   No truncated output, directory mtime scan, or partial upsert is success.
5. **Idempotency:** identical selected input revision produces identical semantic
   rows/canonical bytes and no duplicates. Put retry timestamps/worker IDs outside
   canonical facts. Conditional publication against the expected prior frontier
   fences stale workers. Existing same-key rows are compared byte-for-byte, not
   accepted merely because an insert said “conflict”.
6. **No write authorization:** projector completion never consumes an execution
   claim or proves execution happened. Future execution retains a separate
   durable claim-before-send boundary keyed to the full decision identity; an
   uncertain irreversible effect blocks retry until authoritative reconciliation.
   No fake watch-ledger `decision: fired` row may bridge consumers.
7. **Coverage:** visible failed arms belong to every scoped market denominator.
   A fire cannot prove the independent market universe. Cohort coverage requires
   the separate `odds_history`/games identity derivation under a pinned watermark;
   never freeze cohort completeness/ranking from the first or partial fire.
8. **Public safety:** source URIs may refer to private redacted evidence. Serving
   input is not permission to publish response bodies or local paths. Require an
   independent public-safety/provenance gate and public-safe source references
   before any future publication; no retroactive rewriting of historical receipts.

## Known incompatibilities — explicit downstream work, not workarounds

| Current consumer | Why this contract is not directly consumable |
| --- | --- |
| `projectRunMain.ts` → `servingProjection.ts` | Legacy `run_meta`/bundle/arm/decision NDJSON and projection stamp; `publishableCohortId` accepts only watch/smoke day aliases. Campaign JSON/content cohorts cannot be relabeled to pass it. |
| `scoreRun.ts` | Parses harness NDJSON with `parseRunRecords`/`verifyRunIntegrity`, then fetches closes (currently polygon in this entrypoint). Not a campaign per-market entry/coverage verifier; PR1 runs none of it. |
| MVE `execute.py::scan_intents` (export lines 376–451) | Requires actual watch-ledger fired games, live run_meta, arm_game_response valid, selected decision records; selects moneyline/total only and dedupes `(game, arm, market)` by newest file. No campaign fire provenance, full content identity, spread support, or immutable source frontier. |
| MVE `postgame.py::run_pass` | Operates protocol contest score/settle/claim state and receipts, not benchmark response/closing-line scoring inputs. No execution or settlement receipts can be generated from a forecast. |
| MVE `publish_serving.py` | Resolves fills against existing benchmark decisions/runs and day-cohort roster query (`watch-v0-%`/`smoke-v0-%`, export lines 586–617). Requires actual receipt/public provenance and wallet binding; fire evidence is not a fill. |

No legacy compatibility NDJSON, cohort alias, watch row, adapter, migration,
production import, runtime/config change, provider call or store/money action is
part of this freeze. A later PR must make consumers understand campaign identity
and grain explicitly. No live parity or production readiness is asserted here.

## Finite verification and next implementation gates

Run from repository root:

```sh
python3 -B docs/campaign-projector/test_contract.py -v
git diff --check
```

The test file imports only Python stdlib + `jsonschema==4.26.0` (see
`requirements-test.txt`; install into an isolated review environment if absent).
It validates the
schema, fixture shapes and deliberately malformed mutations. It never imports or
runs production source, opens a store, reads environment/configuration/secrets,
fetches URIs, recomputes real manifests, or builds projections. Schema constraints
cover closed fields/enums/hash shapes, accepted/failure nullability, response
version shapes, explicit spend states, safe integers and non-authorizing outputs.

**Not verified by JSON Schema:** digest truth, accepted parsing, relational joins,
policy correctness, provenance authenticity, cardinality across arrays, uniqueness
by composite key, deterministic derivation, durable publication and crash behavior.
These are mandatory later gates, not validation PASS claims:

| Gate | Minimum adversarial acceptance case |
| --- | --- |
| G1 identity/replay | Recompute all owner digests; wrong manifest/raw digest, substituted fire and foreign cohort fail; day alias never accepted. |
| G2 accepted evidence | Missing body, wrong text hash, two purported accepts, repair ambiguity and fingerprint-only input fail; v1 and v2 retain exact rationale/probability/optional fields. |
| G3 per-market rows | Single spread resolves runLine; partial board stays partial; two same-game different fires remain distinct; missing/duplicate/foreign arm or market fails the generation. |
| G4 failed/eligibility | Zero sent attempts and every terminal failure remain visible; valid but ineligible/unknown entry remains distinct; baseline never becomes model or execution candidate. |
| G5 spend/frontier | Absent ≠ zero; unknown/breach blocks execution; foreign/truncated sidecar fails; later sidecar changes revision without changing fire; stale worker loses compare-and-swap. |
| G6 atomic replay | Crash before marker and after marker/before checkpoint; identical replay no-ops; byte conflict fails; partial family never visible. |
| G7 consumer/public boundary | No watch forgery/day alias; actual campaign adapters separately tested; public-safe source gate and real execution receipt required before publishing fills. |
| G8 scoring/coverage | Close unavailable stays unscored; expected-arm failures retained; independent coverage watermark and full pass precede summary/ranking; no per-fire completeness claim. |

PR1 stops at these documents, schema and synthetic validation tests. It does not
implement a projector or activate a consumer. Merge, implementation and runtime
authority remain separate operator gates.
