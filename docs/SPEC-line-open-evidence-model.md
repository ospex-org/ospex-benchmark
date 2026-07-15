# SPEC — line-open runner: the Tier-0 evidence & measurement model

Status: **PR 0 (spec-only), Tier 0.** Target repo: `ospex-benchmark`. Companion to
`SPEC-line-open-speculation-runner.md` (base spec, committed alongside).

## 0. What Tier 0 is (and what it is not)

**The question Tier 0 answers:**

> Among markets we captured cleanly at their independently-derived opening line, which
> model produced the best closing-line value (CLV)?

Tier 0 is a **statistical instrument with transparent coverage**, not an adversarial
consensus/publication protocol. It fires per-market at the open, records each model's
forecast, captures the close, and reports CLV **with** its coverage, sample size, and
uncertainty. Imperfection is **measured and reported**, not structurally forbidden.

**Retained protections (mandatory).**
1. Each `(gameId, market)` is an independent firing unit.
2. A ready market never waits for a sibling market.
3. Entry timing and the opening quote are checked against `source=jsonodds`
   `odds_history`.
4. Every fire is bound to its own opening quote and scoped market set.
5. A speculation fires **at most once**; duplicate billing and duplicate scoring are
   structural errors.
6. The model/prompt/tool/sampling configuration is frozen for the cohort.
7. Every expected model arm has **exactly one** visible outcome for every fire; failed
   arms cannot be deleted from the denominator.
8. Fired artifacts cannot be silently deleted without reducing independently-derived
   coverage.
9. Coverage, response completion, close availability, sample size, uncertainty, and
   caveats are published **beside** CLV.
10. Paid live execution is staged, explicitly confirmed, and budget-bounded.

**Deliberately deferred to a later adversarial tier** (do not build in Tier 0): the
frozen `games` census and MVCC census builder; per-fire negative-space denominators,
`denominatorSha256`, and `fire_coverage_snapshot`; the `schedule_changed` opening gate;
whole-cohort `canonical-unranked`/salvage poisoning for operational misses; on-chain
Polygon anchoring (post-cohort roots, finality, reorg, sender rules); append-only
schedule history; scheduled-game census completeness; and any binary public-quality
gate.

**Coverage is reported, not poisoning.** Missing two markets operationally does not
discard 40 clean, independently-verified fires. Reserve structural failure for
malformed / duplicated / internally-inconsistent **fired** artifacts, never for an
honestly-reported market that simply never fired.

**Upgrade triggers** (revisit the deferred adversarial controls only when one holds):
the benchmark is marketed as an adversarial public leaderboard; outside agents submit
competing results; money/rewards/protocol-admission/reputation depend on the result; or
a third-party audit requires independently-timestamped publication. Even then, global
coverage stays derived from `odds_history` — a later tier must **not** reintroduce a
per-fire self-reported coverage denominator.

## 1. Ground truth: `odds_history`

`odds_history` is the independent source for both the measurable universe and the
opening/as-of quotes. It is append-only; PK is a surrogate `id`; the writer appends a
row only on a real price/line change (**change-based**), and only when a market is
**two-sided-valid** (one-sided tuples are dropped before the write). Each row carries
`line, away_odds_american, away_odds_decimal, home_odds_american, home_odds_decimal`,
`source ∈ {jsonodds, sportspage_open}`, and a `captured_at` the writer stamps via
`toISOString()` (**millisecond** precision). **All detection/opener/as-of derivations
filter `source = jsonodds`** (the live feed the runner detects from).

Two derivations, both with an explicit `id` tiebreak (equal-ms rows otherwise resolve
server-arbitrarily):
- **First two-sided appearance** of a pair, under a frozen scoring watermark:
  `earliest source=jsonodds row ordered by (captured_at ASC, id ASC)`.
- **As-of quote** at instant `t`:
  `greatest captured_at ≤ t ordered by (captured_at DESC, id DESC), limit 1` — the exact
  live two-sided price at `t` (change-based ⇒ exact).

Comparisons are inclusive and at **millisecond** precision (the writer stamps ms; the
column is µs-capable but never exercised sub-ms). The committed cross-host allowance is
`maxClockSkewMs`; a boundary genuinely ambiguous under it is UNKNOWN, never silently
reclassified.

## 2. The precommitted manifest (no census)

The manifest contains **no game census**. It precommits only the parameters that can
change the statistical sample or model behavior:

