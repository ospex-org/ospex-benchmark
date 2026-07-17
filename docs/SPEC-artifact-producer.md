# SPEC — the sealed run envelope (S1d: adversarial internal artifact-producer boundary)

**What this is:** the contract for **one authenticated, deeply-immutable run
envelope** that the artifact producers (`buildRecords`, `buildSummaryMarkdown`)
consume as their single source of dispatched evidence. It completes the S1c work:
S1c sealed the *dispatch* snapshot (`DispatchSnapshot`) and made the producers
authenticate it; S1d seals the *whole run* — snapshot + result graph +
expected-arm manifest + the load-bearing dispatch context — into one branded
value, so no downstream producer can be handed a split, substituted, mutated, or
incomplete run.

**Why it exists.** The credibility of every recorded artifact rests on the claim
that its recorded **request** evidence is the normalized, hash-verified bytes that
were **dispatched**, and its recorded **response** evidence is exactly what the
**runner captured** from each provider (after secret redaction) — neither split
across mutable aliases nor swapped after the fact. After S1c the
*dispatch snapshot* is unforgeable, but the producer still assembles the artifact
from **three independently-supplied inputs that feed its dispatched claims** — the
sealed `snapshot`, a separate `ArmGameResult[]`, and a separate load-bearing
`RunContext` — over only a shallow freeze. That seam lets an **incorrect
in-process caller** emit an artifact its own verifier would reject: a filtered
result array drops an arm (completeness is derived from the very array supplied);
nested provider evidence is mutable after `runSlate` returns; a mismatched
`RunContext` swaps `slateDate`/`cohortId` out from under the sealed slate; and
`sealDispatch` reads a caller-owned container across multiple reads. S1d closes
that seam in one place: `runSlate` returns **one branded, deep-frozen run
envelope** carrying every dispatched-evidence value, and the producers
authenticate *that envelope* rather than three loose arguments.

This is a **producer-integrity** contract. It is scoped to the current fixed
three-market, four-arm smoke/watch production path; it introduces no cardinality
change, no new baseline version, and no scorer change.

## 1. Threat model (bounded — read this before proposing a row)

S1d protects the artifact producer against exactly one adversary class:

> **An incorrect in-process caller** — code inside this process that calls
> `sealDispatch` / `runSlate` / `buildRecords` / `buildSummaryMarkdown` with
> hand-built, substituted, mutated, or incomplete **dispatched-evidence** inputs.

Concretely, the in-scope caller can: pass an accessor-backed / proxy container
where a plain prepared batch is expected; return-then-mutate a real `runSlate`
result; hand a producer a forged or substituted run-envelope wrapper (e.g. one
whose result graph omits an arm); misconfigure the dispatched roster with a
duplicate participant; and supply a `RunContext` whose load-bearing fields
disagree with the dispatched run.

**Explicitly OUT of the threat model** (a row that requires one of these is out
of scope, not a blocker):

- A **compromised runtime**: monkey-patched `Object.freeze`, `WeakSet`,
  `Array.from`, `structuredClone`, `JSON`, or prototype tampering. Brands and
  freezes assume honest built-ins.
- **Provider / network dishonesty**: a lying model, a spoofed HTTP response. The
  runner records each response as it captured it (after secret redaction —
  unchanged by S1d); the *truth* of those bytes is not S1d's concern.
- **Caller-supplied build / run inputs that are not dispatched evidence** — a
  `BuildResult` (`provenance` / `excluded`) or a `CollisionCheckResult` that
  disagrees with the run. These drive `bundle_game.sourceOddsRows`,
  `excluded_game`, and `run_failure` records; they are caller inputs, not the
  dispatched request/response graph. The scorer/verifier remains their backstop
  (§5). S1d does not brand or freeze them.
- The **scorer**: it remains the final, independent integrity backstop
  (`verifyRunIntegrity`), including full-**expected-roster** completeness across
  the whole cohort. S1d hardens the *producer*, never the verifier, and never
  relies on the scorer to catch a producer defect it can itself close.

The point of stating the boundary this sharply is convergence: the acceptance
matrix in §3 is **closed** over this threat model. A finding that needs a
compromised runtime, a dishonest provider, `BuildResult`/`CollisionCheckResult`
tampering, or the scorer is **out of scope by construction** — track it
elsewhere, do not add a matrix row.

