# Market-open discovery and scoring — B4.1

Source-only. Nothing installed, scheduled, enabled, or activated.

## Authorized three-PR sequence

B4 uncovered a schema prerequisite, and the operator authorized expanding the
original two-PR plan to three, still one at a time:

1. **This benchmark PR:** completed-evidence discovery/admission, scoring,
   per-market coverage, retained timing and cost/status/version evidence. Explicitly
   block market-open SQL publication; prepare an exact-head R3 handoff and STOP.
2. **Indexer schema prerequisite:** correct the attempt grain for sibling markets
   and add lossless timing/evidence persistence to the serving contract. Define
   migration/capability and anonymous-view contracts before any publisher is enabled.
3. **MVE integration:** scheduler discovery, reveals/writeups and serving publisher,
   initial-plus-repair costs, rationale/seal/reveal hashes, FE ledger status/version,
   replay and **actual anonymous public-view readback** against the migrated schema.

No second/third PR, migration, deployment, scheduler, or public-view write is part
of this handoff. Existing watch/smoke publication and historical replay stay intact.

### Why publication is explicitly blocked

At `ospex-indexer` main `7cc7cf5ec13081f000af5948b7563c3b1e7126cb`, migration 073
makes attempts unique on `(cohort_id, participant_id, game_id, attempt_ordinal)`.
Moneyline and total events in one market-open cohort collide on that key, while
the decision-to-attempt foreign key also binds `run_id`. Neither cohort renaming
nor repurposing attempt ordinals is an acceptable workaround. The current
`DecisionScore`/SQL writer also has no score-timing metadata field. Adding an
unconsumed JSON property to a TypeScript payload would not persist it.

`marketOpenPublication.ts` gives raw/scored gates a shared explicit refusal.
`score --publish` still writes the score artifacts, then returns nonzero without
opening a serving connection. Valid model runs are scored; unsupported SQL
publication is not success. **Timing is retained in scored artifacts, not yet in
SQL or anonymous FE views. No public-readback claim is made by B4.1.**

## Trusted input and discovery

- Resolve an explicit operator-owned B2 evidence root. The reader reuses the
  producer's canonical journal parser and semantic reducer without acquiring a
  writer lock or mutating the root.
- Enumerate journal-installed outcomes, not newest files, fired-game markers,
  arbitrary filenames or mtimes. Normal claimed/running/unknown/refused and
  operationally failed events are not score inputs.
- B2 calls an installed, fully settled model-arm failure `failed` with reason
  `arm_outcome_failure`. That terminal outcome **is** a score input: retain its
  failed arms in denominators without changing its status or authorizing a bet.
  Scoring admission is not B3 execution admission.
- Resolve each event's installed artifact by the completion reference and exact
  byte hash. Bind config/cohort, event, game, market, run, policy, retained history,
  immutable opener, game/request/source hashes, complete roster, initial/repair
  evidence and accepted decisions. Recompute `prepareMarketOpenRun` from retained
  preimages rather than inventing a history row in `sourceOddsRows`.
- Require the B2 `sourceOddsReference` and `run_meta.marketOpen.source` to agree,
  and require `mode === 'live'` and `clockMode === 'wall'` before scoring. Validate
  response/cost/timing evidence as well as the immutable envelope's byte hash.
- A genuine read-only evidence handle is required even for extracted NDJSON.
  Revalidate its installed bytes/journal before scoring or emitting scored records;
  mutated parsed inputs cannot retain an earlier evidence binding.

Library entry points are `discoverMarketOpenRuns`, `readMarketOpenRun`,
`assertMarketOpenRecords`, and `readRunArtifactFile`. The scheduler-facing
`discoverScoreableMarketOpenRuns` additionally uses the existing full scorer
integrity checks. Its deterministic descriptors preserve terminal status/reason.

Source-only CLI examples (not instructions to activate a scheduler):

```text
yarn discover:market-open --evidence-root ROOT
yarn score --run ROOT/artifacts/EVENT.json --evidence-root ROOT --out SCORE_DIRECTORY
```

