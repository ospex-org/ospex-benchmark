# SPEC — the prepared request (line-open runner)

**What this is:** the contract for **one immutable, normalized, plain-data request
identity** that every downstream surface derives from. It is the foundation the
per-market (dynamic-cardinality) work sits on top of.

**Why it exists.** A benchmark whose credibility rests on a content hash must
guarantee that the object hashed is the object prompted, validated, scored, and
recorded — one canonical value, not several independently-mutable aliases. The
prompt pretty-prints the bundle inside a larger payload, so the bytes are not
literally identical; the guarantee is that **parsing and canonicalizing the
prompted bundle reproduces exactly the canonical bytes that were hashed** — same
fields and values, insignificant JSON formatting aside. Today the
runner carries `request.gameId`, `request.game`, `requestBundle.games[0]`,
`requestBundle.cutoffAt`, and `requestSha256` as separate values that
`buildBundle` happens to create coherently but nothing re-establishes at the
provider boundary; the prompt is serialized with native `JSON.stringify` while
the hash is derived with `canonicalize`; records serialize `request.game`, not
necessarily the game the provider saw. Each gap is a place where the hashed
identity and the model-facing bytes can diverge. This boundary closes that class
in one place.

This is a **request-integrity** contract. It is independent of how many markets a
bundle carries: it is specified and built for the current fixed three-market
bundle, and the per-market cardinality change is layered on top afterwards (§7).

## 1. The boundary

```
prepareGameRequest(raw) ->  PreparedGameRequest   // frozen plain data
                         |  reject                 // typed preparation failure
```

Steps, in order:

1. **Strict parse into fresh plain data.** Parse the raw request bundle with a
   strict schema and use the parser's output (`.data`), never the original
   object. This evaluates any accessor exactly once and yields a plain-data
   snapshot with no getters, Proxies, inherited or own `toJSON`, symbols,
   non-data descriptors, or unknown/extra fields — the single technique that
   neutralizes serialization-divergence and accessor-drift attacks.
2. **Verify cross-field identity and timing** (§2).
3. **Derive** the request and game hashes from that snapshot — never trust a
   supplied hash.
4. **Deep-freeze** the snapshot.

A `PreparedGameRequest` is the only value the dispatch path may consume.

## 2. Invariants (all enforced before any adapter call)

### 2.1 Request shape and aliases

- Exactly **one** game in a per-game request; a zero-game or multi-game request
  is rejected.
- No duplicate game IDs within the request bundle.
- `request.gameId === game.gameId === requestBundle.games[0].gameId` — one
  canonical value, not independent aliases.
- `requestBundle.cutoffAt === game.scheduledStartUtc` (the current first-pitch
  cutoff contract): the cutoff cannot be widened past the scheduled start.
- `requestSha256 = sha256Hex(canonicalize(prepared.requestBundle))` —
  **recomputed** from the normalized snapshot; a supplied hash that does not
  match is a rejection, never a pass.
- `gameSha256` and any slate/record linkage derive from the **same** snapshot.
- Every timestamp is a canonical offset-qualified instant (the shared instant
  boundary); a malformed timestamp is rejected.

### 2.2 Market blocks and cardinality

Block coherence (applies from **S1**, to whatever markets the contract requires):

- Every present market block is normalized from the parser's `.data` (plain
  data), not the original object.
- Prices (`awayDecimal`/`homeDecimal`/`overDecimal`/`underDecimal`) are finite
  decimal odds **> 1**; run-line/total `line` is finite.
- `observedAt` is a canonical offset-qualified instant and must not postdate the
  bundle timestamp beyond the build-time clock-skew allowance
  (`FUTURE_QUOTE_SKEW_MS`), matching the bundle quote-freshness policy.
- Run-line redundancy is coherent: `homeHandicap === line` and
  `awayHandicap === -line`.
- Every present block's `evidenceRef` is non-empty and appears in the game's
  `evidenceRefs`.
- Unknown market keys, inherited market keys, and unknown/extra model-facing
  fields are rejected (or explicitly stripped before hashing/prompting under a
  versioned data policy) — never silently carried.

**Cardinality is slice-owned** — the prepared request carries exactly the
runner's current market contract:

- **S1:** the **three fixed markets** (moneyline, run line, total) — all present
  and coherent. A request missing any of the three, or carrying an unknown/extra
  market, is rejected. **S1 introduces no 1–3 behavior.**
