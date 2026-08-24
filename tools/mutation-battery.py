"""Mutation battery for the per-participant configuration slice.

ADVISORY. Run by hand, never in CI, and it gates nothing: it reports which
stated guarantees are enforced by a test and which are only asserted in prose.

    python tools/mutation-battery.py            # all mutants
    python tools/mutation-battery.py M07-size-bound-in-characters   # named only

Selection is an EXACT match on the whole id, not a prefix: `M07` selects
nothing and prints only the control, which reads like a clean run. (This line
used to show the prefix form; it never worked.) Note also that the M00 control
runs the union of EVERY mutant's test files regardless of the subset chosen,
and refuses to proceed unless that union is green.

Every mutation disables ONE stated guarantee. A guarantee whose mutant SURVIVES
is a claim no test enforces, and the claim -- not the test -- is what gets
corrected. Verdicts are KILLED / SURVIVED / INVALID / HUNG, and the last two
matter as much as the first:

  * INVALID means the mutation did not change the file, usually because a
    refactor moved the code its needle pointed at. Scoring that as SURVIVED
    would invent a coverage gap; scoring it as KILLED would hide a real one.
  * HUNG means the suite did not finish. It is a distinct verdict because a
    battery whose failure mode is "produces no output" needs one.

Windows specifics, all learned the hard way and all load-bearing here:

  * `Popen` + `DEVNULL`, never `subprocess.run(timeout=..., shell=True)`. That
    call kills `cmd.exe` and leaves the `node` grandchild holding the stdout
    pipe, so the parent then blocks forever reading a pipe nobody will close --
    reporting nothing, scoring nothing, and orphaning test runners.
  * `taskkill /F /T` kills the process TREE, not just its root.
  * every verdict is flushed, so a wedged battery is distinguishable from a
    slow one.
  * the tree is restored in a `finally`, so a hang cannot stack the next mutant
    on top of the last. Check `git status` afterwards regardless.
"""
import hashlib
import io
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMEOUT = 240