```
cohort-manifest {
  artifactSchemaVersion,
  windowStart, windowEnd,             // the precommitted opener-observation window
  source,                            // "jsonodds" + source-query version
  marketPolicyVersion, marketPolicyDigest,   // enabled (league, market) allow-list
  promptScaffoldSha256,
  expectedArmRoster: [ { participantId, provider, requestedModelId, approvedReportedModelIds } ],
  toolInferenceConfigSha256,         // tool permissions + sampling/inference config
  baselinePolicyVersion,
  repairPolicyVersion,
  constants: { ... },                // §6
  runnerCommitSha,
  cohortSpendCap, cohortCallCap,
  scoringPolicyVersion
}
```

`cohortId = sha256Hex(canonicalize(manifest bytes))` (`canonicalize` = the repo's
serializer, `src/canonical.ts`).

**Public-Git precommitment (Tier 0, not on-chain).** The manifest is committed and
pushed to a **public Git repository before `windowStart`**. At runtime, before any
provider call, the runner verifies the local manifest bytes **equal** the bytes at the
supplied public-Git commit. **State the trust boundary plainly: this is a practical
precommitment, not an independently-irreversible timestamp.** No Polygon transactions,
finality checks, reorg handling, or post-cohort on-chain roots in Tier 0.

**Canonical-mode config lock.** Every eligibility-changing value comes only from the
manifest. `windowStart`/`windowEnd` (not `--window-hours`) define the cohort; poll
cadence, caps, timeouts, and output limits come only from the manifest. `--poll-seconds`,
`--timeout-seconds`, `--max-output-tokens`, `--window-hours`, `--late-minutes`,
`--max-fires-per-tick` may remain for **dry-run/rehearsal** only (output labeled
non-cohort); supplying any in canonical mode is a **boot failure** unless byte-equal to
the manifest.

## 3. Detection and firing

For each currently-valid, two-sided, policy-enabled market, per tick:
1. Derive/fetch its independent `firstTwoSided` from `odds_history` (§1).
2. Require `0 ≤ detectedAt − firstTwoSided ≤ W` (within `maxClockSkewMs`). A market
   first observed already `> W` past its `firstTwoSided` is **not fired** — it becomes a
   coverage miss at finalization (§6), never a paid non-clean fire.
3. Build a **fresh** bundle containing exactly the market(s) firing in that dispatch
   (fire-at-detection; the bundle is built from the same `current_odds` snapshot
   detection reads — no capture/dispatch split).
4. Bind each firing market to its actual opening/as-of quote and its `source`
   `odds_history` row identity.
5. Acquire an atomic **at-most-once** claim per `(cohortId, gameId, market)`.
6. Dispatch **all** expected model arms without waiting on unrelated markets. `first_pitch_passed`
   is a **hard no-dispatch condition**: no provider request may start at/after the
   scheduled start carried by that fire's bundle (persisted as `scheduledAtAtFire`).
7. Persist **one** final arm outcome for **every** expected arm.
8. Never retry a claimed speculation in a way that can produce a second paid fire.
   Interrupted claims remain visible operationally and surface as misses/incomplete
   fires in global reconciliation (§6).

**Capacity is bounded, not poisoning.** Deterministic per-tick and cohort call/spend
caps apply (from the manifest). A candidate not admitted is deferred to a later tick; a
market that never cleanly fires within the cohort is a **reported coverage miss**, not a
cohort-poisoning event. The runner reads `games`/current inputs to build the prompt,
identify teams, and enforce `first_pitch_passed` — these are **fire inputs**, not
cohort-membership evidence.

## 4. The fire artifact (no embedded denominator)

Each completed fire artifact retains:
- `cohortId`, manifest hash + public-manifest commit;
- `fireId`, `runId`, `gameId`, the **scoped market set**;
- `detectedAt`, bundle-completion timestamp, per-arm provider request-start timestamps;
- the `source=jsonodds` `odds_history` opener/as-of **row identity** and the exact
  opening quote **for each scoped market**;
- the scoped bundle bytes/hash (**byte-identical in shape to today's bundle**; every
  hard-coded `3` gone — cardinality derives from the scoped market set);
- the exact expected-arm roster/config identity;
- **exactly one** terminal outcome per expected arm (§5 enum);
- accepted-response bytes/digest and **one decision per scoped market** for a valid arm;
- deterministic baseline decisions derived from the **same** scoped bundle; and
- claim/completion linkage sufficient to reject duplicates and incomplete standalone
  artifacts.

There is **no** embedded universe/`Disposition[]` denominator and **no** negative-space
snapshot — coverage is derived globally (§6).

**Claim/fire ledger.** A small append-only ledger records claim → completion for
**at-most-once billing and crash recovery only**. It is operational state, **not** the
source of the coverage denominator. Persistence order: (1) persist the pending claim
(`O_EXCL`); (2) start provider requests within V-lag; (3) persist arm outcomes + run
artifact; (4) mark the claim completed. A crash between steps leaves an interrupted
claim — at-most-once holds (no re-fire), and the pair surfaces as a miss/incomplete fire
in §6, never as a clean entry.