- **S3:** relaxed to **1–3 present markets**, where absence is an omitted own
  property and each present market is a structurally-valid block.

Runtime enforcement is mandatory; a static `AtLeastOne` type (an S3 nicety) is
optional — absent it, do not claim static enforcement.

### 2.3 Side-effect boundary

- The dispatch function consumes only a `PreparedGameRequest` (or performs and
  verifies preparation itself immediately before building provider turns), and
  the user-message builder is guarded so a direct caller cannot serialize an
  unprepared request.
- An empty, malformed, hash-mismatched, multi-game, duplicate-ID,
  widened-cutoff, or alias-inconsistent request makes **zero adapter calls**.
- An invalid internal request is a **harness/preparation failure**, never
  `invalid_schema` attributed to the model.

### 2.4 One snapshot everywhere

The exact same frozen snapshot feeds: canonical request/game hashes; prompt
serialization; cutoff enforcement; response validation; repair fingerprinting;
deterministic baselines; `bundle_game`/decision/arm-response records; and
summaries. A mutation attempt after preparation changes none of these surfaces.
The prompt may embed the bundle in a larger, differently-formatted JSON payload,
but `canonicalize(parse(promptedBundle))` yields exactly the bytes used to derive
`requestSha256`, with no differing field or value.

### 2.5 The pre-claim snapshot is not the prepared request

The evidence model takes a **pre-claim** detection/source snapshot (the candidate
set observed at detection; evidence spec §3–§4). `PreparedGameRequest` is the
**final** projection produced **after** retained-scope selection — the exact
scope that will actually be dispatched. They are different objects: dispatch and
hashing consume the final `PreparedGameRequest`, never the pre-claim candidate
set, so a **partial claim cannot dispatch a scope wider than what was retained**.

## 3. Baseline policy-version isolation

The baseline policy version selects the derivation contract, and the historical
contracts are full-board:

- `baselines-v0.1.0` — legacy six, full-board-era policy.
- `baselines-v0.2.0` — full-board eight.
- `baselines-v0.3.0` — the scoped dynamic baseline set (derives a subset from the
  present markets).

Therefore:

- `v0.1.0`/`v0.2.0` **require the full-board input shape and fail closed on a
  scoped (1–2-market) input**; they never emit a partial set.
- Only `v0.3.0` derives from present markets.
- A new dynamic cohort requires `v0.3.0` (an explicit manifest/runtime version
  gate); it cannot boot under `v0.1.0`/`v0.2.0`.
- Scoring preserves archived `v0.1`/`v0.2` full-board replay and refuses an
  old-version/scoped artifact.

**Slice ownership.** **S2** lands the `v0.1`/`v0.2` full-board input guards (fail
closed on scoped input), the unchanged historical goldens, and unknown-version
rejection; it does **not** add any `v0.3` scoped behavior. S2 also cannot
identify a "dynamic cohort" at boot — the manifest carries no scope/dynamic
marker yet — so the **dynamic-cohort boot/runtime gate belongs to S3**. **S3**
introduces `v0.3`'s scoped derivation, the dynamic-cohort gate (a dynamic cohort
requires `v0.3`), and the seven-combination behavior.

## 4. Committed-contract wording

Benchmark comments and docs are part of the evidence contract; these are fixed in
the same work:

1. `v0.3` three-market output vs `v0.2` is **identical apart from the required
   `policyVersion` stamp** — not "byte-identical".
2. The at-least-one-market guarantee is **runtime** (the prepared boundary);
   claim static enforcement only if an `AtLeastOne` type is added.
3. Presence is validated structurally at the prepared boundary (plain-data
   snapshot); no claim that a single read alone defeats an accessor.
4. `docs/BENCHMARK_PROMPT_V0.md` frozen-bundle wording describes the **scoped
   subset** of moneyline/spread/total, not an always-present three.

## 5. Test matrix

Table-driven per slice; **each test is owned by exactly one slice** — the
prepared-request boundary is exercised at exactly three markets in S1, and the
dynamic 1–3-market / seven-combination behavior belongs to S3.

**S1 — prepared request (three fixed markets):**
- the three-market request prepares and dispatches cleanly;
- a request missing any of the three markets, or carrying an unknown/extra
  market key → zero adapter calls;