Market-open scoring requires an output directory **outside the evidence root**;
existing symlink ancestors are resolved before accepting the destination. A score
pass must not write derived artifacts into the producer's immutable input root.
Discovery itself is offline, read-only and silent for an empty initialized root.

### Root compatibility and input contract

B4.1 accepts **exactly one store root**, not a parent directory of stores. Its
shared B2 replay requires `config.root === resolve(evidenceRoot)`, so copying or
moving a store fails closed. B3's Python reader also accepts a parent of stores
and can resolve a relocated copy within its supplied root. These interfaces are
not interchangeable: B4's third PR must explicitly enumerate concrete store roots
for benchmark scoring and reconcile portability before wiring one setting to both
consumers. Do not repair journal/config paths in place or weaken hash checks.

The wrapper's top-level shape, record types and cardinalities are closed. Individual
record identity checks validate the expected **subset** of fields, allowing extra
record fields inside the hash-verified bytes; this is not a claim of closed record
schemas. Loader, scorer and publication share the same provenance-marker predicate,
including an in-memory evidence marker, so marker-only input cannot downgrade to
legacy publication.

A `score --publish` failure can leave successfully written scored files: SQL refusal
happens after scoring/output and before opening a serving connection. A caller must
not interpret exit 1 as “nothing happened” or blindly re-score on every retry.
The real score command still uses the existing closing-lines read path; tests
inject synthetic closes and never contact it.

## Timestamps, not trip wires

Every installed scoreable outcome is considered regardless of opener age or send
lag. No maximum-age filter, freshness exclusion, comparison-rank filter or elapsed
admission deadline is introduced. First-pitch/spend controls remain in production
admission; scoring continues after first pitch when closes are available.

Each market-open `scored_decision` carries `marketOpenTiming`:

- `version: market-open-score-timing-v1`
- market/event and opener capture / first-observed timestamps
- `openerAgeAtFirstObservationMs`
- the selected initial/repair attempt's `sendAt` and
  `observationToSendLagMs`; baseline send fields are null, never an invented zero.

`scored_run_meta` retains `sourceClockMode`, verified market-open provenance,
artifact hash, the producer's full initial/repair timing payload, journal install
time and terminal status/reason. Its `marketOpen.cost` is versioned
`market-open-scored-cost-v1` and carries the accepted price version, known total
micro-USD and each initial/repair attempt's actual settled cost. Costs are retained
from verified B2 evidence, not recomputed from the accepted response alone.

Inconsistent timestamp/cost preimages are integrity failures, not age thresholds.
Warnings remain descriptive. The old-opener/late-send fixture still scores all
model decisions; baseline send fields remain null.

## Denominators and math

Each sibling moneyline/total run supplies one market. Existing supplied-market
aggregation therefore gives each dispatched arm one opportunity in that market,
zero in other markets. A failed model arm still has that opportunity and its
existing failure category; it is not silently dropped. Unrelated-game markets
are not assumed to exist. Scoring formulas, close-quality rules, line movement,
reschedule strata, ladders, baseline policy and failed-arm treatment are unchanged.
Opener-age labels do not change any of those calculations.

## Offline verification / R3

Fixtures run the real B2 producer, runner, sealed-response/billable accounting and
durable sink with synthetic adapters, histories, usage and clocks. No provider
keys, production records or remote fetches. Durable-fixture tests explicitly skip
Windows because the accepted B2 producer requires POSIX; cross-platform legacy
and CLI argument tests remain active.

Run canonical `yarn test` and `yarn typecheck` with a scrubbed environment. Focused
files are `marketOpenEvidence.test.ts`, `marketOpenScoring.test.ts`, and
`discoverMarketOpenMain.test.ts`, alongside the existing B2/scoring/serving suites.
They cover coherent artifact tampering, isolated journal links, read-only replay,
source edits, complete/failed-arm denominators, old/late timings, selected repair
costs, discovery executable wiring and refusal before SQL writes.

The R3 packet records exact base/head, diff, file hashes, test and targeted author
mutation results. Author evidence is not independent review. Opening this first
PR does not release any runtime or publication hold.
