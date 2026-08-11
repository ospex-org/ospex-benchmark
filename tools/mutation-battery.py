"""Mutation battery over the serving-projection wiring.

Every guarantee this wiring states is a claim, and a test that would still pass
with the guarantee removed proves nothing. This applies each mutation below,
runs the suites that should catch it, and scores the result.

    python tools/mutation-battery.py

Verdicts, and why INVALID and HUNG are separate from SURVIVED:

    KILLED     the suite went red. The guarantee is tested.
    SURVIVED   the suite stayed green with the guarantee removed. A gap.
    INVALID    the edit did not apply, so the run proves NOTHING. Scoring this
               as a survivor invents a gap; scoring it as a kill hides one.
    HUNG       the suite did not terminate. Also not a verdict — re-run the
               mutant alone against the file that pins it before drawing a
               conclusion, because a hang can come from the case rather than
               from the mutation.

Two things this harness learned the hard way, both worth keeping:

  - It restores on EVERY path. Without that the next mutant lands on top of the
    previous one and every later verdict is meaningless.
  - On Windows, `subprocess.run(timeout=..., shell=True)` kills `cmd.exe` and
    not the `node` grandchild, and a `PIPE` the survivor still holds then blocks
    the read forever. So the timeout never fires and the battery simply stops.
    Hence Popen + a process-tree kill + no pipe. A timeout parameter is a claim
    like any other.

The tree-kill path is `taskkill`, so on a non-Windows host a hung mutant is not
reaped — the rest works unchanged.
"""
import hashlib
import io
import os
import subprocess
import sys

# The repository root, so the harness runs from anywhere.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUITE = [
    'src/servingProjection.test.ts',
    'src/servingPublisher.test.ts',
    'src/benchmarkServingClient.test.ts',
    'src/forecastDigest.test.ts',
]