## 2. The boundary

```
runSlate(arms, adapters, requests, options)      ->  RunEnvelope   // branded, deep-frozen
buildRecords(env, ctx, build, collision)         ->  JsonRecord[]  // authenticates env, gates ctx
buildSummaryMarkdown(env, ctx, build, collision) ->  string        // authenticates env, gates ctx
```

`RunEnvelope` supersedes the S1c `SlateRunResult`. It is the **only** value the
producers consume for dispatched evidence:

```ts
interface RunEnvelope {
  snapshot: DispatchSnapshot;              // the S1c sealed dispatch snapshot
  results: readonly ArmGameResult[];       // the deep-frozen result graph (the complete arms x games grid)
  expectedArms: readonly string[];         // the dispatched roster's participantIds (unique — see A3)
  dispatch: {                              // the load-bearing dispatch context, bound at construction
    cohortId: string;
    executionPolicy: 'fixed-moneyline-total';
    timeoutMs: number;
    maxOutputTokens: number;
  };
}
```

- The envelope is registered in a module-private `WeakSet` at construction (same
  pattern as `assertSealed`); `assertRunEnvelope(env)` throws unless `env` is a
  member. It is produced in exactly one place — `runSlate` — and nothing outside
  `runner.ts` can add to the registry. `assertRunEnvelope(env)` is the **single**
  authentication call in each producer and **subsumes** `assertSealed`: a branded
  envelope is only built by `runSlate`, which builds `snapshot` via
  `sealDispatch`, so the envelope brand transitively guarantees the snapshot; the
  loose `assertSealed(snapshot)` calls are removed.
- `slateDate` is **not** a `dispatch` field; it is derived solely from
  `snapshot.slate.slateDate` (§4). `dispatch` carries the four dispatch-only
  load-bearing fields; `cohortId` / `timeoutMs` / `maxOutputTokens` already flow
  through `SlateRunOptions`, and `executionPolicy` is added to `SlateRunOptions`
  so `runSlate` can bind the authoritative value.
- `RunContext` (`ctx`) stays a **separate, brand-independent** producer argument.
  It is the presentation/run-context the caller legitimately supplies; the
  producer equality-gates its five load-bearing fields against the envelope (A4)
  and records its other seven fields (`runId`, `createdAt`, `mode`,
  `fetchStartedAt`, `fetchCompletedAt`, `clockMode`, `watch`) verbatim.

## 3. Acceptance matrix (finite — the only rows S1d is judged on)

Each row names the attack it defeats and the mechanism. The set is **closed**
over §1: together they cover the in-scope caller, and no row is phrased as a
universal ("unforgeable against any caller") guarantee.