## 5. Per-fire entry verification

For each fire key `(gameId, market)`:
- **exactly one** completed artifact exists;
- fire timing is inside `W` of the independent `firstTwoSided` (V2, within skew);
- the fire's opening quote **equals** the correct `source=jsonodds` as-of quote for its
  `detectedAt` — `(captured_at DESC, id DESC), limit 1` — on `line` + both American odds
  (home-side spread convention) (V1); freshness gap `detectedAt − bundleSnapshotTs ≤
  freshFireMs` (V1b);
- the scoped bundle carries the same quote + market identity;
- no hard-coded three-market assumption; and
- **all** expected arms and their outcomes are present.

A fire that fails entry verification **remains** in the published fire/coverage
accounting but is **excluded from the clean-entry CLV sample** with a typed reason. It
**cannot be silently deleted**.

**Arm-outcome enum (exhaustive, matches code `ArmOutcome` + the V-lag addition).** Every
expected-roster arm has **exactly one** outcome; a *missing* record is an integrity
violation (there is no free absence marker):

| outcome | request sent? | role |
|---|---|---|
| `valid` | sent, validated | the only scoreable decision — one decision per scoped-bundle market |
| `invalid_schema` | sent | valid negative, retained in the denominator |
| `timeout` | sent | valid negative |
| `rate_limited` | sent (429) | valid negative — a throttle must never read as a model failure |
| `provider_error` | sent | valid negative |
| `cutoff_missed` | mixed (sent-late or cutoff-passed-at-dispatch) | valid negative; no decision records |
| `dispatch_lag_exceeded` | **not sent** — first request would start `> maxDispatchLagMs` after `detectedAt` (**V-lag**, measured at the provider HTTP boundary; both operands benchmark-host, no skew) | valid negative |
| `credential_missing` | not sent (should be blocked at boot) | structural — a required arm makes the fire fail integrity |

"Failures never leave the denominator" — a *partial* fire still scores its sent arms;
deleting a bad forecast or a failed arm is a **structural integrity failure**.

## 6. Finalization: the universe + global coverage reconciliation

After `windowEnd + ingestionGraceMs`:
1. Freeze `oddsHistoryWatermark = MAX(odds_history.id)`.
2. For each pair, derive its earliest valid `source=jsonodds` row under the watermark
   using `(captured_at ASC, id ASC)`.
3. Construct the **expected universe** — every policy-enabled `(gameId, market)` whose
   **first** two-sided appearance falls inside `[windowStart, windowEnd)`:

   ```
   U = distinct (gameId, market)
       where windowStart ≤ firstTwoSided.captured_at < windowEnd
         and marketPolicy(league, market) = enabled
   ```

   A reprice inside the window does **not** make a market whose true first appearance
   predates the window a new opener; a first appearance after `windowEnd` (even before
   the grace ends) is **excluded** from `U`. A scheduled game that never gets a valid
   two-sided market has no CLV observation and is **not** a coverage hole.
4. Persist a canonical `universe.ndjson` + metadata (watermark, row count,
   filters/query version, SHA-256) — enough for reproducibility, with **no** mutable
   `games` census.
5. Reconcile `U` with the fire artifacts:

   ```
   F = unique (gameId, market) keys from completed fire artifacts
   C = F entries whose entry verification (§5) passes
   M = U − F                      # missed opportunities
   X = F − U                      # unexpected / extraneous fires
   D = duplicate fire keys        # structural error
   ```

   A co-arrival artifact with two markets contributes **two** independent keys to `F`,
   each with its own entry quote and one-to-one artifact linkage.

**Published coverage:**

```
fireCoverage       = |F ∩ U| / |U|
cleanEntryCoverage = |C ∩ U| / |U|
missed              = M      (with advisory reason breakdown)
extraFires          = X
duplicateFires      = D
```

Runner-supplied miss reasons are **advisory operational diagnostics** only — they never
define membership and are never substituted for the independent `U − F` calculation. A
market in `M` with no trustworthy reason is `unexplained_miss`. A fired key absent from
`U` (`X`) is reported as an extra/invalid fire, **never** silently scored as a cohort
entry.

## 7. Close capture, CLV, and reporting

**Close capture.** Persist `scheduledAtAtFire` in the fire artifact. At close capture,
persist the schedule/cutoff actually used as `scheduledAtAtCloseCapture`, its source
timestamp, and whether it materially differs from `scheduledAtAtFire`. Select the latest
valid two-sided close quote at or before the close-capture cutoff.