- a null/primitive/missing-field block → zero adapter calls;
- a mismatched supplied `requestSha256` → zero calls;
- `gameId` / `game` / bundle-game alias mismatch → zero calls;
- a zero-game, multi-game, or duplicate-game bundle → zero calls;
- a cutoff widened past `scheduledStartUtc` → zero calls;
- an accessor reading `1.9` then `99` cannot make `99` validate;
- inherited/custom `toJSON` cannot change the prompted markets;
- `canonicalize(parse(promptedBundle))` equals the canonical bytes used to
  derive `requestSha256`;
- records serialize the exact prepared game;
- a mutation after preparation changes nothing downstream;
- contradictory handicap / timestamp / evidence-ref blocks fail preparation.

**S2 — baseline version isolation (historical guards only):**
- `v0.1`/`v0.2` full-board goldens unchanged;
- every 1- and 2-market input is rejected under `v0.1`/`v0.2` (fail closed — no
  partial set);
- an unknown version stays rejected.
- *(No `v0.3` scoped behavior, and no dynamic-cohort gate, at S2 — the manifest
  has no dynamic marker yet.)*

**S3 — dynamic cardinality + `v0.3` scoped baselines:**
- the prepared boundary now accepts **1–3** present markets (absence = omitted
  own property);
- all **seven** non-empty market combinations prepare, dispatch, validate, and
  baseline under `v0.3`;
- `v0.3` derives the baseline set from the present markets, while `v0.1`/`v0.2`
  still reject scoped input;
- a dynamic cohort requires `v0.3` (the boot/runtime gate); a scoped prepared
  request is refused under `v0.1`/`v0.2`;
- the archived three-market corpus still replays.

## 6. Now vs later (the staged boundary)

These are **not** part of the prepared-request/baseline-isolation work; they are
hard dependencies that must land **before** the per-market detection slice makes
a 1- or 2-market artifact reachable, and are tracked separately:

- **Dynamic scorer/integrity support** — the scorer still requires all three
  blocks, dereferences all three, and computes the model denominator as
  `responses.length * 3`; it must parse the recorded scope, derive denominators
  per recorded scope, re-run the dynamic validator against the hash-verified
  request, reject old-version/scoped artifacts, and preserve `v0.1`/`v0.2`
  full-board replay.
- **Dynamic human summary** — the "Moneyline picks" section renders from a fixed
  assumption; it must render from the present market set (or omit honestly) so a
  total-only run shows its total forecast.
- **Runtime/operator docs** — `README.md` and `docs/LINE_OPEN_RUNNER.md`
  describe the currently-reachable full-board watcher; update them when the
  detection slice changes reachability, not before.

Explicitly out of scope for this foundation: odds-history detection/claim,
watcher scheduling/concurrency, fire-artifact persistence, coverage
finalization, CLV implementation, and live-mode enablement. `--live` stays
hard-disabled.

## 7. Decomposition (small, foundation-first slices)

| # | Slice | Scope |
|---|---|---|
| **S1** | Prepared request | `prepareGameRequest` + `PreparedGameRequest` (§1–2), wired at the dispatch boundary + user-message guard, with the §5 **S1** matrix. Uses **exactly the current three markets** — no 1–3 behavior, no cardinality change. Split into: **S1a** (pure boundary: parse/derive/freeze/invariants — owns the accessor/`toJSON`/mutation-after-freeze/contradictory-block rejection rows); **S1b** (dispatch wiring + user-message guard + zero-adapter-call proof + the `canonicalize(parse(promptedBundle))` row); **S1c** (records serialize the *literal* prepared snapshot — owns the "records serialize the exact prepared game" and "a mutation after preparation changes nothing downstream" rows). |
| **S2** | Baseline version isolation | §3 **S2** part only — the `v0.1`/`v0.2` full-board guards + fail-closed-on-scoped-input + unknown-version rejection, with the §5 **S2** matrix. **No `v0.3` scoped behavior and no dynamic-cohort gate.** Separable. |
| **S3** | Dynamic cardinality + `v0.3` | Relax the prepared boundary to **1–3** present markets; introduce the `v0.3` scoped baselines and the **dynamic-cohort boot gate** (a dynamic cohort requires `v0.3`); re-home the validator/baselines/prompt "derive from present markets" logic (keep the `runLine` name); run all **seven** combinations (§5 **S3**); fold in the §4 wording. |

Then the previously-planned fire-artifact / detection / claim slices, which now
build on a request they can trust.