# (id, file, needle, replacement, [test files whose failure counts as a kill])
MUTANTS = [
    # --- participantConfiguration.ts: the add-only merge -------------------
    ('M01-merge-overwrites', 'src/participantConfiguration.ts',
     '    throw new ConfigurationCollisionError(path);\n  }\n}',
     '    target[key] = cloneJson(incoming);\n  }\n}',
     ['src/requestShape.test.ts', 'src/participantConfiguration.test.ts']),
    ('M02-merge-is-noop', 'src/participantConfiguration.ts',
     '  const merged: Record<string, unknown> = { ...body };\n  mergeInto(merged, configuration, \'\');',
     '  const merged: Record<string, unknown> = { ...body };',
     ['src/requestShape.test.ts', 'src/participantConfiguration.test.ts']),
    ('M03-merge-shallow-only', 'src/participantConfiguration.ts',
     '    if (isPlainObject(existing) && isPlainObject(incoming)) {',
     '    if (false && isPlainObject(existing) && isPlainObject(incoming)) {',
     ['src/requestShape.test.ts', 'src/participantConfiguration.test.ts']),
    ('M04-merge-shares-structure', 'src/participantConfiguration.ts',
     '      target[key] = cloneJson(incoming);\n      continue;',
     '      target[key] = incoming;\n      continue;',
     ['src/participantConfiguration.test.ts']),

    # --- the digest ---------------------------------------------------------
    ('M05-digest-not-canonical', 'src/participantConfiguration.ts',
     'return sha256Hex(canonicalize(configuration));',
     'return sha256Hex(JSON.stringify(configuration));',
     ['src/participantConfiguration.test.ts']),

    # --- structural validation ---------------------------------------------
    ('M06-size-bound-removed', 'src/participantConfiguration.ts',
     '  if (bytes > MAX_CONFIGURATION_CANONICAL_BYTES) {',
     '  if (false && bytes > MAX_CONFIGURATION_CANONICAL_BYTES) {',
     ['src/participantConfiguration.test.ts']),
    ('M07-size-bound-in-characters', 'src/participantConfiguration.ts',
     "  const bytes = Buffer.byteLength(canonicalize(value), 'utf8');",
     '  const bytes = canonicalize(value).length;',
     ['src/participantConfiguration.test.ts']),
    ('M08-identifier-bound-removed', 'src/participantConfiguration.ts',
     '  if (identifierBytes > MAX_ENTRANT_IDENTIFIER_BYTES) {',
     '  if (false && identifierBytes > MAX_ENTRANT_IDENTIFIER_BYTES) {',
     ['src/participantConfiguration.test.ts']),
    ('M09-nonfinite-accepted', 'src/participantConfiguration.ts',
     "    if (!Number.isFinite(value)) violations.push(`${where} is a non-finite number`);",
     '    if (false) violations.push(`${where}`);',
     ['src/participantConfiguration.test.ts']),
    ('M10-proto-key-accepted', 'src/participantConfiguration.ts',
     '      if (key === FORBIDDEN_KEY) {\n        violations.push(`${where} uses the reserved key "${FORBIDDEN_KEY}"`);\n        continue;\n      }',
     '      if (false) { continue; }',
     ['src/participantConfiguration.test.ts']),

    # --- declared versus sent ----------------------------------------------
    ('M11-evidence-never-fires', 'src/participantConfiguration.ts',
     '  const violations: string[] = [];\n  for (const leaf of configurationLeaves(declared)) {',
     '  const violations: string[] = [];\n  for (const leaf of [] as Array<{ path: string; value: unknown }>) {',
     ['src/participantConfiguration.test.ts', 'src/scoring.test.ts', 'src/requestShape.test.ts']),
    ('M12-evidence-presence-only', 'src/participantConfiguration.ts',
     '    if (canonicalizeUnknown(found.value) !== canonicalizeUnknown(leaf.value)) {',
     '    if (false) {',
     ['src/participantConfiguration.test.ts', 'src/scoring.test.ts', 'src/requestShape.test.ts']),
    ('M13-leaves-top-level-only', 'src/participantConfiguration.ts',
     '    if (isPlainObject(member)) {\n      collectLeaves(member, segments, leaves);\n      continue;\n    }',
     '    if (false) { continue; }',
     ['src/participantConfiguration.test.ts']),

    # --- requestPlan.ts -----------------------------------------------------
    ('M14-evidence-empty', 'src/providers/requestPlan.ts',
     '    if (!prompt.has(key)) requestParams[key] = body[key];',
     '    if (false) requestParams[key] = body[key];',
     ['src/requestShape.test.ts']),
    ('M15-prompt-recorded', 'src/providers/requestPlan.ts',
     '  const prompt = new Set(spec.promptKeys);',
     '  const prompt = new Set<string>();',
     ['src/requestShape.test.ts']),
    ('M16-configuration-not-merged', 'src/providers/requestPlan.ts',
     '  const body = applyConfiguration(spec.body, spec.configuration);',
     '  const body = { ...spec.body };',
     ['src/requestShape.test.ts', 'src/records.test.ts']),

    # --- family.ts: the entrant collision -----------------------------------
    ('M17-collision-ignores-configuration', 'src/providers/family.ts',
     'JSON.stringify([id.trim().toLowerCase(), arm.configurationSha256])',
     'JSON.stringify([id.trim().toLowerCase()])',
     ['src/family.test.ts']),
    ('M18-collision-removed', 'src/providers/family.ts',
     '      if (prior && prior.participantId !== arm.participantId) {',
     '      if (false) {',
     ['src/family.test.ts', 'src/lineOpenSpine.test.ts']),

    # --- scoring.ts: the roster stamp is VERIFIED, not read ------------------
    ('M19-stamp-never-read', 'src/scoring.ts',
     '  if (run.armRoster !== null) {',
     '  if (false && run.armRoster !== null) {',
     ['src/scoring.test.ts']),
    ('M20-stamp-digest-not-recomputed', 'src/scoring.ts',
     '      if (recomputed !== entry.configurationSha256) {',
     '      if (false) {',
     ['src/scoring.test.ts']),
    ('M21-stamp-not-compared-to-precommitment', 'src/scoring.ts',
     '      if (entry.configurationSha256 !== expectedDigest) {',
     '      if (false) {',
     ['src/scoring.test.ts']),
    ('M22-response-digest-unchecked', 'src/scoring.ts',
     '      if (response.configurationSha256 !== entry.configurationSha256) {',
     '      if (false) {',
     ['src/scoring.test.ts']),
    ('M23-evidence-gate-skipped', 'src/scoring.ts',
     '      for (const violation of configurationEvidenceViolations(declared, attempt.requestParams)) {',
     '      for (const violation of [] as string[]) {',
     ['src/scoring.test.ts']),
    ('M24-stamp-parsed-as-absent', 'src/scoring.ts',
     '    armRoster: meta.armRoster ?? null,',
     '    armRoster: null,',
     ['src/scoring.test.ts']),
    ('M25-collision-input-drops-digest', 'src/scoring.ts',
     '      configurationSha256: configurationSha256(arm.configuration),\n      reportedModelIds:',
     "      configurationSha256: '',\n      reportedModelIds:",
     ['src/scoring.test.ts']),

    # --- records.ts: what gets stamped --------------------------------------
    ('M26-stamp-constant-configuration', 'src/records.ts',
     '        configuration: arm.configuration,\n        configurationSha256: configurationSha256(arm.configuration),',
     '        configuration: {},\n        configurationSha256: configurationSha256({}),',
     ['src/records.test.ts']),
    ('M27-arm-row-digest-dropped', 'src/records.ts',
     '      configurationSha256: configurationSha256(result.arm.configuration),\n      reportedModelId: reportedModelId(result),',
     '      reportedModelId: reportedModelId(result),',
     ['src/records.test.ts']),
    ('M28-roster-stamp-dropped', 'src/records.ts',
     '    armRoster: env.expectedArms.map((participantId) => {',
     '    armRosterDisabled: env.expectedArms.map((participantId) => {',
     ['src/records.test.ts']),

    # --- runner.ts: the configuration reaches the provider -------------------
    ('M29-runner-drops-configuration', 'src/runner.ts',
     '      configuration: adapter.arm.configuration,',
     '      configuration: {},',
     ['src/records.test.ts']),

    # --- manifestValidate.ts -------------------------------------------------
    ('M30-manifest-digest-unchecked', 'src/manifestValidate.ts',
     '    if (declared !== inCode) {',
     '    if (false) {',
     ['src/manifestValidate.test.ts']),
    ('M31-credential-check-removed', 'src/manifestValidate.ts',
     '  if (redactSecrets(canonicalText) !== canonicalText) {',
     '  if (false) {',
     ['src/manifestValidate.test.ts']),
    ('M32-mergeability-not-checked', 'src/manifestValidate.ts',
     '  violations.push(...mergeabilityViolations(arm.participantId, arm.configuration));',
     '  violations.push();',
     ['src/manifestValidate.test.ts']),
    ('M33-mergeability-samples-one-leg', 'src/manifestValidate.ts',
     "    { label: 'the initial leg', options: { tools: 'declared', maxOutputTokens: 16_000 } },",
     "    { label: 'the repair leg only', options: { tools: 'none', maxOutputTokens: 16_000 } },",
     ['src/manifestValidate.test.ts']),

    # --- fireArtifact.ts: the v1 identity refuses rather than drops -----------
    ('M34-identity-drops-configuration', 'src/fireArtifact.ts',
     '  if (Object.keys(entry.configuration).length > 0) {',
     '  if (false) {',
     ['src/fireArtifact.test.ts']),

    # --- manifest.ts: the schema gate ----------------------------------------
    ('M35-manifest-configuration-optional', 'src/manifest.ts',
     '    configuration: participantConfigurationSchema,',
     '    configuration: participantConfigurationSchema.optional().default({}),',
     ['src/manifest.test.ts', 'src/manifestValidate.test.ts']),
    ('M36-manifest-skips-configuration-validation', 'src/manifest.ts',
     '    for (const violation of configurationViolations(arm.configuration, {',
     '    for (const violation of [] as string[]) { void configurationViolations; }\n    for (const violation of [] as string[]) { void ({',
     ['src/manifest.test.ts']),
# --- fixes from the adversarial pass -------------------------------------
    ('M37-record-only-names-unprotected', 'src/providers/requestPlan.ts',
     '    if (recordOnly.has(key)) throw new ConfigurationRecordCollisionError(key);',
     '    if (false) throw new ConfigurationRecordCollisionError(key);',
     ['src/requestShape.test.ts']),
    ('M38-dotted-key-accepted', 'src/participantConfiguration.ts',
     "      if (key.includes('.')) {",
     "      if (false) {",
     ['src/participantConfiguration.test.ts']),
    ('M39-collision-digest-unvalidated', 'src/providers/family.ts',
     '    if (!/^[0-9a-f]{64}$/.test(arm.configurationSha256)) {',
     '    if (false) {',
     ['src/family.test.ts']),
    ('M40-no-boot-entrant-check', 'src/manifestValidate.ts',
     '    if (prior !== undefined && prior !== arm.participantId) {',
     '    if (false) {',
     ['src/manifestValidate.test.ts']),
    ('M41-configuration-checks-after-the-guards', 'src/manifestValidate.ts',
     '    for (const violation of configurationViolationsFor(arm)) {\n      violations.push(`roster arm "${arm.participantId}" ${violation}`);\n    }\n    if (seen.has(arm.participantId)) {',
     '    if (seen.has(arm.participantId)) {',
     ['src/manifestValidate.test.ts']),
    ('M42-stamped-provider-unchecked', 'src/scoring.ts',
     '      if (entry.provider !== arm.provider) {',
     '      if (false) {',
     ['src/scoring.test.ts']),
    ('M43-stamped-model-unchecked', 'src/scoring.ts',
     '      if (entry.requestedModelId !== arm.requestedModelId) {',
     '      if (false) {',
     ['src/scoring.test.ts']),
    ('M44-decision-digest-unchecked', 'src/scoring.ts',
     '      if (pick.configurationSha256 !== entry.configurationSha256) {',
     '      if (false) {',
     ['src/scoring.test.ts']),
    ('M45-decision-missing-digest-allowed', 'src/scoring.ts',
     '      if (pick.configurationSha256 === null) {',
     '      if (false) {',
     ['src/scoring.test.ts']),
    # Two `['repair', response.repair],` lines exist; anchor on the one paired
    # with the attempt leg inside the evidence loop.
    ('M46-repair-leg-not-evidenced', 'src/scoring.ts',
     "      ['attempt', response.attempt],\n      ['repair', response.repair],",
     "      ['attempt', response.attempt],",
     ['src/scoring.test.ts']),
    ('M47-mock-drops-configuration', 'src/mock.ts',
     '        requestParams: applyConfiguration(response.requestParams, configuration),',
     '        requestParams: response.requestParams,',
     ['src/requestShape.test.ts']),
    ('M48-fake-drops-configuration', 'src/realShapedFake.ts',
     '        requestParams: applyConfiguration(response.requestParams, configuration),',
     '        requestParams: response.requestParams,',
     ['src/requestShape.test.ts']),
# --- fixes from the PR #101 review ---------------------------------------
    ('M49-empty-nested-object-accepted', 'src/participantConfiguration.ts',
     "    if (!insideArray && segments.length > 0 && Object.keys(value).length === 0) {",
     '    if (false) {',
     ['src/participantConfiguration.test.ts', 'src/requestShape.test.ts']),
    ('M50-nul-accepted', 'src/participantConfiguration.ts',
     "return 'contains a NUL, which jsonb cannot store';",
     'return null;',
     ['src/participantConfiguration.test.ts']),
    ('M51-lone-surrogate-accepted', 'src/participantConfiguration.ts',
     "  if (LONE_SURROGATE.test(text)) return 'contains a lone surrogate, which is not valid JSON';",
     '  if (false) return null;',
     ['src/participantConfiguration.test.ts']),
    ('M52-raw-proto-not-prescanned', 'src/manifest.ts',
     '  if (protoAt !== null) {',
     '  if (false) {',
     ['src/manifest.test.ts']),
    ('M53-erased-request-evidence-allowed', 'src/scoring.ts',
     '        if (run.armRoster !== null && reachedProvider(attempt)) {',
     '        if (false) {',
     ['src/scoring.test.ts']),
    ('M54-reached-provider-always-false', 'src/scoring.ts',
     '    attempt.answerText !== null ||',
     '    false ||',
     ['src/scoring.test.ts']),
# --- the empty-key / path-encoding correction -----------------------------
    ('M55-empty-key-accepted', 'src/participantConfiguration.ts',
     "      if (key === '') {",
     '      if (false) {',
     ['src/participantConfiguration.test.ts']),
    # COMPOUND, and it has to be. Mutating the root sentinel alone is an
    # EQUIVALENT mutant: with the empty-key rule in force no path segment can
    # ever be the empty string, so `segments.length > 0` and
    # `segments.join('.') !== ''` cannot disagree, and it would report SURVIVED
    # forever. Disabling BOTH is what scores the second line of defence --
    # measured: with only the key rule gone, the sentinel fix still refuses
    # `{"":{}}` as an empty object.
    ('M56-both-empty-key-defences-removed', 'src/participantConfiguration.ts',
     ("      if (key === '') {",
      "    if (!insideArray && segments.length > 0 && Object.keys(value).length === 0) {"),
     ('      if (false) {',
      "    if (!insideArray && segments.join('.') !== '' && Object.keys(value).length === 0) {"),
     ['src/participantConfiguration.test.ts']),
    ('M57-resolution-splits-a-joined-path', 'src/participantConfiguration.ts',
     '    const found = resolvePath(requestParams, leaf.segments);',
     "    const found = resolvePath(requestParams, leaf.path.split('.'));",
     ['src/participantConfiguration.test.ts']),
# --- publication mechanics: the process bound, the entrant, the gate --------
# Everything below pins a guarantee this PR states in prose. A guarantee with
# no mutant behind it is a sentence, not a property.
    ('M58-close-never-destroys-handles', 'src/benchmarkServingClient.ts',
     '  if (drained) return;',
     '  return;',
     ['src/benchmarkServingClient.test.ts']),
    ('M59-release-without-the-error', 'src/store/campaignTickJournal.ts',
     '        client.release(failure);',
     '        client.release();',
     ['src/store/campaignTickJournal.test.ts']),
    # Removes the bound rather than lengthening it. A mutant that sets the
    # deadline to an hour is UNSCOREABLE: the timer is ref'd (deliberately, so a
    # short one cannot let Node exit mid-await), so an hour-long one holds the
    # process and the battery reports HUNG instead of a verdict. Deleting the
    # race leaves nothing ref'd, so the suite fails on its own timeout and the
    # process still drains.
    ('M60-rollback-unbounded', 'src/store/campaignTickJournal.ts',
     "          await Promise.race([\n"
     "            client.query('rollback', []),\n"
     "            new Promise((_, reject) => {\n"
     "              timer = setTimeout(() => reject(new Error('rollback did not answer')), rollbackTimeoutMs);\n"
     "            }),\n"
     "          ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });",
     "          await client.query('rollback', []);",
     ['src/store/campaignTickJournal.test.ts']),
    ('M61-no-driver-read-timeout', 'src/benchmarkServingClient.ts',
     '    query_timeout: QUERY_TIMEOUT_MS,',
     '    query_timeout: 0,',
     ['src/benchmarkServingClient.test.ts']),
    ('M62-server-gives-up-after-the-driver', 'src/benchmarkServingClient.ts',
     'export const STATEMENT_TIMEOUT_MS = 8_000;',
     'export const STATEMENT_TIMEOUT_MS = 12_000;',
     ['src/benchmarkServingClient.test.ts']),
    ('M63-drift-count-ignored', 'src/servingStore.ts',
     '  if (driftRows > 0) {',
     '  if (false) {',
     ['src/servingStore.test.ts']),
    ('M64-a-drift-source-loses-its-label', 'src/servingStore.ts',
     "  select coalesce(t.f, 'drift.unlabelled') as f\n    from public.benchmark_participants p, input,",
     "  select t.f\n    from public.benchmark_participants p, input,",
     ['src/servingStore.test.ts']),
    ('M65-parent-found-back-to-a-literal', 'src/servingStore.ts',
     '       (select gate.ok::int from gate)        as parent_found,',
     '       1                                      as parent_found,',
     ['src/servingStore.test.ts']),
    ('M66-a-control-may-declare-a-model', 'src/servingStore.ts',
     "    if (declared) refuse('configuration_on_non_model', 'participant.modelId');",
     "    if (false) refuse('configuration_on_non_model', 'participant.modelId');",
     ['src/servingStore.test.ts']),
    ('M67-a-model-may-declare-half-an-identity', 'src/servingStore.ts',
     '  if (participant.modelId === null || participant.configuration === null) {',
     '  if (false) {',
     ['src/servingStore.test.ts']),
    ('M68-configuration-sent-uncanonicalised', 'src/servingStore.ts',
     '    configuration_canonical: canonicalConfigurationText(configuration),',
     '    configuration_canonical: JSON.stringify(configuration),',
     ['src/servingStore.test.ts']),
    ('M69-entrant-identity-not-drift-checked', 'src/servingStore.ts',
     '                 p.model_id     is distinct from input.model_id,',
     '                 false,',
     ['src/servingStore.test.ts']),
    ('M70-unconfigured-reads-as-success', 'src/projectRunMain.ts',
     '      ? PROJECT_EXIT.unconfigured',
     '      ? PROJECT_EXIT.ok',
     ['src/projectRunMain.test.ts']),
    ('M71-a-refused-publisher-reads-as-success', 'src/projectRunMain.ts',
     '      : PROJECT_EXIT.refused;',
     '      : PROJECT_EXIT.ok;',
     ['src/projectRunMain.test.ts']),
# --- the seal's immutable facts, the rationale binding, the capability gate ---
    ('M72-only-the-forecast-digest-is-drift-checked', 'src/servingStore.ts',
     "                 d.rationale_digest is distinct from input.rationale_digest,",
     '                 false,',
     ['src/servingStore.test.ts']),
    ('M73-rationale-not-bound-to-its-seal', 'src/servingStore.ts',
     '   where parent.rationale_digest is distinct from input.rationale_digest',
     '   where false',
     ['src/servingStore.test.ts']),
    ('M74-rationale-digest-taken-before-redaction', 'src/servingStore.ts',
     '    rationale_digest: sha256Hex(prose),',
     '    rationale_digest: sha256Hex(rationale.rationale),',
     ['src/servingStore.test.ts']),
    ('M75-any-capability-will-do', 'src/benchmarkServingClient.ts',
     '  if (capability < requiredCapability) {',
     '  if (false) {',
     ['src/benchmarkServingClient.test.ts']),
    # The caller's requirement, not the run paths' constant, is what decides:
    # a build that quietly compares against REQUIRED_SERVING_CAPABILITY opens
    # the scores publisher against a schema that cannot hold a label. Killed by
    # the scores-held probe mode, whose answer satisfies the constant and falls
    # short of the requirement.
    ('M75b-requirement-collapses-to-the-constant', 'src/benchmarkServingClient.ts',
     '  const requiredCapability = options.requiredCapability ?? REQUIRED_SERVING_CAPABILITY;',
     '  const requiredCapability = REQUIRED_SERVING_CAPABILITY;',
     ['src/benchmarkServingClient.test.ts']),
    ('M76-unreadable-capability-reads-as-current', 'src/benchmarkServingClient.ts',
     '    capability = 0;',
     '    capability = REQUIRED_SERVING_CAPABILITY;',
     ['src/benchmarkServingClient.test.ts']),
    ('M77-a-text-version-satisfies-the-gate', 'src/benchmarkServingClient.ts',
     "  return typeof version === 'number' && Number.isInteger(version) ? version : 0;",
     '  return Number(version);',
     ['src/benchmarkServingClient.test.ts']),

    # --- PR4: the run paths publish, and cannot be failed by publishing ----
    ('M78-mirror-rethrows', 'src/servingPublisher.ts',
     '    return null;\n  }\n}',
     '    throw error;\n  }\n}',
     ['src/servingPublisher.test.ts', 'src/watch.test.ts']),
    ('M79-integrity-unguarded', 'src/servingPublisher.ts',
     '  let broken: string | null;\n  try {\n    broken = verifyArtifactIntegrity(text);\n'
     '  } catch (error) {\n    broken = `the artifact could not be verified (${describeError(error)})`;\n  }',
     '  const broken = verifyArtifactIntegrity(text);',
     ['src/servingPublisher.test.ts']),
    ('M80-deadline-on-wall-clock', 'src/servingPublisher.ts',
     'export const publicationNowMs = (): number => performance.now();',
     'export const publicationNowMs = (): number => Date.now();',
     ['src/servingPublisher.test.ts']),
    ('M81-fire-does-not-publish', 'src/watch.ts',
     '  await mirrorRunArtifact(cfg.serving, runFile, { line: cfg.log, error: cfg.logError });',
     '  if (runFile === \'\') await mirrorRunArtifact(cfg.serving, runFile, { line: cfg.log, error: cfg.logError });',
     ['src/watch.test.ts']),
    ('M82-watch-dry-run-dials', 'src/watchMain.ts',
     '  const serving = options.dryRun\n    ? dryRunServing()\n    : await openBenchmarkServing({ onError: printError });',
     '  const serving = await openBenchmarkServing({ onError: printError });',
     ['src/servingActivation.test.ts']),
    ('M83-smoke-dry-run-dials', 'src/shadowSmoke.ts',
     '  const serving = options.dryRun\n    ? dryRunServing()\n    : await openBenchmarkServing({ onError: printError });',
     '  const serving = await openBenchmarkServing({ onError: printError });',
     ['src/servingActivation.test.ts']),

    # --- PR4: the schema gate's own safety properties ----------------------
    ('M84-writable-reads-as-readonly', 'src/servingSchemaGate.ts',
     "  return {\n    ok: false,\n    detail:\n      'this connection ACCEPTED a write.",
     "  return {\n    ok: true,\n    detail:\n      'this connection ACCEPTED a write.",
     ['src/servingSchemaGate.test.ts']),
    ('M85-local-by-string-prefix', 'src/servingSchemaGate.ts',
     "  if (connection.kind === 'derived') return isLocalHost(connection.host);",
     "  if (connection.kind === 'derived') return connection.host.startsWith('127.')"
     " || connection.host === 'localhost';",
     ['src/servingSchemaGate.test.ts']),
    ('M86-informational-becomes-decisive', 'src/servingSchemaGate.ts',
     '      findings.filter((finding) => !finding.informational && !finding.ok).length +',
     '      findings.filter((finding) => !finding.ok).length +',
     ['src/servingSchemaGate.test.ts']),
    ('M87-no-row-count-bookend', 'src/servingSchemaGate.ts',
     '      (unmoved ? 0 : 1);',
     '      0;',
     ['src/servingSchemaGate.test.ts']),
    ('M88-runs-checks-on-a-writable-connection', 'src/servingSchemaGate.ts',
     '    if (!readOnly.ok) return GATE_EXIT.refused;',
     '',
     ['src/servingSchemaGate.test.ts']),

    # --- PR4 round 2: a dropped connection must not kill the process --------
    ('M89-pool-has-no-error-listener', 'src/benchmarkServingClient.ts',
     "  pool.on('error', (error: unknown) => {",
     "  pool.on('__no_listener_for_error', (error: unknown) => {",
     ['src/benchmarkServingClient.test.ts']),
    ('M90-pinned-client-has-no-error-listener', 'src/store/campaignTickJournal.ts',
     "      client.on?.('error', absorb);",
     '      void absorb;',
     ['src/store/campaignTickJournal.test.ts', 'src/benchmarkServingClient.test.ts']),

    # --- PR4 round 2: the gate's widened questions --------------------------
    ('M91-reach-check-ignores-column-grants', 'src/servingSchemaGate.ts',
     "                      has_any_column_privilege(c.oid, 'SELECT')",
     "                      has_table_privilege(c.oid, 'SELECT')",
     ['src/servingSchemaGate.test.ts']),
    ('M92-bookend-treats-unreadable-as-unchanged', 'src/servingSchemaGate.ts',
     '    const unmoved = before !== null && after !== null && before === after;',
     '    const unmoved = before === after;',
     ['src/servingSchemaGate.test.ts']),
    # The publishScores sibling carries the identical three-line default block,
    # so both M93 needles anchor on the line that FOLLOWS the defaults — the
    # only line the two functions do not share.
    ('M93-deadline-default-not-wired', 'src/servingPublisher.ts',
     '  const nowMs = timing.nowMs ?? publicationNowMs;\n'
     '  const deadlineMs = timing.deadlineMs ?? PUBLICATION_DEADLINE_MS;\n'
     '  const perWriteTimeoutMs = timing.perWriteTimeoutMs ?? PER_WRITE_TIMEOUT_MS;\n'
     '  const tally = new Tally();\n'
     '  tally.skipped.push(...plan.skipped);',
     '  const nowMs = timing.nowMs ?? Date.now;\n'
     '  const deadlineMs = timing.deadlineMs ?? PUBLICATION_DEADLINE_MS;\n'
     '  const perWriteTimeoutMs = timing.perWriteTimeoutMs ?? PER_WRITE_TIMEOUT_MS;\n'
     '  const tally = new Tally();\n'
     '  tally.skipped.push(...plan.skipped);',
     ['src/servingPublisher.test.ts']),
    ('M93b-scores-deadline-default-not-wired', 'src/servingPublisher.ts',
     '  const nowMs = timing.nowMs ?? publicationNowMs;\n'
     '  const deadlineMs = timing.deadlineMs ?? PUBLICATION_DEADLINE_MS;\n'
     '  const perWriteTimeoutMs = timing.perWriteTimeoutMs ?? PER_WRITE_TIMEOUT_MS;\n'
     '  const tally = new Tally();\n'
     '  const budget = new Budget(nowMs, nowMs() + deadlineMs, perWriteTimeoutMs);',
     '  const nowMs = timing.nowMs ?? Date.now;\n'
     '  const deadlineMs = timing.deadlineMs ?? PUBLICATION_DEADLINE_MS;\n'
     '  const perWriteTimeoutMs = timing.perWriteTimeoutMs ?? PER_WRITE_TIMEOUT_MS;\n'
     '  const tally = new Tally();\n'
     '  const budget = new Budget(nowMs, nowMs() + deadlineMs, perWriteTimeoutMs);',
     ['src/servingPublisher.test.ts']),

    # --- PR4 round 3: the four blockers a second review found ---------------
    # B2: the listener that stops one uncaught crash must not become another.
    # The mutation keeps the block structure valid on purpose — replacing `try`
    # alone leaves a dangling `catch`, which is a syntax error, and a mutant that
    # cannot parse fails every mode for a reason unrelated to the guarantee.
    ('M94-error-sink-can-kill-the-process', 'src/benchmarkServingClient.ts',
     '    try {\n      onError(',
     '    if (true) {\n      onError(',
     ['src/benchmarkServingClient.test.ts']),
    ('M94b-error-sink-catch-removed', 'src/benchmarkServingClient.ts',
     '    } catch {\n      // ⚠ THE REPORTING PATH IS ITSELF A CRASH PATH.',
     '    } else if (false) {\n      // ⚠ THE REPORTING PATH IS ITSELF A CRASH PATH.',
     ['src/benchmarkServingClient.test.ts']),

    # B1.1: the forbidden readers, every verb rather than the two reads.
    ('M95-forbidden-readers-reads-only', 'src/servingSchemaGate.ts',
     "            where case when v in ('DELETE', 'TRUNCATE', 'TRIGGER')\n"
     "                       then has_table_privilege(r, 'public.' || t, v)\n"
     "                       else has_any_column_privilege(r, 'public.' || t, v) end`,",
     "            where v = 'SELECT' and has_any_column_privilege(r, 'public.' || t, v)`,",
     ['src/servingSchemaGate.test.ts']),

    # B1.2: RLS enabled is not the same as this role being able to write.
    ('M96-rls-policy-shape-unchecked', 'src/servingSchemaGate.ts',
     "        if (needsWrite && Number(row['writable']) === 0) {",
     "        if (false && needsWrite && Number(row['writable']) === 0) {",
     ['src/servingSchemaGate.test.ts']),
    ('M96b-restrictive-policy-ignored', 'src/servingSchemaGate.ts',
     "        if (Number(row['restrictive']) > 0) {",
     "        if (false && Number(row['restrictive']) > 0) {",
     ['src/servingSchemaGate.test.ts']),

    # B1.3: a SECURITY DEFINER function runs as its owner.
    ('M97-security-definer-ignored', 'src/servingSchemaGate.ts',
     '      if (rows.length === 0) {',
     '      if (true) {',
     ['src/servingSchemaGate.test.ts']),

    # A definer function is a way OUT for the writer and a way IN for a
    # browser-facing key. Asking only about the connected role closes one half.
    ('M98-security-definer-connected-role-only', 'src/servingSchemaGate.ts',
     "           cross join (select rolname::text as role from pg_roles\n"
     "                        where rolname = any($1::text[]) or rolname = current_user) as named",
     "           cross join (select current_user::text as role) as named",
     ['src/servingSchemaGate.test.ts']),

    # The async half of the reporting hazard: EPIPE is delivered as a stream
    # 'error' event AFTER the write returns, so the call-site try/catch (M94)
    # cannot see it. Distinct layers, distinct mutants.
    ('M99-no-stdio-error-guard', 'src/console.ts',
     "  stream.on('error', (error: unknown) => {",
     "  stream.on('__no_listener_for_error', (error: unknown) => {",
     ['src/benchmarkServingClient.test.ts']),

    # The guard must DISCRIMINATE, not blanket-absorb. An empty listener reads as
    # "tolerate a closed pipe" and behaves as "ignore every output fault".
    ('M100-guard-absorbs-everything', 'src/console.ts',
     '    if (isConsumerGone(error)) return;',
     '    return;',
     ['src/console.test.ts']),
    ('M100b-guard-reports-every-time', 'src/console.ts',
     '    if (reported) return;',
     '    if (false) return;',
     ['src/console.test.ts']),

    # The two installs are separate lines, and a case that emits on only one
    # stream leaves the other pinned by nothing. Measured: with the stderr emit
    # alone, deleting the stdout install left the suite green while a run piped
    # into `head` still died.
    ('M101-stdout-guard-not-installed', 'src/console.ts',
     "guardStream('stdout', process.stdout, (line) => process.stderr.write(",
     "void ('stdout', process.stdout, (line) => process.stderr.write(",
     ['src/benchmarkServingClient.test.ts']),
    ('M101b-stderr-guard-not-installed', 'src/console.ts',
     "guardStream('stderr', process.stderr, (line) => process.stdout.write(",
     "void ('stderr', process.stderr, (line) => process.stdout.write(",
     ['src/benchmarkServingClient.test.ts']),

    # Which stream the diagnostic lands on. Reporting a stdout fault onto stdout
    # writes to the stream that just failed, and the once-per-stream latch then
    # discards the resulting second error — total silence, suite green.
    ('M102-report-onto-the-broken-stream', 'src/console.ts',
     "guardStream('stdout', process.stdout, (line) => process.stderr.write(",
     "guardStream('stdout', process.stdout, (line) => process.stdout.write(",
     ['src/benchmarkServingClient.test.ts']),

    # --- The scores publisher: gate, mapping, statement, CLIs ----------------
    # SQL BEHAVIOR (a wrong-run score and a same-version different-value score
    # both landing as `contradiction`, a fresh-provenance replay landing as
    # `duplicate`) is pinned by `yarn store:serving` against real PostgreSQL;
    # the unit tier pins the statement's STRUCTURE and everything client-side.
    ('M103-dry-run-scores-publish', 'src/scoredProjection.ts',
     "  if (meta.sourceMode !== 'live') return no('the scored run was not a live run');",
     "  if (false) return no('the scored run was not a live run');",
     ['src/scoredProjection.test.ts', 'src/servingPublisher.test.ts']),
    ('M104-unverified-artifact-publishes', 'src/scoredProjection.ts',
     '  if (meta.integrityVerified !== true) {',
     '  if (false) {',
     ['src/scoredProjection.test.ts']),
    ('M105-second-meta-shadowed', 'src/scoredProjection.ts',
     '  if (metas.length > 1) {',
     '  if (false) {',
     ['src/scoredProjection.test.ts']),
    ('M106-cohort-namespace-open', 'src/scoredProjection.ts',
     "  if (!publishableCohortId(meta.cohortId)) return no('cohortId is outside the published namespace');",
     "  if (false) return no('cohortId is outside the published namespace');",
     ['src/scoredProjection.test.ts', 'src/scoring.test.ts']),
    ('M107-identity-coherence-unchecked', 'src/scoredProjection.ts',
     '      if (decision[field] !== expected) {',
     '      if (false) {',
     ['src/scoredProjection.test.ts']),
    ('M108-duplicate-pick-kept', 'src/scoredProjection.ts',
     '    if (seen.has(key)) {',
     '    if (false) {',
     ['src/scoredProjection.test.ts']),
    ('M109-refusal-equivalence-broken', 'src/scoredProjection.ts',
     '    refused: record.unscoredReason !== null,',
     '    refused: false,',
     ['src/scoredProjection.test.ts', 'src/scoring.test.ts']),
    ('M110-held-out-inverted', 'src/scoredProjection.ts',
     '    heldOutOfPrimary: !record.inPrimaryStratum,',
     '    heldOutOfPrimary: record.inPrimaryStratum,',
     ['src/scoredProjection.test.ts']),
    # The close columns swapped is the classic positional pair no round-trip of
    # symmetric fixtures can see; the killing fixture's decimals differ.
    ('M111-close-side-swapped', 'src/scoredProjection.ts',
     "        : record.side === 'away'\n          ? record.closing.awayDecimal\n          : record.closing.homeDecimal,",
     "        : record.side === 'away'\n          ? record.closing.homeDecimal\n          : record.closing.awayDecimal,",
     ['src/scoredProjection.test.ts', 'src/servingPublisher.test.ts']),
    # A hardcoded label or run id emits exactly what every default-valued
    # fixture carries; the killing test sits where fixture and hardcode differ.
    ('M112-label-minted-not-carried', 'src/scoredProjection.ts',
     '    label: record.label,',
     "    label: 'SMOKE_V0_NOT_A_COHORT',",
     ['src/scoredProjection.test.ts']),
    ('M112b-run-id-minted-not-carried', 'src/scoredProjection.ts',
     '    runId: record.runId,',
     "    runId: 'run-1',",
     ['src/scoredProjection.test.ts', 'src/servingPublisher.test.ts']),
    ('M113-score-statement-forgets-the-run', 'src/servingStore.ts',
     "  select 'score.runId' as f\n    from parent, input\n   where parent.run_id is distinct from input.run_id",
     "  select 'score.runId' as f\n    from parent, input\n   where false",
     ['src/servingStore.test.ts']),
    ('M113b-score-insert-ignores-drift', 'src/servingStore.ts',
     '    from parent, input\n   where not exists (select 1 from drift)\n  on conflict on constraint uq_benchmark_score_per_policy do nothing',
     '    from parent, input\n  on conflict on constraint uq_benchmark_score_per_policy do nothing',
     ['src/servingStore.test.ts']),
    # A name+flag PAIR deleted together keeps the unnest arrays parallel, so
    # only the insert-list-vs-drift-names set test can catch it.
    ('M113c-label-leaves-the-drift-comparison', 'src/servingStore.ts',
     ("'score.label','score.economicClvPct'",
      's.label                   is distinct from input.label,\n                 '),
     ("'score.economicClvPct'",
      ''),
     ['src/servingStore.test.ts']),
    ('M114-score-write-unserialized', 'src/servingStore.ts',
     '    return this.publish(SCORE_SQL, () => scorePayload(score), true);',
     '    return this.publish(SCORE_SQL, () => scorePayload(score));',
     ['src/servingStore.test.ts']),
    # The two entry wirings that decide which capability the scores paths ask
    # for. The probe's scores-held mode pins the OPTION working; these pin the
    # callers PASSING it.
    ('M115-project-scores-opens-at-run-capability', 'src/projectScoresMain.ts',
     '        requiredCapability: SCORES_SERVING_CAPABILITY,\n',
     '',
     ['src/scoredProjection.test.ts']),
    ('M115b-score-publish-opens-at-run-capability', 'src/scoreRun.ts',
     '      requiredCapability: SCORES_SERVING_CAPABILITY,\n',
     '',
     ['src/scoredProjection.test.ts']),
    # --publish is an explicit ask: a held publisher and a partial publication
    # must both reach the exit code.
    ('M116-publish-held-reads-as-success', 'src/scoreRun.ts',
     "      printError(`--publish was asked for, but nothing could be attempted`);\n      return 1;",
     "      printError(`--publish was asked for, but nothing could be attempted`);\n      return 0;",
     ['src/scoring.test.ts']),
    ('M116b-publish-partial-reads-as-success', 'src/scoreRun.ts',
     "    return unpublishedCount(summary, ndjsonPath, { line: printLine, error: printError }) > 0 ? 1 : 0;",
     "    return unpublishedCount(summary, ndjsonPath, { line: printLine, error: printError }) > 0 ? 0 : 0;",
     ['src/scoring.test.ts']),
    # The shared CLI core must ACCUMULATE failures, and a gate refusal must
    # surface its reason rather than fall through to the wrong branch.
    ('M117-cli-failures-not-accumulated', 'src/projectRunMain.ts',
     '      failed += unpublishedCount(summary, file, deps.log);',
     '      unpublishedCount(summary, file, deps.log);',
     ['src/projectRunMain.test.ts', 'src/projectScoresMain.test.ts']),
    ('M117b-gate-refusal-loses-its-reason', 'src/servingPublisher.ts',
     '  if (summary.gateRefusal !== null) {',
     '  if (false) {',
     ['src/projectRunMain.test.ts']),
    # --- Adversarial-review hardening: the three gate guards it demanded -----
    ('M118-refused-with-a-value-publishes', 'src/scoredProjection.ts',
     '    if (\n'
     '      decision.unscoredReason !== null &&\n'
     '      (decision.primaryClvPct !== null || decision.marginAdjustedClvPct !== null)\n'
     '    ) {',
     '    if (false) {',
     ['src/scoredProjection.test.ts']),
    ('M119-spliced-scorecard-tolerated', 'src/scoredProjection.ts',
     "    if (record['recordType'] !== 'participant_scorecard') continue;",
     '    if (true) continue;',
     ['src/scoredProjection.test.ts']),
    # A drift NAME labeling the comparison of a DIFFERENT column keeps the
    # arrays parallel and the name set right; only the positional pairing test
    # (and the per-arm conformance loop, on a database) can tell.
    ('M120-drift-arm-mislabeled', 'src/servingStore.ts',
     '                 s.devig_method            is distinct from input.devig_method,',
     '                 s.devig_method            is distinct from input.ladder_version,',
     ['src/servingStore.test.ts']),
    # --- The second review hold: truncation, and the label binding -----------
    # A truncated artifact must be caught by the file disagreeing with its own
    # declared counts; disabling the comparison republishes the review's
    # reproduction (meta declares 2 picks, file carries 1) as a clean pass.
    ('M121-truncated-artifact-publishes', 'src/scoredProjection.ts',
     '    if (carried !== declared) {',
     '    if (false) {',
     ['src/scoredProjection.test.ts', 'src/servingPublisher.test.ts']),
    # The scorer must bind its output to the SOURCE RUN's label. Hardcoding
    # the constant back reproduces the shipped defect exactly — and survives
    # every fixture whose run label IS the constant, which is all of them
    # except the one regression test written to sit where they differ.
    # A definer-function exemption that matches on the ROLE alone quietly
    # exempts every function that role will ever be granted — the gate's
    # tripwire for a NEW definer RPC would never fire again.
    ('M123-definer-exemption-widens-by-role', 'src/servingSchemaGate.ts',
     "  return DECLARED_DEFINER_EXEMPTIONS.has(`${role} -> ${fn}`);",
     "  return role === 'service_role';",
     ['src/servingSchemaGate.test.ts']),
    ('M122-scored-label-minted-not-carried', 'src/scoring.ts',
     ('    // here survived — a latent misbinding, caught in review.\n    label: run.label,',
      "      recordType: 'scored_decision',\n      label: run.label,",
      "      recordType: 'participant_scorecard',\n      label: run.label,"),
     ("    // here survived — a latent misbinding, caught in review.\n    label: 'SMOKE_V0_NOT_A_COHORT',",
      "      recordType: 'scored_decision',\n      label: 'SMOKE_V0_NOT_A_COHORT',",
      "      recordType: 'participant_scorecard',\n      label: 'SMOKE_V0_NOT_A_COHORT',"),
     ['src/scoring.test.ts']),
    # --- The third review hold: the definer census itself --------------------
    # Keying the exemption on the bare name re-admits the reproduced defect:
    # every overload of a declared name — functions nobody has reviewed — reads
    # as exempt. Killed by the census-shape assertion (the semantics live in
    # the SQL; no fake can evaluate them) and, on a real catalog, by the
    # gate-conformance overload scenario.
    ('M124-definer-overloads-collapse-to-a-name', 'src/servingSchemaGate.ts',
     "                n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,",
     "                n.nspname || '.' || p.proname as fn,",
     ['src/servingSchemaGate.test.ts']),
    # Reintroducing the row cap on the census re-admits the other half: an
    # undeclared function hiding behind 40 declared rows that sort ahead of it.
    ('M125-definer-census-capped-in-sql', 'src/servingSchemaGate.ts',
     '          order by 1, 2`,',
     '          order by 1, 2 limit 40`,',
     ['src/servingSchemaGate.test.ts']),
    # The same cap one layer up: a classification loop that stops at 40 rows
    # never sees the 41st. Killed by the 41-fake-row test, which sorts the
    # undeclared row exactly where the cut falls.
    ('M126-definer-census-capped-in-code', 'src/servingSchemaGate.ts',
     '      const present = new Set<string>();\n      for (const row of rows) {',
     '      const present = new Set<string>();\n      for (const row of rows.slice(0, 40)) {',
     ['src/servingSchemaGate.test.ts']),
    # --- Adversarial-pass hardening (workflow wj549fbc1) ---------------------
    # Dropping the search_path pin re-opens the false-RED the identity-args
    # census introduced: under a role default that excludes public, the twelve
    # custom-typed RPCs render as public.network and match no declared entry.
    # Killed by the GATE_STARTUP_OPTIONS unit test, and by the hostile-path
    # conformance scenario on a real database.
    ('M127-search-path-pin-dropped', 'src/servingSchemaGate.ts',
     'export const GATE_STARTUP_OPTIONS = `${READ_ONLY_STARTUP_OPTION} ${SEARCH_PATH_STARTUP_OPTION}`;',
     'export const GATE_STARTUP_OPTIONS = `${READ_ONLY_STARTUP_OPTION}`;',
     ['src/servingSchemaGate.test.ts']),
    # Negating the security-defining predicate is a TOTAL bypass — no definer
    # function is ever censused. Invisible to the unit fakes until the census
    # shape test pins the predicate positively AND against its negation.
    ('M128-prosecdef-predicate-negated', 'src/servingSchemaGate.ts',
     '            and p.prosecdef',
     '            and not p.prosecdef',
     ['src/servingSchemaGate.test.ts']),
    # The failure header must count the whole census, not the shown slice.
    # Undiscriminated by every one-violating-row fixture (the two counts
    # coincide); killed by the >20-row display-truncation test.
    ('M129-failure-header-counts-shown-not-all', 'src/servingSchemaGate.ts',
     '`${violating.length} executable as their owner: ${shown.join(\', \')}`',
     '`${shown.length} executable as their owner: ${shown.join(\', \')}`',
     ['src/servingSchemaGate.test.ts']),
# --- #92: retained provider response envelopes ----------------------------
# Every mutant below disables ONE stated guarantee of the retention change.
    # The enabling defect itself: with the received text unreachable, nothing
    # downstream can retain anything.
    ('M130-http-discards-the-received-body', 'src/providers/http.ts',
     "      return { status: response.status, json: JSON.parse(text) as unknown, bodyText: text };",
     "      return { status: response.status, json: JSON.parse(text) as unknown, bodyText: '' };",
     ['src/providers/responseEnvelope.test.ts']),
    # Byte fidelity. Killed only by a fixture whose received bytes differ from
    # its own JSON round trip -- NON_CANONICAL_BODY exists for exactly this.
    ('M131-envelope-stored-canonicalized', 'src/providers/responseEnvelope.ts',
     '  const body = redactSecrets(receivedBodyText);',
     '  const body = redactSecrets(JSON.stringify(JSON.parse(receivedBodyText)));',
     ['src/providers/responseEnvelope.test.ts']),
    # The digest must cover what is STORED. With no credential present,
    # redaction is the identity and this mutant is equivalent -- the credential
    # case is the only thing in the suite that discriminates it.
    ('M132-digest-taken-before-redaction', 'src/providers/responseEnvelope.ts',
     '    sha256: sha256Hex(body),',
     '    sha256: sha256Hex(receivedBodyText),',
     ['src/providers/responseEnvelope.test.ts']),
    ('M133-bytes-counts-characters', 'src/providers/responseEnvelope.ts',
     "    bytes: Buffer.byteLength(body, 'utf8'),",
     '    bytes: body.length,',
     ['src/providers/responseEnvelope.test.ts']),
    ('M134-digest-never-verified', 'src/providers/responseEnvelope.ts',
     "  if (sha256Hex(envelope.body) !== envelope.sha256) failures.push(ENVELOPE_VIOLATION.DIGEST);",
     '  if (false) failures.push(ENVELOPE_VIOLATION.DIGEST);',
     ['src/providers/responseEnvelope.test.ts', 'src/responseEnvelopeIntegrity.test.ts']),
    ('M135-byte-length-never-verified', 'src/providers/responseEnvelope.ts',
     "  if (Buffer.byteLength(envelope.body, 'utf8') !== envelope.bytes) {",
     '  if (false) {',
     ['src/providers/responseEnvelope.test.ts']),
    # An unfinished turn is a paid response and must retain its body too.
    ('M136-unfinished-turn-loses-its-envelope', 'src/runner.ts',
     '            responseEnvelope: error.responseEnvelope,',
     '            responseEnvelope: null,',
     ['src/runner.test.ts']),
    # The repair leg ONLY. A build that kept the initial envelope and dropped
    # the repair's would leave the ACCEPTED attempt unverifiable.
    ('M137-repair-envelope-dropped', 'src/records.ts',
     '      repair: result.repair === null ? null : attemptFields(result.repair),',
     '      repair: result.repair === null ? null : { ...attemptFields(result.repair), responseEnvelope: null },',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # Rule 3d, the same-typed positional swap: each field carries the other's
    # value, with a correctly recomputed digest so nothing fails for a
    # bookkeeping reason. Compound, because the swap needs the seal imported.
    ('M138-answer-and-envelope-swapped', 'src/records.ts',
     ("import { EVIDENCE_ERA } from './providers/responseEnvelope.js';",
      '    answerText: attempt?.rawText ?? null,',
      '    responseEnvelope: attempt?.responseEnvelope ?? null,'),
     ("import { EVIDENCE_ERA, sealResponseEnvelope } from './providers/responseEnvelope.js';",
      '    answerText: attempt?.responseEnvelope?.body ?? null,',
      '    responseEnvelope: attempt?.rawText == null ? null : sealResponseEnvelope(attempt.rawText),'),
     ['src/responseEnvelopeIntegrity.test.ts']),
    ('M139-era-stamp-omitted', 'src/records.ts',
     '    evidenceEra: EVIDENCE_ERA,',
     '    evidenceEra: undefined,',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # Rule 3k: the skip is an opt-out unless the skipped case is unreachable.
    ('M140-missing-envelope-always-skipped', 'src/scoring.ts',
     '        if (!preRetentionArchive && receivedProviderResponse(attempt)) {',
     '        if (false) {',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # The legacy field name must still be read, or every archived run stops
    # being scoreable the moment the rename lands.
    #
    # Scored on the integrity suite ALONE, deliberately. scoring.test.ts also
    # reddens under this mutant -- its whole fixture corpus uses the legacy
    # name -- but it takes over 240s to do it: with every archived body reading
    # as absent, the run integrity check re-derives and re-reports across the
    # entire corpus, and the battery reported HUNG rather than a verdict.
    # Measured 2026-08-21: 4m40s and still running, against ~20s clean. The
    # discriminating case is the archived-parity one in the integrity suite,
    # which fails mutated in 15s and passes clean.
    ('M141-archived-answer-name-ignored', 'src/scoring.ts',
     '            answerText: response.attempt.answerText ?? response.attempt.rawResponse ?? null,',
     '            answerText: response.attempt.answerText ?? null,',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # The reporting half: absence of an envelope must not be read as proof that
    # no search ran.
    ('M142-unavailable-backfilled-as-no-search', 'src/servingProjection.ts',
     "  if (searchAudit === null) return envelopeReplayable ? 'no_search_evidence' : 'unknown_unproven';",
     "  if (searchAudit === null) return 'no_search_evidence';",
     ['src/responseEnvelopeIntegrity.test.ts', 'src/servingProjection.test.ts']),
    # A tampered body is not evidence about the call it names, so the replay
    # must refuse it rather than extract from it.
    ('M143-replay-reads-a-tampered-body', 'src/searchAuditReplay.ts',
     '  if (envelopeVerificationFailures(envelope).length > 0) {',
     '  if (false) {',
     ['src/searchAuditReplay.test.ts']),

    # --- found by the adversarial pass, and SURVIVING before it -------------
    # Integrity is claimed for EVERY retained envelope, and on a repaired
    # decision the repair is the leg whose body backs the published forecast.
    # Every digest case tampered the initial leg, so verification could be
    # disabled for the repair alone and the whole suite stayed green.
    ('M144-repair-envelope-integrity-unchecked', 'src/scoring.ts',
     '      for (const failure of envelopeVerificationFailures(attempt.responseEnvelope)) {',
     "      for (const failure of leg === 'repair' ? [] : envelopeVerificationFailures(attempt.responseEnvelope)) {",
     ['src/responseEnvelopeIntegrity.test.ts']),
    # Rule 3k, the second half: sweep the predicate. `reachedProvider` is three
    # OR'd signals, and every fixture reaching the presence rule carried a
    # non-null answer text, so the other two disjuncts were dead and a build
    # consulting one signal exempted a leg whose answer had also been stripped.
    ('M145-presence-gate-reads-one-disjunct', 'src/scoring.ts',
     '        if (!preRetentionArchive && receivedProviderResponse(attempt)) {',
     '        if (!preRetentionArchive && attempt.answerText !== null) {',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # Idempotence on its own output. Rule 4b: the suite always runs
    # credential-free (only the entry points call `loadDotEnv`), so redaction
    # was the identity and the test asserted seal(x) == seal(x). The state the
    # claim is about -- a credential present, as under `yarn smoke` -- was the
    # one never exercised.
    ('M146-seal-not-idempotent-on-own-output', 'src/providers/responseEnvelope.ts',
     '  const body = redactSecrets(receivedBodyText);',
     "  const body = receivedBodyText.includes('[REDACTED]')\n    ? `${redactSecrets(receivedBodyText)} `\n    : redactSecrets(receivedBodyText);",
     ['src/providers/responseEnvelope.test.ts']),
    # Neither name present must be REFUSED, not read as a null answer. Both
    # field names are optional so a file carries one or the other; a record
    # carrying neither parsed as `answerText: null` and every rule that reads
    # the answer went quiet.
    ('M147-neither-answer-name-required', 'src/scoring.ts',
     '    if (value.answerText === undefined && value.rawResponse === undefined) {',
     '    if (false) {',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # The replay's two nulls. An envelope that is PRESENT but not well formed
    # was reported as `unavailable` at exit 0 -- the same conflation of "we
    # could not see" with "there was nothing to see" that #92 exists to remove.
    # The privacy claim: the envelope BODY reaches no published row. Scored by
    # publishing it, which is the only way to find out whether the marker scan
    # covers the surfaces it says it does (it scans the whole plan, not just the
    # attempt rows the envelope is nearest to).
    ('M149-envelope-body-published', 'src/servingProjection.ts',
     '    searchEvidenceStatus: searchEvidenceStatus(searchAudit, envelopeReplayable),',
     "    searchEvidenceStatus: searchEvidenceStatus(searchAudit, envelopeReplayable),\n    responseEnvelopeBody: (nested(leg, 'responseEnvelope') as { body?: string } | null)?.body ?? null,",
     ['src/responseEnvelopeIntegrity.test.ts']),
    ('M148-malformed-envelope-read-as-absent', 'src/searchAuditReplay.ts',
     "  if (read.kind === 'malformed') return { ...base, envelope: 'malformed' };",
     "  if (read.kind === 'malformed') return { ...base, envelope: 'unavailable' };",
     ['src/searchAuditReplay.test.ts']),

    # --- PR #109 round 2: the era redesign, the shared schema, the 2xx receipt
    # One schema, two readers (B1-b). The replay's own three `typeof` checks are
    # what the shared schema replaced: they accept an envelope carrying extra
    # keys, which the scorer refuses outright.
    ('M150-replay-keeps-its-own-loose-envelope-reader', 'src/searchAuditReplay.ts',
     ("  const parsed = responseEnvelopeSchema.safeParse(value);\n"
      "  if (!parsed.success) return { kind: 'malformed' };\n"
      "  return { kind: 'envelope', envelope: parsed.data };"),
     ("  const record = asRecord(value);\n"
      "  if (record === null) return { kind: 'malformed' };\n"
      "  const { body, sha256, bytes } = record;\n"
      "  if (typeof body !== 'string' || typeof sha256 !== 'string' || typeof bytes !== 'number') {\n"
      "    return { kind: 'malformed' };\n"
      "  }\n"
      "  return { kind: 'envelope', envelope: { body, sha256, bytes } };"),
     ['src/searchAuditReplay.test.ts', 'src/responseEnvelopeIntegrity.test.ts']),
    # The three schema rules, one mutant each. Each is killed only by the damage
    # case that isolates it -- an extra key, an upper-case digest, a fractional
    # byte count -- which is why the damage table has one boundary entry per rule
    # rather than one blunt "not an envelope" fixture.
    ('M151-envelope-schema-not-strict', 'src/providers/responseEnvelope.ts',
     "    bytes: z.number().int().nonnegative(),\n  })\n  .strict();",
     '    bytes: z.number().int().nonnegative(),\n  })\n  .passthrough();',
     ['src/providers/responseEnvelope.test.ts', 'src/searchAuditReplay.test.ts',
      'src/responseEnvelopeIntegrity.test.ts']),
    ('M152-digest-field-shape-unchecked', 'src/providers/responseEnvelope.ts',
     '    sha256: z.string().regex(/^[0-9a-f]{64}$/),',
     '    sha256: z.string(),',
     ['src/providers/responseEnvelope.test.ts', 'src/searchAuditReplay.test.ts',
      'src/responseEnvelopeIntegrity.test.ts']),
    ('M153-byte-count-shape-unchecked', 'src/providers/responseEnvelope.ts',
     '    bytes: z.number().int().nonnegative(),',
     '    bytes: z.number(),',
     ['src/providers/responseEnvelope.test.ts', 'src/searchAuditReplay.test.ts',
      'src/responseEnvelopeIntegrity.test.ts']),

    # B1 proper: the era redesign. The rule this replaces is the mutant --
    # deleting one optional field from a modern artifact turned presence off.
    ('M154-presence-gated-on-the-era-stamp-again', 'src/scoring.ts',
     '        if (!preRetentionArchive && receivedProviderResponse(attempt)) {',
     '        if (run.evidenceEra !== null && receivedProviderResponse(attempt)) {',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # The conjunction, one clause per mutant. A build missing any one of the
    # three hands the exemption to an edit that leaves the other two intact.
    ('M155-archive-ignores-the-envelope-key', 'src/providers/responseEnvelope.ts',
     '  return run.legs.every((leg) => leg.rawResponse && !leg.answerText && !leg.responseEnvelope);',
     '  return run.legs.every((leg) => leg.rawResponse && !leg.answerText);',
     ['src/providers/responseEnvelope.test.ts', 'src/responseEnvelopeIntegrity.test.ts',
      'src/searchAuditReplay.test.ts']),
    ('M156-archive-ignores-the-modern-answer-name', 'src/providers/responseEnvelope.ts',
     '  return run.legs.every((leg) => leg.rawResponse && !leg.answerText && !leg.responseEnvelope);',
     '  return run.legs.every((leg) => !leg.responseEnvelope);',
     ['src/providers/responseEnvelope.test.ts', 'src/responseEnvelopeIntegrity.test.ts']),
    ('M157-archive-ignores-the-era-stamp', 'src/providers/responseEnvelope.ts',
     '  if (run.evidenceEraStamped) return false;',
     '  if (false) return false;',
     ['src/providers/responseEnvelope.test.ts']),
    # Presence, not value. `responseEnvelope: null` is a key a retaining build
    # wrote; reading it as absent was a measured bypass.
    ('M158-era-signals-read-value-not-presence', 'src/providers/responseEnvelope.ts',
     "    responseEnvelope: Object.hasOwn(record, 'responseEnvelope'),",
     "    responseEnvelope: record['responseEnvelope'] != null,",
     ['src/providers/responseEnvelope.test.ts', 'src/responseEnvelopeIntegrity.test.ts']),
    # The predicate is a property of the FILE. Reading one leg lets a hand-edit
    # downgrade every other leg and keep the exemption.
    ('M159-archive-decided-from-one-leg', 'src/scoring.ts',
     '    legs: archivedLegs(run).map((attempt) => attempt.archiveEra),',
     '    legs: archivedLegs(run).slice(0, 1).map((attempt) => attempt.archiveEra),',
     ['src/responseEnvelopeIntegrity.test.ts']),
    ('M160-replay-archive-decided-from-one-leg', 'src/searchAuditReplay.ts',
     '    legs: raw.map((entry) => archiveEraSignals(entry.attempt)),',
     '    legs: raw.slice(0, 1).map((entry) => archiveEraSignals(entry.attempt)),',
     ['src/searchAuditReplay.test.ts']),
    ('M161-replay-era-stamp-read-by-type', 'src/searchAuditReplay.ts',
     "      if (Object.hasOwn(record, 'evidenceEra')) evidenceEraStamped = true;",
     "      if (typeof record['evidenceEra'] === 'string') evidenceEraStamped = true;",
     ['src/searchAuditReplay.test.ts']),

    # B1-a: the replay must agree with the scorer about PRESENCE.
    ('M162-unretained-collapsed-into-unavailable', 'src/searchAuditReplay.ts',
     "    return { ...base, envelope: owed ? 'unretained' : 'unavailable' };",
     "    return { ...base, envelope: 'unavailable' };",
     ['src/searchAuditReplay.test.ts']),
    ('M163-unretained-does-not-block', 'src/searchAuditReplay.ts',
     "  unretained: 'unretained',",
     "  unretained: 'clean',",
     ['src/searchAuditReplay.test.ts']),
    ('M164-quiet-prints-every-leg', 'src/searchAuditReplay.ts',
     "      if (quiet ? !isBlockingState(leg.envelope) : leg.envelope === 'retained' && !leg.changed) continue;",
     "      if (!quiet && leg.envelope === 'retained' && !leg.changed) continue;",
     ['src/searchAuditReplay.test.ts']),
    ('M165-unreadable-file-passes-silently', 'src/searchAuditReplay.ts',
     ("      deps.log.line(`${file}: unreadable run file: ${error instanceof Error ? error.message : String(error)}`);\n"
      '      blocking += 1;'),
     ('      deps.log.line(`${file}: unreadable run file: ${error instanceof Error ? error.message : String(error)}`);\n'
      '      blocking += 0;'),
     ['src/searchAuditReplay.test.ts']),

    # B2: a 2xx is a receipt, and its body is retained.
    ('M166-2xx-receipt-not-counted', 'src/providers/responseEnvelope.ts',
     '    isSuccessStatus(signals.httpStatus) ||',
     '    false ||',
     ['src/providers/responseEnvelope.test.ts', 'src/responseEnvelopeIntegrity.test.ts',
      'src/searchAuditReplay.test.ts']),
    ('M167-2xx-receipt-bound-widened-to-4xx', 'src/providers/responseEnvelope.ts',
     '    isSuccessStatus(signals.httpStatus) ||',
     '    signals.httpStatus !== null ||',
     ['src/providers/responseEnvelope.test.ts']),
    ('M168-content-predicate-widened-to-the-status', 'src/providers/responseEnvelope.ts',
     ('export function reachedProviderByContent(signals: ReceiptSignals): boolean {\n'
      '  return (\n'
      '    signals.answerText !== null ||'),
     ('export function reachedProviderByContent(signals: ReceiptSignals): boolean {\n'
      '  return (\n'
      '    signals.httpStatus !== null ||\n'
      '    signals.answerText !== null ||'),
     ['src/providers/responseEnvelope.test.ts']),
    ('M169-http-discards-an-unparseable-2xx-body', 'src/providers/http.ts',
     '        sealResponseEnvelope(text),',
     '        null,',
     ['src/providers/responseEnvelope.test.ts']),
    ('M170-http-retains-a-non-2xx-body', 'src/providers/http.ts',
     '        redactAndTruncate(text, 2000),\n      );',
     '        redactAndTruncate(text, 2000),\n        sealResponseEnvelope(text),\n      );',
     ['src/providers/responseEnvelope.test.ts']),
    ('M171-runner-drops-the-http-error-envelope', 'src/runner.ts',
     '            responseEnvelope:\n              error instanceof ProviderHttpError ? error.responseEnvelope : null,',
     '            responseEnvelope: null,',
     ['src/responseEnvelopeIntegrity.test.ts']),

    # B1-c: exactly one answer name.
    ('M172-both-answer-names-accepted', 'src/scoring.ts',
     '    if (value.answerText !== undefined && value.rawResponse !== undefined) {',
     '    if (false) {',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # Rule 3g-both: a rule written "refuse when they DIFFER" agrees with the
    # shipped rule on the differing fixture and disagrees on the byte-equal one.
    # Only the byte-equal fixture can kill this.
    ('M173-both-names-refused-only-when-they-differ', 'src/scoring.ts',
     '    if (value.answerText !== undefined && value.rawResponse !== undefined) {',
     '    if (value.answerText !== undefined && value.rawResponse !== undefined && value.answerText !== value.rawResponse) {',
     ['src/responseEnvelopeIntegrity.test.ts']),

    # --- the review round after B1/B2 ---------------------------------------
    # A body that dropped mid-read is a TRANSPORT failure. Reporting the header
    # status made an ordinary network event a 2xx receipt owing an envelope
    # that cannot exist, which refuses the whole run file.
    ('M174-http-reports-the-header-status-on-a-dropped-body', 'src/providers/http.ts',
     '        0,\n        `response body read failed:',
     '        response.status,\n        `response body read failed:',
     ['src/providers/responseEnvelope.test.ts', 'src/responseEnvelopeIntegrity.test.ts']),
    # THREE receipt carriers, because one was one edit: nulling `httpStatus` on
    # a contentless leg switched the envelope requirement back off.
    ('M175-receipt-ignores-the-prose-status', 'src/providers/responseEnvelope.ts',
     '    isSuccessStatus(statusFromErrorDetail(signals.errorDetail)) ||',
     '    false ||',
     ['src/providers/responseEnvelope.test.ts', 'src/responseEnvelopeIntegrity.test.ts',
      'src/searchAuditReplay.test.ts']),
    ('M176-prose-status-not-bounded-to-2xx', 'src/providers/responseEnvelope.ts',
     '    isSuccessStatus(statusFromErrorDetail(signals.errorDetail)) ||',
     '    statusFromErrorDetail(signals.errorDetail) !== null ||',
     ['src/providers/responseEnvelope.test.ts', 'src/searchAuditReplay.test.ts']),
    # Anchored: the leading clause is this call's own status, and a later
    # "returned HTTP 200" is a body the provider quoted back.
    ('M177-prose-status-read-unanchored', 'src/providers/responseEnvelope.ts',
     "  const match = /^\\S+ returned HTTP (\\d{1,3}):/.exec(errorDetail);",
     "  const match = /\\S+ returned HTTP (\\d{1,3}):/.exec(errorDetail);",
     ['src/providers/responseEnvelope.test.ts']),
    ('M178-receipt-ignores-a-deleted-status-key', 'src/providers/responseEnvelope.ts',
     '    !signals.httpStatusRecorded',
     '    false',
     ['src/providers/responseEnvelope.test.ts', 'src/responseEnvelopeIntegrity.test.ts',
      'src/searchAuditReplay.test.ts']),
    ('M179-scorer-assumes-the-status-key-is-there', 'src/scoring.ts',
     '            httpStatusRecorded: recordsHttpStatus(rawLegs.attempt),',
     '            httpStatusRecorded: true,',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # The scorer's OTHER install site for the era stamp. Every deletion-table
    # row but one deletes the stamp, so a build reading the legs alone answered
    # all of them correctly and this survived the whole suite.
    ('M180-scorer-ignores-the-era-stamp', 'src/scoring.ts',
     '    evidenceEraStamped: run.evidenceEra !== null,',
     '    evidenceEraStamped: false,',
     ['src/responseEnvelopeIntegrity.test.ts']),
    # The replay must read the pre-#92 answer name as a receipt, or every
    # archived leg in a file the archive predicate refuses is exempted.
    ('M181-replay-ignores-the-archived-answer-name', 'src/searchAuditReplay.ts',
     "    answerText: text(attempt['answerText']) ?? text(attempt['rawResponse']),",
     "    answerText: text(attempt['answerText']),",
     ['src/searchAuditReplay.test.ts']),
    # Presence is not replayability: a retained HTML error page verifies against
    # its own digest and supports no re-derivation, so publishing the provable
    # negative `no_search_evidence` for it is a claim nothing can check.
    ('M182-projection-reads-envelope-presence-only', 'src/servingProjection.ts',
     "  const envelopeReplayable = envelope !== null && parsesAsJson(str(envelope, 'body'));",
     '  const envelopeReplayable = envelope !== null;',
     ['src/responseEnvelopeIntegrity.test.ts', 'src/servingProjection.test.ts']),
    # --- Execution surface, capability-gated (indexer migration 079) ---------
    # The expected surface must widen ONLY when the schema reports capability 4.
    # Always widening is not a cosmetic over-statement: has_table_privilege
    # casts to regclass, so naming a table that does not exist raises 42P01 and
    # takes the whole statement with it. Measured against a real pre-079
    # database, this mutant turns the privilege grid and the browser-key check
    # red with `relation "public.benchmark_cohort_wallets" does not exist` —
    # two decisive failures about a schema that is perfectly fine.
    ('M183-execution-surface-always-expected', 'src/servingSchemaGate.ts',
     '  return version >= EXECUTION_SURFACE_CAPABILITY',
     '  return true',
     ['src/servingSchemaGate.test.ts']),
    # ...and the other direction: never widening leaves the three tables
    # outside the projection, so the reach check reports them as relations this
    # role should not touch on every post-079 database.
    ('M184-execution-surface-never-expected', 'src/servingSchemaGate.ts',
     '  return version >= EXECUTION_SURFACE_CAPABILITY',
     '  return false',
     ['src/servingSchemaGate.test.ts']),
    # --- The cohort-scalar scoring run (benchmark_scoring_runs) --------------
    # The publication brake. Until the drift CTE existed, a republish flipping
    # ranking_allowed from false to true reported `duplicate` -- success -- and
    # left the stored row saying false; measured on PostgreSQL 17.10. The row
    # is insert-once with no UPDATE grant, so whatever lands is what a public
    # read path serves forever.
    ('M185-scoring-run-insert-not-gated-on-drift', 'src/servingStore.ts',
     ('    from input\n   where not exists (select 1 from drift)',),
     ('    from input',),
     ['src/servingStore.test.ts']),
    # A name+flag PAIR leaving the comparison keeps the two unnest arrays equal
    # in length, so the cardinality check cannot see it -- only holding the
    # drift names against the INSERT list can.
    ('M186-ranking-brake-leaves-the-drift-comparison', 'src/servingStore.ts',
     ("                 'scoringRun.rankingAllowed','scoringRun.rankingReason',",
      '                 r.ranking_allowed          is distinct from input.ranking_allowed,\n'),
     ("                 'scoringRun.rankingReason',", ''),
     ['src/servingStore.test.ts']),
    # A drift NAME labelling another column's comparison: the set stays right,
    # the arrays stay parallel, and the operator flipping the brake is told the
    # wrong field moved.
    ('M187-scoring-run-drift-name-misattributed', 'src/servingStore.ts',
     ('           array[r.eligible                 is distinct from input.eligible,\n'
      '                 r.scored                   is distinct from input.scored,',),
     ('           array[r.scored                   is distinct from input.scored,\n'
      '                 r.eligible                 is distinct from input.eligible,',),
     ['src/servingStore.test.ts']),
    # The drift check without the lock reads a snapshot taken before the
    # statement began, so a concurrent writer's different row is invisible and
    # absorbed as `duplicate`. Measured elsewhere in this file as 58 of 100
    # races writing anyway; a drift check without the lock LOOKS like a
    # guarantee and is not one.
    ('M188-scoring-run-not-serialized', 'src/servingStore.ts',
     ('    return this.publish(SCORING_RUN_SQL, () => scoringRunPayload(run), true);',),
     ('    return this.publish(SCORING_RUN_SQL, () => scoringRunPayload(run));',),
     ['src/servingStore.test.ts']),
    # `eligible` is the OPPORTUNITY denominator -- supplied markets over
    # dispatched arm-games, so an arm that failed stays in it. Counting picks
    # instead publishes coverage computed over successes only, which is the
    # failure the run publisher's own contract names first.
    ('M189-eligible-counts-picks-not-opportunities', 'src/scoredProjection.ts',
     ('    eligible += artifact.eligibleMarkets;',),
     ('    eligible += artifact.decisions.length;',),
     ['src/scoredProjection.test.ts']),
    # `schedule_held_out` is what the reschedule tag REMOVED (tagged AND
    # carrying a value), not the raw stratum size. Taking the raw size
    # double-counts every pick that is both tagged and already refused, so the
    # coverage columns stop accounting for the picks. Only a fixture carrying
    # such a pick can tell the two readings apart.
    ('M190-held-out-is-the-raw-stratum-tag', 'src/scoredProjection.ts',
     ('        refused += 1;\n        refusalReasons[decision.unscoredReason] =',),
     ('        refused += 1;\n        if (!decision.inPrimaryStratum) scheduleHeldOut += 1;\n'
      '        refusalReasons[decision.unscoredReason] =',),
     ['src/scoredProjection.test.ts']),
    # A pick in no bucket folded into silence. `unscoredReason === null` implies
    # a primary value on every path the scorer can take, so a pick with neither
    # means the file is not its output -- and the scorer models the same
    # residual itself, calling it `unexplained`.
    ('M191-unexplained-picks-folded-away', 'src/scoredProjection.ts',
     ('  const unexplained = picks - scored - refused - scheduleHeldOut;',),
     ('  const unexplained = 0;',),
     ['src/scoredProjection.test.ts']),
    # The gate holds the artifact to its OWN declared coverage. Without it, a
    # meta spliced from another pass -- or records edited under a meta that was
    # not -- becomes the cohort coverage a public read path serves.
    ('M192-declared-coverage-unchecked', 'src/scoredProjection.ts',
     ("    ['scheduleChangedExcluded', meta.scheduleChangedExcluded, heldOut],\n"
      '  ] as const) {\n'
      '    if (declared !== derived) {',),
     ("    ['scheduleChangedExcluded', meta.scheduleChangedExcluded, heldOut],\n"
      '  ] as const) {\n'
      '    if (false) {',),
     ['src/scoredProjection.test.ts']),
    # One cohort per row, because (cohort, policy version) IS the key. A mixed
    # set would publish one cohort's numbers under the other's name, and the
    # write could not tell: the key it lands on is whichever header was read
    # first.
    ('M193-cohort-coherence-unchecked', 'src/scoredProjection.ts',
     ('    if (header.cohortId !== first.cohortId) {',),
     ('    if (false) {',),
     ['src/scoredProjection.test.ts']),
    # The same artifact supplied twice doubles every count, which is what
    # naming a file and its copy, or two overlapping globs, actually does.
    ('M194-duplicate-artifact-unchecked', 'src/scoredProjection.ts',
     ('    if (runIds.has(header.runId)) {',),
     ('    if (false) {',),
     ['src/scoredProjection.test.ts']),
    # The default brake OPENS. `ranking_allowed` decides whether a public read
    # path may order a leaderboard at all, and the row is insert-once, so a
    # default that opens cannot be taken back through the publisher.
    ('M195-default-ranking-brake-opens', 'src/scoredProjection.ts',
     ("  allowed: false,\n  reason: 'label: watch-v0 pending operator publication decision',",),
     ("  allowed: true,\n  reason: 'label: watch-v0 pending operator publication decision',",),
     ['src/scoredProjection.test.ts', 'src/projectScoresMain.test.ts']),
    # ...and the same brake, one layer up: an argv the parser does not
    # understand must leave the gate shut rather than open it.
    ('M196-cli-ranking-flag-inverted', 'src/projectScoresMain.ts',
     ("    allowed: argv.includes('--ranking-allowed'),",),
     ("    allowed: !argv.includes('--ranking-allowed'),",),
     ['src/projectScoresMain.test.ts']),
    # The cohort pass must see EVERY file the command was given -- the row is a
    # sum across them, and a pass over one file of a fifteen-game cohort
    # publishes one game's coverage as the whole day's.
    ('M197-cohort-pass-sees-one-file', 'src/projectRunMain.ts',
     ('        failed += await deps.finish(serving.port, files, deps.log);',),
     ('        failed += await deps.finish(serving.port, files.slice(0, 1), deps.log);',),
     ['src/projectScoresMain.test.ts']),
    # ...and its failures must reach the exit code. This command exists only to
    # publish, so a coverage row that did not land is its failure.
    ('M198-cohort-pass-failures-swallowed', 'src/projectRunMain.ts',
     ('        failed += await deps.finish(serving.port, files, deps.log);',),
     ('        await deps.finish(serving.port, files, deps.log);',),
     ['src/projectScoresMain.test.ts']),
    # The manifest a cohort row cites must be order-independent: the shell's
    # glob order is not a property of the cohort, and two invocations over the
    # same files must produce the same digest and the same path list.
    ('M199-manifest-not-sorted', 'src/servingPublisher.ts',
     ('    .sort();\n  return {\n    sourcePath: [...names].sort().join(\' \'),',),
     ('    ;\n  return {\n    sourcePath: [...names].join(\' \'),',),
     ['src/servingPublisher.test.ts']),
    # A file the scored gate refused must be EXCLUDED from the cohort AND
    # reported -- its picks are not in the projection either, so counting it
    # would publish a denominator for rows nobody can look up, and dropping it
    # silently would let the command exit 0 on a partial cohort.
    ('M200-refused-artifact-silently-dropped', 'src/servingPublisher.ts',
     ('      tally.skipped.push(`no scoring run: ${reason} is not publishable`);',),
     ('      // dropped',),
     ['src/servingPublisher.test.ts']),
    # --- The two PR #114 review blockers (Hermes, exact head 2bc3999) --------
    # BLOCKER 1a: the cohort row is written even though a file did not publish
    # in full. The row is insert-once, so the partial row is the one a read
    # path serves and the CORRECT set is refused against it afterwards; a
    # non-zero exit does not undo a durable row. Reproduced by the reviewer and
    # again here before the guard existed.
    ('M201-cohort-row-written-after-a-partial-pass', 'src/projectRunMain.ts',
     ('      if (failed === 0) {',),
     ('      if (true) {',),
     ['src/projectScoresMain.test.ts']),
    # BLOCKER 1b: the same hole one layer down — excluding the unpublishable
    # artifact and publishing a row from the survivors. Measured before the
    # fix: one valid artifact beside one refused artifact published
    # `eligible=3 scored=1 rankingAllowed=true`.
    ('M202-partial-set-still-publishes-a-cohort-row', 'src/servingPublisher.ts',
     ('  if (unreadable.length > 0) {',),
     ('  if (false) {',),
     ['src/servingPublisher.test.ts']),
    # The two phases must run off ONE parse. A build that goes back to disk for
    # the cohort row can summarise different bytes than the scores cited.
    ('M203-cohort-phase-rereads-from-disk', 'src/servingPublisher.ts',
     ('        const snapshot = accepted.get(file);',),
     ('        const reread = readScoredArtifact(file);\n'
      '        const snapshot = reread.ok\n'
      '          ? { file, artifact: reread.artifact, source: reread.source }\n'
      '          : undefined;',),
     ['src/servingPublisher.test.ts']),
    # BLOCKER 2a: scorecards without identity are an anonymous bag of numbers,
    # so a duplicate silently substitutes for a dispatched-but-scoreless arm and
    # its opportunities leave the denominator — survivor bias, which is the one
    # thing `eligible` exists to prevent.
    ('M204-duplicate-scorecards-admitted', 'src/scoredProjection.ts',
     ('    if (scorecards.has(parsed.data.participantId)) {',),
     ('    if (false) {',),
     ['src/scoredProjection.test.ts']),
    # BLOCKER 2b: a participant with picks and no scorecard leaves a hole in the
    # denominator that nothing else can see.
    ('M205-denominator-missing-an-arm-admitted', 'src/scoredProjection.ts',
     ('      if (carried.has(decision.participantId)) continue;',),
     ('      if (true) continue;',),
     ['src/scoredProjection.test.ts']),
    # ...and the scorecard's own count must answer to the records beside it,
    # or it is a number nothing corroborates.
    ('M206-scorecard-count-unreconciled', 'src/scoredProjection.ts',
     ('    if (declared === undefined) continue;\n    if (declared !== derived) {',),
     ('    if (declared === undefined) continue;\n    if (false) {',),
     ['src/scoredProjection.test.ts']),
]




def sha(path):
    with io.open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def run(files):
    """Run a test subset. Returns 'PASS' | 'FAIL' | 'HUNG'."""
    cmd = 'npx tsx --test ' + ' '.join(files)
    proc = subprocess.Popen(
        cmd, cwd=REPO, shell=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        return 'PASS' if proc.wait(timeout=TIMEOUT) == 0 else 'FAIL'
    except subprocess.TimeoutExpired:
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            pass
        return 'HUNG'


def main():
    only = sys.argv[1:] or None
    results = []

    # M0: the no-mutation control. If the suite is not green to begin with,
    # every "killed" verdict below is meaningless.
    control_files = sorted({f for m in MUTANTS for f in m[4]})
    print('M00-control (no mutation): ', end='', flush=True)
    control = run(control_files)
    print(control, flush=True)
    if control != 'PASS':
        sys.exit('REFUSING: the unmutated suite is not green; no verdict is trustworthy')

    for mid, relpath, needle, replacement, files in MUTANTS:
        if only and mid not in only:
            continue
        path = os.path.join(REPO, relpath)
        original = io.open(path, encoding='utf-8', newline='').read()
        before = sha(path)
        # A mutant may carry SEVERAL edits, so a guard that is shadowed by
        # another guard can still be scored: disable both and see whether
        # anything notices. A single-edit mutant on the shadowed one is
        # equivalent by construction and would only ever report SURVIVED.
        edits = needle if isinstance(needle, tuple) else (needle,)
        swaps = replacement if isinstance(replacement, tuple) else (replacement,)
        if len(edits) != len(swaps):
            print('%-42s INVALID (edit/replacement arity)' % mid, flush=True)
            results.append((mid, 'INVALID'))
            continue
        mutated = original
        failed = None
        for edit, swap in zip(edits, swaps):
            # The needle is written with \n; the tree may be CRLF. Try both, and
            # never fall back to a partial match.
            for candidate in (edit, edit.replace('\n', '\r\n')):
                if mutated.count(candidate) == 1:
                    nl = '\r\n' if '\r\n' in candidate else '\n'
                    mutated = mutated.replace(candidate, swap.replace('\n', nl))
                    break
            else:
                failed = mutated.count(edit) + mutated.count(edit.replace('\n', '\r\n'))
                break
        if failed is not None:
            print('%-42s INVALID (an edit matched %d times)' % (mid, failed), flush=True)
            results.append((mid, 'INVALID'))
            continue
        try:
            io.open(path, 'w', encoding='utf-8', newline='').write(mutated)
            if sha(path) == before:
                print('%-42s INVALID (file unchanged)' % mid, flush=True)
                results.append((mid, 'INVALID'))
                continue
            outcome = run(files)
            verdict = {'FAIL': 'KILLED', 'PASS': 'SURVIVED', 'HUNG': 'HUNG'}[outcome]
            print('%-42s %s' % (mid, verdict), flush=True)
            results.append((mid, verdict))
        finally:
            io.open(path, 'w', encoding='utf-8', newline='').write(original)
            assert sha(path) == before, 'restore failed for %s' % relpath

    print('')
    for verdict in ('KILLED', 'SURVIVED', 'INVALID', 'HUNG'):
        names = [m for m, v in results if v == verdict]
        print('%-9s %d%s' % (verdict, len(names), (': ' + ', '.join(names)) if names and verdict != 'KILLED' else ''))


if __name__ == '__main__':
    main()