| # | Row | Mechanism | Defeats |
|---|-----|-----------|---------|
| **A1** | **Single-read batch capture.** `sealDispatch` copies the supplied batch **exactly once** into a new plain array (`Array.from`), runtime-asserts (`assertPrepared`) every captured element **before reading any of its fields**, then validates and derives the slate **exclusively** from the captured copy, and retains the copy (never the caller's container) in the snapshot. | One read → a stable plain array; assert-before-field-read; build-from-copy. | An accessor/proxy batch that returns `t001` during validation and `t088` during slate construction; a forged element whose field is read before its origin is checked. |
| **A2** | **Deep immutability.** `runSlate` deep-freezes the **whole envelope graph** before returning it. `deepFreeze` is the mechanism; the reached set includes the snapshot, every `ArmGameResult` and its nested `attempt` / `repair` / `usage` / `usageRaw` / `parsed` / `validationErrors`, the shared roster `arm` objects, `expectedArms`, and the `dispatch` object — the list is illustrative, not an exhaustive checklist (freezing the shared `ArmSpec` roster entries is an intended, harmless side effect). | `deepFreeze(env)` over the whole reachable graph (not `Object.freeze(all)` on the outer array alone). | Returning a real result, then mutating `results[i].attempt.rawText` (or any nested field) before the producer reads it. |
| **A3** | **Unique, complete-by-construction result grid.** `runSlate` rejects a **duplicate participantId** in the dispatched roster **before any provider call**. It then produces exactly the `expectedArms × dispatched-game` grid (it maps over the unique roster × every game), so the grid is complete-and-unique **by construction** — asserted before sealing as defense-in-depth, not re-derived from a substitutable array. `expectedArms` = the dispatched roster's participantIds. Because the complete grid lives **inside** the branded, deep-frozen envelope, no caller can hand a producer a filtered/omitting result set — A5 rejects a forged wrapper and A2 freezes the real one. | Reject-duplicate-before-dispatch; grid completeness is a construction invariant carried inside the brand, never re-derived from a caller-supplied array. | A misconfigured roster with a **duplicate** arm (otherwise billed and recorded twice). *(A forged/filtered result set that omits an arm is rejected by A5+A2; a genuinely-configured **subset** run is legitimate — full-*expected*-roster completeness is the scorer's backstop, §5.)* |
| **A4** | **Bound load-bearing context.** The five load-bearing fields are `{ slateDate, cohortId, executionPolicy, timeoutMs, maxOutputTokens }`. The producer **derives** them from the envelope (`slateDate` from `snapshot.slate.slateDate`; the other four from `dispatch`) and records those authoritative values; a separately-supplied `RunContext` that **disagrees on any of the five fails closed** before writing. No other `RunContext` field is bound (§4). | Derive-from-envelope; equality-gate the caller's `RunContext` on the five. | Supplying a `RunContext` with a different `slateDate` or `cohortId` so `run_meta` / recorded picks contradict the dispatched (and model-echoed) values. |
| **A5** | **Whole-envelope authentication.** `buildRecords` and `buildSummaryMarkdown` accept **the branded envelope** (not independent `snapshot` + `results` + dispatch-context) and call `assertRunEnvelope(env)` before emitting anything; a forged or substituted envelope wrapper is rejected. | Module-private `WeakSet` brand; single authenticated authority for all dispatched evidence. | Hand-building an envelope-shaped object (genuine or filtered nested pieces, substituted wrapper) and passing it to a producer. |
| **A6** | **Byte-compatible output across both governed producers.** On a deterministic production fixture (stub adapters + synthetic clock), **both** producer outputs are **byte-identical** to pre-S1d `main`: (1) the **complete NDJSON record sequence** — every record type, including the `arm_game_response` / decision records whose result handoff S1d changes, not only `run_meta` + the deterministic records; and (2) the **`buildSummaryMarkdown`** output — after normalizing an **explicitly-listed** set of volatile fields (`runId`, `createdAt`). Deep-freeze is byte-neutral; derive-from-envelope is byte-identity-or-rejection (a disagreeing `RunContext` is rejected, never silently re-serialized). Full tests, dry smoke, and `verifyRunIntegrity(...) === []` are **additional** A6 gates. The gain is the integrity *guarantee*, not different bytes. | Provenance-only refactor over both governed producers; no value path changes. | Silent output drift — in the record sequence OR the summary — hiding behind an integrity change. |

**No new blocker may be added to S1d unless it disproves one of A1–A6 within the
§1 threat model.** Discovered hardening outside this set is roadmapped, not
folded in (the S1c convergence rule).

## 4. Why exactly those five bound fields

A4 binds five fields and no more; this is deliberate, and the boundary is part of
the contract:

- **`slateDate`** — folded into the slate hash; a records-time swap would make
  `slateSha256` unrecomputable. Derived solely from `snapshot.slate.slateDate`
  (not duplicated in `dispatch`).
- **`cohortId`** and **`executionPolicy`** — **echoed by the model** in every
  `BenchmarkResponse` and checked by the scorer; a records-time swap makes the
  recorded picks contradict the actual responses.
- **`timeoutMs`** and **`maxOutputTokens`** — the dispatch parameters that were
  actually applied; a swap misrepresents how the evidence was produced.

Every **other** `RunContext` field is **run-context the caller legitimately
supplies** and is recorded from `ctx` unchanged; none is bound, each for a stated
reason:

- `runId`, `createdAt`, `mode`, `fetchStartedAt`, `fetchCompletedAt`,
  `clockMode` — run-presentation metadata that does not alter the dispatched
  evidence's integrity.
- `watch` — load-bearing and independently **scored** (the scorer fail-closes on
  watch provenance for watch runs), but it is caller-supplied *run context*, not
  dispatched evidence; it is left to the scorer's backstop for the **same reason**
  as `BuildResult.provenance` and `CollisionCheckResult` (§1/§5), not because it
  is "mere presentation metadata."