# (label, file, old, new)  -- single-line only: a multi-line pattern silently
# matches nothing on a CRLF file and scores as a false SURVIVED.
MUTANTS = [
    ('sealedAt from responseAt', 'src/servingProjection.ts',
     "const sealedAt = str(record, 'acceptedAt');",
     "const sealedAt = str(record, 'responseAt');"),
    ('sealedAt falls back to the run open', 'src/servingProjection.ts',
     "const sealedAt = str(record, 'acceptedAt');",
     "const sealedAt = str(record, 'acceptedAt') ?? header.createdAt;"),
    ('suppliedMarkets hardcoded to the triple', 'src/servingProjection.ts',
     "  const markets = offered.get(gameId);",
     "  const markets: MarketKey[] = ['moneyline', 'spread', 'total'];"),
    ('walletAddress placeholder', 'src/servingProjection.ts',
     "    walletAddress: null,",
     "    walletAddress: '0x0000000000000000000000000000000000000000',"),
    ('sourcePath keeps the full path', 'src/servingPublisher.ts',
     "    sourcePath: basename(runFile),",
     "    sourcePath: runFile,"),
    ('gate drops the dry-run check', 'src/servingProjection.ts',
     "  if (str(meta, 'mode') !== 'live') return no('not a live run');",
     "  if (false) return no('not a live run');"),
    ('gate drops the synthetic-clock check', 'src/servingProjection.ts',
     "  if (str(meta, 'clockMode') !== 'wall') return no('the run used a synthetic clock');",
     "  if (false) return no('the run used a synthetic clock');"),
    ('gate drops the cohort namespace check', 'src/servingProjection.ts',
     "  if (!PUBLISHABLE_COHORT.test(cohortId)) return no('cohortId is outside the published namespace');",
     "  if (false) return no('cohortId is outside the published namespace');"),
    ('gate drops the stamp requirement', 'src/servingProjection.ts',
     "  if (stamp === null) return no('the artifact predates the projection stamp');",
     "  if (false && stamp === null) return no('the artifact predates the projection stamp');"),
    ('reveal self-check always passes', 'src/servingProjection.ts',
     "export function revealMatchesSeal(decision: ProjectedDecision): boolean {",
     "export function revealMatchesSeal(decision: ProjectedDecision): boolean { if (decision) return true;"),
    ('responseAt published raw', 'src/servingProjection.ts',
     "    responseAt: rawResponse !== null || httpStatus !== null ? str(leg, 'responseAt') : null,",
     "    responseAt: str(leg, 'responseAt'),"),
    ('sent is always true', 'src/servingProjection.ts',
     "    sent: requestAt !== null,",
     "    sent: true,"),
    ('searchEvidenceStatus always complete', 'src/servingProjection.ts',
     "  if (searchAudit === null) return 'no_search_evidence';",
     "  if (searchAudit === null) return 'complete';"),
    ('reasoningTokens coalesced to zero', 'src/servingProjection.ts',
     "    reasoningTokens: tokens === null ? null : num(tokens, 'reasoningTokens'),",
     "    reasoningTokens: tokens === null ? 0 : (num(tokens, 'reasoningTokens') ?? 0),"),
    ('attempt ordinal always zero', 'src/servingProjection.ts',
     "    attemptOrdinal: str(record, 'attemptUsed') === 'repair' ? 1 : 0,",
     "    attemptOrdinal: 0,"),
    ('model digest skips quantisation', 'src/servingProjection.ts',
     "  return decisionDigest(quantizeFingerprint(fingerprint));",
     "  return decisionDigest(fingerprint);"),
    ('baseline digest skips the line quantiser', 'src/schema.ts',
     "    line: pick.line === null ? null : quantizeForProjection(pick.line, PROJECTION_SCALES.line),",
     "    line: pick.line,"),
    ('baseline digest skips the price quantiser', 'src/schema.ts',
     "    observedDecimal: quantizeForProjection(pick.observedDecimal, PROJECTION_SCALES.observedDecimal),",
     "    observedDecimal: pick.observedDecimal,"),
    ('a model collapses onto its lab', 'src/servingIdentity.ts',
     "  return PROJECTION_PARTICIPANTS[runnerParticipantId] ?? null;",
     "  const e = PROJECTION_PARTICIPANTS[runnerParticipantId]; return e === undefined ? null : (e.labId === null ? e : { ...e, participantId: `lab-${e.labId}` });"),
    ('display name derived from the id', 'src/servingIdentity.ts',
     "function model(labId: string, displayName: string, armId: string): ProjectionParticipant {",
     "function model(labId: string, displayName: string, armId: string): ProjectionParticipant { displayName = armId;"),
    ('the roster forgets which model ran', 'src/servingIdentity.ts',
     "  return participant.armId ?? baselinePolicyVersion;",
     "  return baselinePolicyVersion;"),
    ('an unenrolled participant is invented', 'src/servingIdentity.ts',
     "  return PROJECTION_PARTICIPANTS[runnerParticipantId] ?? null;",
     "  return PROJECTION_PARTICIPANTS[runnerParticipantId] ?? { participantId: runnerParticipantId, kind: 'model', labId: null, displayName: runnerParticipantId, armId: runnerParticipantId };"),
    ('publisher sends decisions before attempts', 'src/servingPublisher.ts',
     "  await inBatches(plan.attempts, async (attempt) => {",
     "  await inBatches(plan.decisions, async (d) => { await publishDecision(port, d, tally, log); });\n  await inBatches(plan.attempts, async (attempt) => {"),
    ('publisher reveals even when the seal was refused', 'src/servingPublisher.ts',
     "  if (!tally.record(await port.sealDecision(seal), `seal ${what}`, log)) return;",
     "  tally.record(await port.sealDecision(seal), `seal ${what}`, log);"),
    ('publisher stays silent on a refusal', 'src/servingPublisher.ts',
     "        log.error(`serving projection refused ${what}: ${detail(outcome)}`);",
     "        void what;"),
    ('a rejecting port escapes into the run', 'src/servingPublisher.ts',
     "    return await Promise.race([",
     "    if (write) return await write(); return await Promise.race(["),
    ('a silent port is waited on forever', 'src/servingPublisher.ts',
     "        timer = setTimeout(() => reject(new Timeout('write did not settle')), timeoutMs);",
     "        timer = setTimeout(() => reject(new Timeout('write did not settle')), 86_400_000);"),
    ('the publication budget is never checked', 'src/servingPublisher.ts',
     "    if (nowMs() < expiresAt) return false;",
     "    if (true) return false;"),
    ('abandoned work is not reported', 'src/servingPublisher.ts',
     "    tally.skipped.push(reason);",
     "    void reason;"),
    ('the canonical integrity check is skipped', 'src/servingPublisher.ts',
     "  if (broken !== null) return refuse(broken);",
     "  void broken;"),
    ('the integrity check uses the CURRENT roster', 'src/servingProjection.ts',
     "  const violations = verifyRunIntegrity(run, { expectedArms: [...declared.values()] });",
     "  const violations = verifyRunIntegrity(run);"),
    ('a gate refusal reads as success', 'src/servingPublisher.ts',
     "      gateRefusal: reason,",
     "      gateRefusal: null,"),
    ('sourceSha256 hashes the records, not the file', 'src/servingPublisher.ts',
     "    sourceSha256: sha256Hex(text),",
     "    sourceSha256: sha256Hex(records.map((r) => JSON.stringify(r)).join('\\n')),"),
    ('pool exceeds the role connection limit', 'src/benchmarkServingClient.ts',
     "export const SERVING_POOL_MAX = 4;",
     "export const SERVING_POOL_MAX = 10;"),
    ('ssl key attached as undefined', 'src/benchmarkServingClient.ts',
     "      ...(connection.ssl === undefined ? {} : { ssl: connection.ssl }),",
     "      ssl: connection.ssl,"),
    ('status line names the target', 'src/benchmarkServingClient.ts',
     "    ? 'serving projection: enabled'",
     "    ? `serving projection: enabled (${process.env['BENCHMARK_DB_URL'] ?? ''})`"),
]


