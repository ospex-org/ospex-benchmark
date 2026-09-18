# Invocation-scoped market-open evidence admission

`withMarketOpenEvidenceAdmission(operation)` in `src/marketOpenEvidence.ts`
is the read-only boundary for one discovery/scoring/publication invocation.
It is not a process-wide cache and creates no files, locks, or persistent state.

## Contract

- On first use of each root, replay its stable append-only journal prefix once.
  Retain the exact terminal-artifact bytes that the replay verified. All existing
  canonical config/journal, chain, reducer, path, regular-file, size and raw SHA
  checks still run, including checks on completed siblings not selected to score.
- Admit each selected artifact from those verified bytes, retaining the existing
  policy, prepared request, history, opener, response, decision, timing and cost
  checks. Reuse the resulting deeply frozen genuine evidence within the scope.
- Discovery, artifact input, integrity, scoring and scored-record generation
  resolve against the same prefix. Record equality, the genuine-evidence
  capability and parsed-run bindings remain checked at each use.
- Appends after that root's replay belong to the **next invocation**. Replacing
  or deleting a file after replay cannot substitute bytes into this invocation;
  it still uses its already verified bytes. The next invocation reads the disk
  again and rejects corruption. This is prefix consistency, not a promise to
  resample a changing directory between phases.
- Synchronous return/throw or async Promise fulfillment/rejection clears all
  retained root bytes and deactivates the scope, including inherited async
  contexts. Return/await all work from the callback. Nested operations share
  their enclosing invocation; independent concurrent invocations do not share.
- Evidence escaping the scope retains its existing genuine-object identity but
  no freshness authority: subsequent integrity/scoring use must re-admit it.
  There is no API accepting a caller-supplied map as trusted admission.

`discoverScoreableMarketOpenRuns` and `runScoreCli` establish this boundary
for their own invocation. Standalone low-level API calls retain their ordinary
readmission behavior. Multi-phase consumers must wrap their whole operation:

```ts
await withMarketOpenEvidenceAdmission(async () => {
  const descriptors = discoverScoreableMarketOpenRuns(root);
  // Fetch/read the explicitly chosen closes, then build using the same scope.
  // readRunArtifactFile, verifyRunIntegrity, scoreRun and scoredRecords reuse it.
  await buildFromDescriptors(descriptors);
});
```

Retained memory is proportional to the verified book (artifact buffers plus
admitted evidence), released at settlement. Existing per-file/journal bounds
remain unchanged. No claim is made that the reducer's own complexity changed;
this removes repeated whole-root work from every artifact/phase.

## Repository boundary

This benchmark PR provides the shared admission API and the benchmark-owned
entry points. It does **not** change the MVE pin, execution fixtures, installed
checkouts, services, timers, producer, source reader, public files, or database.
MVE currently launches discovery and build in separate processes; those cannot
share in-memory admission. After this PR's review, the separate MVE consumer
PR must put the publisher's discovery and build in one scoped invocation, bump
the pin and regenerate the execution fixtures at that pin. Merely bumping the
pin cannot eliminate the remaining cross-phase readmissions.

For before/after proof without starting that consumer PR, the scratch harness
can load the candidate benchmark API and pass it to the installed MVE
`projectAdmittedMarketOpenRuns` mapping seam under the new scope. Keep the
installed mapper and its identity stamps unchanged: that isolates admission
semantics and allows literal plan-byte comparison. This is **not** a production
pin-check bypass or proof that a future pin bump preserves the pin's own bytes.

## Regression evidence

Tests count actual root config reads (one journal replay per root), and actual
artifact opens (each verified once), on both daily-budget and cohort multi-
artifact fixtures through discovery, repeated discovery, input, integrity,
scoring and scored records. They compare scoped and ordinary scored bytes;
check repeat and overlapping async invocations, nesting, success/failure
cleanup, caller record mutation, post-read disk mutation, and corrupt siblings.
Existing coherent-tamper and authenticity tests remain part of the full gate.