(This keeps the bound set finite and pre-answers "why not bind `createdAt`/`watch`
too?" here, not in a review round.)

## 5. Out of scope (explicit — to keep the matrix closed)

Not part of S1d; each is tracked elsewhere:

- **Dynamic 1–3-market cardinality and `v0.3` scoped baselines** — S3.
- **`BuildResult` (`provenance` / `excluded`) and `CollisionCheckResult`
  authentication** — `sourceOddsRows`, `excluded_game`, and `run_failure` records
  derive from caller-supplied build/run inputs, not the dispatched request/response
  graph; the scorer/verifier remains their backstop. S1d does **not** brand or
  deep-freeze them.
- **Authoritative full-roster enforcement inside `runSlate`** — S1d binds
  `expectedArms` = the *dispatched* roster and guarantees that grid is complete;
  enforcing that a run must dispatch the whole *expected* code roster is the
  scorer's cohort-completeness job today. A `runSlate`-level roster cross-check
  (a separate roster parameter) is a possible follow-up, not this slice.
- **Scorer redesign** — the scorer stays the final independent backstop; S1d does
  not change `verifyRunIntegrity` or lean on it to catch a producer defect it can
  itself close.
- **Watcher scheduling / concurrency, fire-artifact persistence, coverage
  finalization, odds-history detection/claim, `--live` enablement** — later
  slices; `--live` stays hard-disabled.
- **Compromised runtime, dishonest provider/network** — outside the threat model
  (§1).

## 6. Test matrix (finite — one test per attack, mapped to a row)

- **A1** — an accessor-backed one-element batch returning a different prepared
  game on its second read is sealed from a stable copy (validation and slate
  agree); a forged element is rejected by `assertPrepared` **before** any field
  of it is read.
- **A2** — after `runSlate` returns, mutating `results[0].attempt.rawText` (and a
  nested `usage` / `parsed` field) throws (frozen).
- **A3** — a duplicate participantId in the roster is rejected **before** any
  provider call (zero adapter calls); a genuinely-configured subset run (one arm)
  produces an honest artifact whose `expectedArms` is that one arm (no false
  completeness claim). (Grid completeness is a `runSlate` construction invariant,
  asserted before sealing as defense-in-depth — not a separately
  black-box-tested producer defense.)
- **A4** — a `RunContext` disagreeing on each of `slateDate` / `cohortId` /
  `executionPolicy` / `timeoutMs` / `maxOutputTokens` fails closed (five cases);
  an agreeing `RunContext` produces the artifact unchanged.
- **A5** — a forged/substituted envelope wrapper (genuine or filtered nested
  pieces, e.g. a result graph missing an arm) is rejected by both `buildRecords`
  and `buildSummaryMarkdown` at `assertRunEnvelope`.
- **A6** — on a deterministic production fixture (stub adapters + synthetic
  clock), the **complete NDJSON record sequence** *and* the **summary markdown**
  are byte-identical to pre-S1d `main` after normalizing the listed volatile
  fields (`runId`, `createdAt`); additionally, the full suite and dry smoke stay
  green and `verifyRunIntegrity(...)` returns `[]` for a produced run.

## 7. Decomposition (spec-first, then one implementation PR)

| # | Slice | Scope |
|---|---|---|
| **S1d-spec** | This document | Freeze the threat model, the closed A1–A6 matrix, the `RunEnvelope` interface, the five bound fields, and the out-of-scope list. **Paper-reviewed and merged before code.** |
| **S1d-impl** | The producer boundary | `runner.ts`: `RunEnvelope` + brand + `assertRunEnvelope`; `sealDispatch` single-read capture (assert-before-field-read); `runSlate` deep-freeze of the whole envelope, reject-duplicate-participantId-before-dispatch, `expectedArms`, complete-grid construction assert, and bind the four `dispatch` fields (`executionPolicy` added to `SlateRunOptions`). `records.ts` / `summary.ts`: consume + authenticate the envelope (`assertRunEnvelope` subsuming `assertSealed`), derive + equality-gate the five bound fields against `ctx`, record the other seven `ctx` fields verbatim. Callers (`shadowSmoke`, `watch`) + the §6 test matrix. One PR, judged only on A1–A6. |

The impl PR's stated contract is **exactly** A1–A6 over the §1 threat model —
no universal guarantee, no scope past this document. That is the convergence
discipline this spec exists to enforce.
