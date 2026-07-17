# SPEC — the prepared request (line-open runner)

**What this is:** the contract for **one immutable, normalized, plain-data request
identity** that every downstream surface derives from. It is the foundation the
per-market (dynamic-cardinality) work sits on top of.

**Why it exists.** A benchmark whose credibility rests on a content hash must
guarantee that the bytes hashed are the bytes prompted, validated, scored, and
recorded — one object, not several independently-mutable aliases. Today the
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
- `requestSha256` is **recomputed** from the normalized request bundle; a
  supplied hash that does not match is a rejection, never a pass.
- `gameSha256` and any slate/record linkage derive from the **same** snapshot.
- Every timestamp is a canonical offset-qualified instant (the shared instant
  boundary); a malformed timestamp is rejected.

### 2.2 Scoped markets

- **1–3** present markets. Absence means an **omitted own property**; a present
  own key must hold a structurally-valid block. Runtime enforcement is
  mandatory; a static `AtLeastOne` type is optional — absent it, do not claim
  static enforcement.
- Every block is normalized from the parser's `.data` (plain data), not the
  original object.
- Prices (`awayDecimal`/`homeDecimal`/`overDecimal`/`underDecimal`) are finite
  decimal odds **> 1**; run-line/total `line` is finite.
- `observedAt` is a canonical offset-qualified instant and must not postdate the
  bundle timestamp.
- Run-line redundancy is coherent: `homeHandicap === line` and
  `awayHandicap === -line`.
- Every present block's `evidenceRef` is non-empty and appears in the game's
  `evidenceRefs`.
- Unknown market keys, inherited market keys, and unknown/extra model-facing
  fields are rejected (or explicitly stripped before hashing/prompting under a
  versioned data policy) — never silently carried.

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

One table-driven suite per group, not scattered patches.

**Prepared request (§1–2):**
- the seven non-empty market combinations prepare and dispatch cleanly;
- empty scope → zero adapter calls;
- null/primitive/missing-field block → zero adapter calls;
- mismatched supplied `requestSha256` → zero calls;
- `gameId` / `game` / bundle-game mismatch → zero calls;
- zero-game, multi-game, duplicate-game bundle → zero calls;
- cutoff widened past `scheduledStartUtc` → zero calls;
- an accessor reading `1.9` then `99` cannot make `99` validate;
- inherited/custom `toJSON` cannot change the prompted markets;
- the canonicalized prompted bundle exactly matches the value used to derive
  `requestSha256`;
- records serialize the exact prompted game;
- a mutation after preparation changes nothing downstream;
- contradictory handicap / timestamp / evidence-ref blocks fail preparation.

**Baseline isolation (§3):**
- `v0.1`/`v0.2` full-board goldens unchanged;
- every 1- and 2-market bundle is rejected under `v0.1`/`v0.2`;
- all seven non-empty scopes work under `v0.3`;
- an unknown version stays rejected;
- a new dynamic cohort cannot boot with `v0.1`/`v0.2`.

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
| **S1** | Prepared request | `prepareGameRequest` + `PreparedGameRequest` (§1–2), wired at the dispatch boundary + user-message guard, with the §5 prepared-request matrix. Built for the current three-market bundle — no cardinality change. May split S1a (pure boundary + parse/derive/freeze/invariants) / S1b (dispatch wiring + zero-adapter-call proof) if the diff runs large. |
| **S2** | Baseline version isolation | §3, with the §3 matrix. Separable. |
| **S3** | Dynamic cardinality | Relax the prepared boundary's market count to 1–3 as a producer and re-home the validator/baselines/prompt "derive from present markets" logic on top of the prepared snapshot; fold in §4 wording. |

Then the previously-planned fire-artifact / detection / claim slices, which now
build on a request they can trust.