**Schedule changes are a scoring-side concern.** A later reschedule does not alter what
line the model saw at the original open — the opening artifact stays valid and is never
rewritten. If a reliable close + cutoff exist, compute CLV but tag the row
`schedule_changed=true`, **exclude it from the primary same-schedule estimate**, and show
it in a separate reschedule-sensitivity stratum. If cancellation/postponement makes the
close ambiguous or unavailable, retain the fire in entry coverage but mark
`close_unavailable` / `schedule_ambiguous` — **do not invent a CLV value**.

**Published counts (side by side):** expected universe; fired; clean entry; valid model
decision by arm; close available; CLV scoreable; schedule-changed sensitivity rows.

**Primary model reporting must include:**
- N and mean economic CLV **by market**;
- the existing margin-adjusted / sensitivity metrics with their policy labels;
- game-clustered uncertainty intervals;
- response / valid-decision rate per arm;
- fire coverage, clean-entry coverage, and close coverage;
- **paired** model differences on the **common scoreable** fires;
- same-schedule primary results and schedule-changed sensitivity results **separately**;
  and
- an explicit statement that estimates are **conditional on captured clean fires** and
  that reported coverage **does not prove missing-at-random** sampling.

**Do not** pool different markets into one primary ranking; **do not** hide models with
zero valid decisions.

## 8. Trust boundary (stated plainly)

Tier-0 integrity rests on: (a) **internal consistency** — recomputable digests
(`requestSha256`, bundle/artifact hashes, the arm digest); (b) **practical
precommitment** — the manifest published to public Git before `windowStart`, verified
byte-equal at runtime; and (c) **independent honesty** — `odds_history` derives the
universe, first appearance, and as-of quotes, so coverage and entry timing are not
self-reported. There is **no** independently-irreversible external timestamp in Tier 0;
that is the acknowledged limit, and it is sufficient for the non-adversarial question
Tier 0 answers. Do not overstate it.

## 9. Sequencing

| PR | Content | `--live` |
|---|---|---|
| **0 — spec** | This Tier-0 governing spec + the base spec. Merge after review. | n/a |
| **1 — runner/artifact** | Per-market no-wait firing, independent claims, fire artifacts, one terminal arm outcome per expected arm, at-most-once + crash linkage; unit + adversarial-fixture tests. | **hard-disabled** |
| **2 — coverage + scoring** | Global `U`/`F`/`C` reconciliation, close capture + CLV + scorecard, rehearsal + restart/failure tests. | **hard-disabled** |
| **3 — live canary** | Explicit, budget-bounded live canary after PRs 1–2 pass complete-stack review — explicit confirmation, pinned spend/call caps, clean credentials, at-most-once claims. | **enabled here only** |

Each PR branches from the then-current `main` after its predecessor merges. "Simpler
evidence" does **not** mean casual paid dispatch.

## 10. Test matrix (Tier-0 acceptance cases)

1. Moneyline opens while total/spread reads hang → moneyline fires without waiting.
2. Three markets open at three times → three independent claims/fires/artifact keys.
3. Co-arriving markets share transport but retain per-market entry quote/linkage.
4. First appearance outside `W` → no fire; a global coverage miss iff its first
   appearance is in the cohort window.
5. Fire artifact deleted → `U` unchanged, coverage decreases.
6. One arm record deleted → fire integrity fails; **not** converted into a lower-N clean
   result.
7. All arms fail → fire remains present; response coverage zero for those arms; no
   survivor deletion.
8. Duplicate claim workers overlap → only one paid dispatch.
9. Crash after claim before completion → no duplicate retry; global report shows
   interrupted/incomplete fire or miss.
10. Pre-window opener reprices during the window → excluded from `U` (first appearance
    predates the window).
11. First appearance inside window with later reprices → **one** universe key, not
    multiple opportunities.
12. Market first appears after `windowEnd` but before scoring grace ends → excluded from
    `U`.
13. Fired key absent from `U` → reported as an extra/invalid fire, never silently scored
    as a cohort entry.
14. One-, two-, three-market scoped bundles → exact dynamic decision cardinality.
15. Schedule changes after fire → opening artifact stays valid; the row goes to the
    reschedule-sensitivity stratum if the close is available.
16. Canceled/ambiguous close → fire stays in entry coverage; CLV unavailable with a typed
    reason.
17. Public manifest commit is after `windowStart`, or the bytes differ → canonical run
    refuses **before** provider calls.
18. Canonical poll/config override differs from the manifest → refuses **before**
    provider calls.
19. Coverage report shows expected/fired/clean/missed/extra/duplicate/close and per-arm
    completion counts.
20. Scorecard states that coverage disclosure does **not** prove missing-at-random
    sampling.