def digest(path):
    with io.open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def apply(path, old, new):
    with io.open(path, encoding='utf-8', newline='') as fh:
        text = fh.read()
    nl = '\r\n' if '\r\n' in text else '\n'
    o = old.replace('\n', nl)
    n = new.replace('\n', nl)
    if text.count(o) != 1:
        return None
    with io.open(path, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text.replace(o, n))
    return True


def restore(rel):
    subprocess.run(['git', 'checkout', '--', rel], cwd=REPO, check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run_suite():
    proc = subprocess.Popen(
        'npx tsx --test ' + ' '.join(SUITE), cwd=REPO, shell=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        return proc.wait(timeout=90)
    except subprocess.TimeoutExpired:
        # Kill the TREE. Terminating the shell leaves node running, which is
        # how a hung mutant silently stalled the whole battery instead of
        # scoring. Windows-only; elsewhere the child is left to the OS.
        try:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            proc.kill()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            pass
        return 'HUNG'


def main():
    # REFUSE ON A DIRTY TREE. Every mutant is undone with `git checkout --`,
    # which restores to HEAD — so uncommitted work in a mutated file is not
    # restored, it is DESTROYED. This has happened twice; the guard is cheaper
    # than the recovery.
    dirty = subprocess.run(['git', 'status', '--porcelain', '--'] + sorted({m[1] for m in MUTANTS}),
                           cwd=REPO, capture_output=True, text=True).stdout.strip()
    if dirty:
        print('REFUSING: uncommitted changes in files this battery mutates.
'
              'Restoring a mutant discards them. Commit first.
' + dirty)
        return 2

    baseline = run_suite()
    if baseline != 0:
        print('BASELINE IS NOT GREEN (%s) — battery aborted' % baseline)
        return 1
    print('M0 control: suite green with no mutation applied\n', flush=True)

    tally = {'KILLED': 0, 'SURVIVED': 0, 'INVALID': 0, 'HUNG': 0}
    survivors = []
    for index, (label, rel, old, new) in enumerate(MUTANTS, 1):
        path = os.path.join(REPO, rel.replace('/', os.sep))
        before = digest(path)
        if apply(path, old, new) is None:
            print('%2d INVALID  %s  (pattern matched != 1)' % (index, label), flush=True)
            tally['INVALID'] += 1
            continue
        if digest(path) == before:
            restore(rel)
            print('%2d INVALID  %s  (file unchanged)' % (index, label), flush=True)
            tally['INVALID'] += 1
            continue
        try:
            code = run_suite()
        finally:
            restore(rel)
        if code == 'HUNG':
            verdict = 'HUNG'
        elif code == 0:
            verdict = 'SURVIVED'
            survivors.append(label)
        else:
            verdict = 'KILLED'
        tally[verdict] += 1
        print('%2d %-8s %s' % (index, verdict, label), flush=True)

    print('\n%s' % tally)
    if survivors:
        print('SURVIVORS:')
        for s in survivors:
            print('  - %s' % s)
    return 0


sys.exit(main())
