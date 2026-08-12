"""Mutation battery for the per-participant configuration slice.

ADVISORY. Run by hand, never in CI, and it gates nothing: it reports which
stated guarantees are enforced by a test and which are only asserted in prose.

    python tools/mutation-battery.py            # all mutants
    python tools/mutation-battery.py M07 M25    # named mutants only

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
     '    attempt.rawResponse !== null ||',
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
     '  if (capability < REQUIRED_SERVING_CAPABILITY) {',
     '  if (false) {',
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
    ('M93-deadline-default-not-wired', 'src/servingPublisher.ts',
     '  const nowMs = timing.nowMs ?? publicationNowMs;',
     '  const nowMs = timing.nowMs ?? Date.now;',
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
     "  stream.on('error', () => {",
     "  stream.on('__no_listener_for_error', () => {",
     ['src/benchmarkServingClient.test.ts']),
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
