"""Offline adapter tests; synthetic metadata is not live publication evidence.

Only disposable Git, self-test and lock-holder subprocesses are real. The
installed adapter's first-record contract, not a new scoring schema, is tested.
"""
import contextlib
from dataclasses import FrozenInstanceError
import datetime as dt
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import score_and_publish_once as scorer

SCRIPT = Path(scorer.__file__).resolve()
POLICY = 'scoring-v0.6.2'


class FrozenClock(dt.datetime):
    @classmethod
    def now(cls, tz=None):
        # Still September 2 in New York; September 3 in UTC.
        value = cls(2026, 9, 3, 2, tzinfo=dt.timezone.utc)
        return value.astimezone(tz) if tz else value.replace(tzinfo=None)


class PathConfigurationTest(unittest.TestCase):
    def paths(self, env):
        with patch.dict(os.environ, env, clear=True), \
             patch('subprocess.run', side_effect=AssertionError('child forbidden')), \
             patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')), \
             patch('fcntl.flock', side_effect=AssertionError('lock forbidden')), \
             patch.object(Path, 'mkdir', side_effect=AssertionError('mkdir forbidden')):
            loaded = runpy.run_path(str(SCRIPT), run_name='scorer_config_fixture')
        return loaded['OUT_DIR'], loaded['LOCK_PATH']

    def test_default_state_is_under_isolated_home(self):
        with tempfile.TemporaryDirectory() as root:
            out, lock = self.paths({'HOME': root})
            self.assertEqual(out, Path(root) / '.ospex/decisions/out')
            self.assertEqual(lock, Path(root) / '.ospex/locks/score-publish.lock')
            self.assertEqual(list(Path(root).iterdir()), [])

    def test_state_override_is_independent_of_home(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / 'explicit-state'
            expected = (state / 'decisions/out', state / 'locks/score-publish.lock')
            for home in (str(Path(root) / 'other-home'), ''):
                with self.subTest(home_present=bool(home)):
                    env = {'OSPEX_STATE_DIR': str(state)}
                    if home:
                        env['HOME'] = home
                    self.assertEqual(self.paths(env), expected)
            self.assertFalse(state.exists())

    def test_explicit_lock_preserves_an_existing_lock_domain(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / 'state'
            lock = Path(root) / 'existing/shared-publisher.lock'
            self.assertEqual(self.paths({
                'OSPEX_STATE_DIR': str(state),
                'OSPEX_SCORE_PUBLISH_LOCK_PATH': str(lock),
            }), (state / 'decisions/out', lock))
            self.assertFalse(lock.exists())

    def test_configured_tilde_paths_expand_against_isolated_home(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(self.paths({
                'HOME': root, 'OSPEX_STATE_DIR': '~/state',
                'OSPEX_SCORE_PUBLISH_LOCK_PATH': '~/locks/shared.lock',
            }), (Path(root) / 'state/decisions/out', Path(root) / 'locks/shared.lock'))

    def test_empty_or_relative_configured_paths_fail_without_echoing_values(self):
        with tempfile.TemporaryDirectory() as root:
            for name in ('OSPEX_STATE_DIR', 'OSPEX_SCORE_PUBLISH_LOCK_PATH'):
                for value in ('', 'relative-private-state'):
                    with self.subTest(name=name, empty=not value):
                        with self.assertRaises(ValueError) as raised:
                            self.paths({'HOME': root, name: value})
                        self.assertEqual(str(raised.exception), f'{name} must be an absolute path')


class ScorerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        p = patch.dict(os.environ, {
            'PATH': os.defpath, 'HOME': str(self.root),
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_CONFIG_SYSTEM': os.devnull,
        }, clear=True)
        p.start()
        self.addCleanup(p.stop)
        self.real_subprocess = subprocess.run
        self.checkout = self.root / 'benchmark'
        self.checkout.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Offline Test')
        self.git('config', 'user.email', 'offline@example.invalid')
        (self.checkout / 'src').mkdir()
        self.policy_file = self.checkout / 'src/scoring.ts'
        self.policy_file.write_text(f"export const SCORING_POLICY_VERSION = '{POLICY}';\n")
        (self.checkout / '.gitignore').write_text('node_modules/\n')
        self.git('add', '.')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
        self.head = self.git('rev-parse', 'HEAD').stdout.strip()
        self.out = self.root / 'out'
        self.out.mkdir()
        self.lock = self.root / 'publisher.lock'
        # Fail closed on any unmocked live dependency; never inspect host config/out.
        for target, value in [('OUT_DIR', self.out), ('LOCK_PATH', self.lock)]:
            p = patch.object(scorer, target, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(scorer.urllib.request, 'urlopen', side_effect=AssertionError('network forbidden'))
        self.urlopen = p.start()
        self.addCleanup(p.stop)
        def git_only(argv, **kwargs):
            self.assertEqual(argv[0], 'git', 'unmocked non-Git child forbidden')
            self.assertTrue(Path(kwargs['cwd']).is_relative_to(self.root))
            return self.real_subprocess(argv, **kwargs)

        p = patch.object(scorer.subprocess, 'run', side_effect=git_only)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(scorer.dt, 'datetime', FrozenClock)
        p.start()
        self.addCleanup(p.stop)

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.checkout, check=True,
                              capture_output=True, text=True)

    def binding(self, checkout=None, head=None, policy=POLICY):
        return scorer.Benchmark(checkout or self.checkout, head or self.head, policy)

    def raw(self, name='abcdef', day=dt.date(2026, 9, 1)):
        p = self.out / f'watch-v0-{day.isoformat()}-{name}.ndjson'
        p.write_text(json.dumps({'recordType': 'run_meta', 'runId': p.stem,
                                'cohortId': f'watch-v0-{day.isoformat()}',
                                'slateDate': day.isoformat()}) + '\n')
        os.utime(p, (1, 1))
        return p

    def scored(self, raw, policy=POLICY):
        meta = scorer.read_first_record(raw)
        scorer.scored_path(raw).write_text(json.dumps({
            **meta, 'recordType': 'scored_run_meta', 'scoringPolicyVersion': policy,
            'integrityVerified': True,
        }) + '\n')

    def standings(self, *, games=1, scored=False, ranking=True):
        return {'scoringPolicyVersion': POLICY, 'cohorts': [{
            'cohortId': 'watch-v0-2026-09-01', 'games': games, 'scored': scored,
            'operatorCoverage': {'rankingAllowed': ranking, 'eligible': games,
                                 'scored': games, 'refused': 0, 'scheduleHeldOut': 0},
        }]}

    def test_valid_binding_and_same_child_cwd(self):
        bench = self.binding()
        with self.assertRaises(FrozenInstanceError):
            setattr(bench, 'expected_policy', 'scoring-v0.7.0')
        real = subprocess.run
        with patch.object(scorer.subprocess, 'run', wraps=real) as child:
            scorer.verify_checkout(bench)
            scorer.command(['git', 'status', '--short'], benchmark=bench)
        self.assertTrue(child.call_args_list)
        for call in child.call_args_list:
            self.assertEqual(call.kwargs['cwd'], self.checkout)

    def test_missing_relative_symlink_and_not_root(self):
        link = self.root / 'link'
        link.symlink_to(self.checkout, target_is_directory=True)
        parent = self.root / 'alias'
        parent.symlink_to(self.root, target_is_directory=True)
        for path in [self.root / 'missing', Path('relative'), link, parent / 'benchmark',
                     self.checkout / 'src', self.root, self.checkout / '..' / 'benchmark']:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                scorer.verify_checkout(self.binding(checkout=path))

    def test_head_format_and_drift(self):
        for head in ['f4b753a', 'g' * 40, 'A' * 40, ' ' + self.head, '0' * 40]:
            with self.subTest(head=head), self.assertRaises(RuntimeError):
                scorer.verify_checkout(self.binding(head=head))
        (self.checkout / 'new').write_text('new')
        self.git('add', '.')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'drift')
        with self.assertRaisesRegex(RuntimeError, 'drift'):
            scorer.verify_checkout(self.binding())

    def test_dirty_tracked_and_untracked_fail(self):
        self.policy_file.write_text(self.policy_file.read_text() + '// changed\n')
        with self.assertRaisesRegex(RuntimeError, 'dirty'):
            scorer.verify_checkout(self.binding())
        self.git('restore', 'src/scoring.ts')
        (self.checkout / 'untracked').write_text('x')
        with self.assertRaisesRegex(RuntimeError, 'dirty'):
            scorer.verify_checkout(self.binding())

    def test_policy_guard_no_autoadoption(self):
        for policy in ['', 'scoring-v0.6', POLICY + ' ', 'scoring-v0.6.2\n']:
            with self.subTest(policy=policy), self.assertRaisesRegex(scorer.Stop, 'explicit'):
                scorer.verify_checkout(self.binding(policy=policy))
        with self.assertRaisesRegex(RuntimeError, 'policy'):
            scorer.verify_checkout(self.binding(policy='scoring-v0.7.0'))
        self.policy_file.write_text("export const SCORING_POLICY_VERSION = computePolicy();\n")
        self.git('add', '.')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'unknown policy shape')
        with self.assertRaisesRegex(RuntimeError, 'policy'):
            scorer.verify_checkout(self.binding(head=self.git('rev-parse', 'HEAD').stdout.strip()))

    def test_duplicate_policy_declarations_are_rejected(self):
        for policies in ((POLICY, POLICY), (POLICY, 'scoring-v99.0.0'),
                         ('scoring-v99.0.0', POLICY)):
            with self.subTest(policies=policies):
                self.policy_file.write_text(''.join(
                    f"export const SCORING_POLICY_VERSION = '{policy}';\n" for policy in policies))
                self.git('add', '.')
                self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'duplicate policy fixture')
                with self.assertRaisesRegex(scorer.Stop, 'policy drift'):
                    scorer.verify_checkout(self.binding(head=self.git('rev-parse', 'HEAD').stdout.strip()))

    def test_cli_requires_all_bindings_except_selftest(self):
        flags = ['--benchmark-checkout', str(self.checkout), '--expected-head', self.head,
                 '--expected-policy', POLICY]
        for removed in range(0, len(flags), 2):
            with self.subTest(flag=flags[removed]), contextlib.redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit) as err:
                scorer.parse_args(flags[:removed] + flags[removed + 2:])
            self.assertEqual(err.exception.code, 2)
        self.assertEqual(scorer.parse_args(flags).benchmark_checkout, str(self.checkout))
        self.assertTrue(scorer.parse_args(['--self-test']).self_test)

    def test_selftest_works_with_empty_env_and_no_live_reads(self):
        with patch.object(scorer, 'verify_runtime', side_effect=AssertionError('runtime forbidden')), \
             patch.object(scorer, 'verify_checkout', side_effect=AssertionError('checkout forbidden')), \
             patch.object(scorer, 'acquire_lock', side_effect=AssertionError('lock forbidden')), \
             patch.object(scorer, 'raw_groups', side_effect=AssertionError('out forbidden')), \
             patch.object(Path, 'open', side_effect=AssertionError('file forbidden')), \
             patch.object(scorer.subprocess, 'run', side_effect=AssertionError('child forbidden')), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(scorer.main(['--self-test']), 0)
        result = self.real_subprocess([sys.executable, '-B', str(SCRIPT), '--self-test'],
                                      cwd=self.root, env={}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'SELFTEST PASS ranking policy\n')
        self.urlopen.assert_not_called()

    def test_noop_has_no_live_config_or_dependencies(self):
        # Installed no-op still reads standings and the raw directory, but does
        # not check DB environment/dependencies or invoke any publisher.
        with patch.object(scorer, 'fetch_standings', return_value=self.standings()) as fetch, \
             patch.object(scorer, 'verify_runtime', side_effect=AssertionError('runtime forbidden')), \
             patch.object(scorer, 'command', side_effect=AssertionError('publisher forbidden')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(scorer.run(False, self.binding()), 0)
        fetch.assert_called_once_with(POLICY)
        self.assertIn('NOOP no eligible unscored cohort-day before 2026-09-02', output.getvalue())
        self.urlopen.assert_not_called()

    def test_invalid_binding_precedes_raw_reads_even_noop(self):
        with patch.object(scorer, 'raw_groups', side_effect=AssertionError('out forbidden')):
            with self.assertRaisesRegex(scorer.Stop, 'head drift'):
                scorer.run(False, self.binding(head='0' * 40))
        self.urlopen.assert_not_called()
        # Failure releases the same lock rather than poisoning the next pass.
        scorer.acquire_lock().close()

    def test_lock_still_excludes_second_owner(self):
        code = ('import fcntl, sys; f = open(sys.argv[1], "a+"); '
                'fcntl.flock(f, fcntl.LOCK_EX); print("locked", flush=True); sys.stdin.read(1)')
        with subprocess.Popen([sys.executable, '-B', '-c', code, str(self.lock)],
                              cwd=self.root, env={}, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, text=True) as owner:
            try:
                self.assertEqual(owner.stdout.readline(), 'locked\n')
                with patch.object(scorer, 'raw_groups', side_effect=AssertionError('out forbidden')):
                    with self.assertRaisesRegex(scorer.Stop, 'holds the lock'):
                        scorer.run(False, self.binding())
            finally:
                owner.communicate('\n', timeout=5)
        self.assertEqual(owner.returncode, 0)
        self.urlopen.assert_not_called()
        scorer.acquire_lock().close()

    def test_eastern_date_and_quiet_gates(self):
        # The installed run uses the New York date, not the UTC day.
        self.raw(day=dt.date(2026, 9, 2))
        with patch.object(scorer, 'fetch_standings', return_value=self.standings()), \
             patch.object(scorer, 'command', side_effect=AssertionError('publisher forbidden')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(scorer.run(True, self.binding()), 0)
        self.assertIn('NOOP', output.getvalue())
        fake = Path('/never-read')
        groups = {dt.date(2026, 8, 20): [fake], dt.date(2026, 8, 21): [fake],
                  dt.date(2026, 8, 22): [fake]}
        self.assertEqual(scorer.select_oldest(groups, {}, dt.date(2026, 8, 22))[0],
                         dt.date(2026, 8, 21))
        raw = self.raw()
        os.utime(raw, (100, 100))
        with patch.object(scorer.time, 'time', return_value=3699):
            with self.assertRaisesRegex(scorer.Stop, 'not quiet for 3600 seconds'):
                scorer.require_quiet([raw])
        with patch.object(scorer.time, 'time', return_value=3700):
            scorer.require_quiet([raw])

    def test_raw_scanner_filters_and_dedupes(self):
        day = dt.date(2026, 9, 1)
        raw = self.raw()
        second = self.raw(name='fedcba')
        self.out.joinpath('other.ndjson').write_text('ignored non-watch file')
        self.scored(raw)
        self.assertEqual(scorer.raw_groups(), {day: [raw, second]})
        scorer.validate_raw_set(day, [raw, second])
        with self.assertRaisesRegex(scorer.Stop, 'duplicate or invalid run id'):
            scorer.validate_raw_set(day, [raw, raw])
        meta = scorer.read_first_record(second)
        for key, value in [('runId', raw.stem), ('slateDate', '2026-08-31'),
                           ('cohortId', 'other'), ('recordType', 'other')]:
            with self.subTest(key=key):
                second.write_text(json.dumps({**meta, key: value}) + '\n')
                with self.assertRaises(scorer.Stop):
                    scorer.validate_raw_set(day, [raw, second])
        second.unlink()
        second.symlink_to(raw)
        with self.assertRaisesRegex(scorer.Stop, 'non-symlink'):
            scorer.raw_groups()

    def exercise_run(self, *, failure=None, dry_run=False, changed=False, ranking_bad=False,
                     drift_after=None, current=False, stale=False):
        raw = self.raw()
        if current or stale:
            self.scored(raw, policy='scoring-v0.5.0' if stale else POLICY)
        bench = self.binding()
        invocations = []
        checks = []
        real_verify = scorer.verify_checkout
        tsx = self.checkout / 'node_modules/.bin/tsx'
        tsx.parent.mkdir(parents=True, exist_ok=True)
        tsx.write_text('disposable existence fixture; never executed')

        def verified(binding):
            checks.append(binding)
            return real_verify(binding)

        def child(argv, **kwargs):
            invocations.append((argv, kwargs))
            if argv[0] == 'git':
                return self.real_subprocess(argv, **kwargs)
            self.assertEqual(argv[0], scorer.YARN, 'unexpected executable')
            stage = argv[1]
            self.assertIn(stage, {'project', 'score', 'project:scores'})
            if stage == failure:
                return subprocess.CompletedProcess(argv, 1)
            if stage == 'score':
                self.scored(raw)
                if changed:
                    self.raw(name='fedcba')
            if stage == drift_after:
                (self.checkout / 'drift').write_text('source changed between children')
            return subprocess.CompletedProcess(argv, 0)

        initial = self.standings(scored=ranking_bad, ranking=not ranking_bad)
        documents = [initial, self.standings(), self.standings(scored=True)]
        fixture_env = {'SUPABASE_URL': 'https://fixture.invalid',
                       'SUPABASE_ANON_KEY': 'fixture-only', 'BENCHMARK_DB_URL': 'fixture-only',
                       'PGSSLMODE': 'require'}
        with patch.object(scorer, 'verify_checkout', side_effect=verified), \
             patch.object(scorer, 'fetch_standings', side_effect=documents) as fetch, \
             patch.object(scorer.subprocess, 'run', side_effect=child), \
             patch.dict(os.environ, fixture_env), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            if failure or changed or ranking_bad or drift_after:
                message = ('command exited 1' if failure else 'raw file set changed' if changed
                           else 'ranking_allowed mismatch' if ranking_bad else 'dirty')
                with self.assertRaisesRegex(scorer.Stop, message):
                    scorer.run(dry_run, bench)
                self.assertNotIn('COMPLETE', output.getvalue())
            else:
                self.assertEqual(scorer.run(dry_run, bench), 0)
                if dry_run:
                    self.assertIn('DRY-RUN', output.getvalue())
                    self.assertEqual(fetch.call_count, 1)
                else:
                    self.assertIn('COMPLETE cohort 2026-09-01 artifacts 1', output.getvalue())
                    self.assertEqual(fetch.call_count, 3)
            for call in fetch.call_args_list:
                self.assertEqual(call.args, (POLICY,))
        self.assertTrue(checks)
        self.assertTrue(all(binding is bench for binding in checks))
        commands = []
        for argv, kwargs in invocations:
            self.assertEqual(kwargs['cwd'], self.checkout, argv)
            if argv[0] == scorer.YARN:
                commands.append(argv)
        self.last_commands = commands
        # The real flock is released on success and each failure boundary.
        scorer.acquire_lock().close()
        return [argv[1] for argv in commands]

    def test_complete_command_closure_and_order(self):
        self.assertEqual(self.exercise_run(), ['project', 'score', 'project:scores'])
        raw = self.out / 'watch-v0-2026-09-01-abcdef.ndjson'
        self.assertEqual(self.last_commands, [
            [scorer.YARN, 'project', str(raw)],
            [scorer.YARN, 'score', '--run', str(raw), '--publish'],
            [scorer.YARN, 'project:scores', '--scoring-run', '--ranking-allowed',
             f'--ranking-reason={scorer.RANKING_OPEN_REASON}', str(scorer.scored_path(raw))],
        ])

    def test_current_scored_is_skipped_but_whole_cohort_projected(self):
        self.assertEqual(self.exercise_run(current=True), ['project', 'project:scores'])

    def test_stale_scored_is_rescored(self):
        self.assertEqual(self.exercise_run(stale=True), ['project', 'score', 'project:scores'])

    def test_dry_run_never_invokes_publisher(self):
        self.assertEqual(self.exercise_run(dry_run=True), [])

    def test_failure_gates_stop_publication(self):
        for failure in ['project', 'score', 'project:scores']:
            with self.subTest(failure=failure):
                stages = self.exercise_run(failure=failure)
                if failure in {'project', 'score'}:
                    self.assertNotIn('project:scores', stages)

    def test_raw_set_change_stops_coverage(self):
        self.assertNotIn('project:scores', self.exercise_run(changed=True))

    def test_ranking_gate_stops_before_any_child(self):
        self.assertEqual(self.exercise_run(ranking_bad=True), [])

    def test_source_drift_rechecked_before_each_publisher(self):
        for stage in ['project', 'score']:
            with self.subTest(stage=stage):
                self.assertEqual(self.exercise_run(drift_after=stage),
                                 ['project'] if stage == 'project' else ['project', 'score'])
                (self.checkout / 'drift').unlink()
                scored = scorer.scored_path(self.out / 'watch-v0-2026-09-01-abcdef.ndjson')
                scored.unlink(missing_ok=True)

    def test_head_drift_rechecked_before_child(self):
        (self.checkout / 'new').write_text('new')
        self.git('add', '.')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'drift')
        with self.assertRaisesRegex(scorer.Stop, 'head drift'):
            scorer.command([scorer.YARN, 'project:scores'], benchmark=self.binding())
        # An unguarded Yarn call would hit setUp's forbidden-child assertion.

    def test_scored_policy_and_coverage_gates(self):
        raw = self.raw()
        day = dt.date(2026, 9, 1)
        self.assertFalse(scorer.scored_is_current(raw, POLICY))
        self.scored(raw)
        self.assertTrue(scorer.scored_is_current(raw, POLICY))
        self.assertEqual(scorer.validate_scored_set(day, [raw], POLICY), [scorer.scored_path(raw)])
        meta = scorer.read_first_record(scorer.scored_path(raw))
        for key, value in [('scoringPolicyVersion', 'scoring-v0.7.0'), ('integrityVerified', False),
                           ('runId', 'other'), ('cohortId', 'other'), ('slateDate', '2026-08-31'),
                           ('recordType', 'other')]:
            with self.subTest(key=key):
                scorer.scored_path(raw).write_text(json.dumps({**meta, key: value}) + '\n')
                with self.assertRaisesRegex(scorer.Stop, 'metadata mismatch'):
                    scorer.validate_scored_set(day, [raw], POLICY)

    def test_readback_parity_and_policy(self):
        response = MagicMock()
        response.__enter__.return_value.status = 200
        response.__enter__.return_value.read.return_value = json.dumps(self.standings()).encode()
        with patch.object(scorer.urllib.request, 'urlopen', return_value=response) as get:
            self.assertEqual(scorer.fetch_standings(POLICY), self.standings())
            self.assertEqual(get.call_args.args[0].full_url, scorer.CORE_API_STANDINGS)
            self.assertEqual(get.call_args.kwargs['timeout'], 20)
            with self.assertRaisesRegex(scorer.Stop, 'default policy drift'):
                scorer.fetch_standings('scoring-v0.7.0')
        day = dt.date(2026, 9, 1)
        with patch.object(scorer, 'fetch_standings', return_value=self.standings(scored=True)):
            scorer.require_projected_game_count(day, 1, POLICY)
            self.assertTrue(scorer.wait_for_coverage(day, 1, POLICY)['scored'])
            with self.assertRaisesRegex(scorer.Stop, 'game count mismatch'):
                scorer.require_projected_game_count(day, 2, POLICY)
        for document in [self.standings(games=2, scored=True), self.standings(),
                         {'scoringPolicyVersion': POLICY, 'cohorts': []}]:
            with self.subTest(document=document), \
                 patch.object(scorer, 'fetch_standings', return_value=document) as fetch, \
                 patch.object(scorer.time, 'sleep') as sleep:
                with self.assertRaisesRegex(scorer.Stop, 'did not'):
                    scorer.wait_for_coverage(day, 1, POLICY)
                self.assertEqual(fetch.call_count, 12)
                self.assertEqual(sleep.call_count, 11)
        with patch.object(scorer, 'fetch_standings', return_value=self.standings(scored=True, ranking=False)):
            with self.assertRaisesRegex(scorer.Stop, 'ranking_allowed mismatch'):
                scorer.wait_for_coverage(day, 1, POLICY)

    def test_standings_errors_fail_closed(self):
        for document in [[], {'cohorts': []}, {'scoringPolicyVersion': POLICY, 'cohorts': None}]:
            with self.subTest(document=document):
                response = MagicMock()
                response.__enter__.return_value.status = 200
                response.__enter__.return_value.read.return_value = json.dumps(document).encode()
                with patch.object(scorer.urllib.request, 'urlopen', return_value=response):
                    with self.assertRaises(scorer.Stop):
                        scorer.fetch_standings(POLICY)
        with patch.object(scorer.urllib.request, 'urlopen', side_effect=TimeoutError('fixture timeout')):
            with self.assertRaisesRegex(scorer.Stop, 'standings read failed'):
                scorer.fetch_standings(POLICY)
        for cohorts in [[None], [{}], [{'cohortId': 'same'}, {'cohortId': 'same'}]]:
            with self.subTest(cohorts=cohorts), self.assertRaises(scorer.Stop):
                scorer.cohort_rows({'cohorts': cohorts})

    def test_runtime_checks_only_fixture_dependencies_and_environment(self):
        bench = self.binding()
        with self.assertRaisesRegex(scorer.Stop, 'dependencies are not installed'):
            scorer.verify_runtime(bench)
        tsx = self.checkout / 'node_modules/.bin/tsx'
        tsx.parent.mkdir(parents=True)
        tsx.write_text('not executable')
        with self.assertRaisesRegex(scorer.Stop, 'missing required environment names'):
            scorer.verify_runtime(bench)
        with patch.dict(os.environ, {'SUPABASE_URL': 'fixture', 'SUPABASE_ANON_KEY': 'fixture',
                                     'BENCHMARK_DB_URL': 'fixture'}):
            with self.assertRaisesRegex(scorer.Stop, 'PGSSLMODE is not require'):
                scorer.verify_runtime(bench)
            with patch.dict(os.environ, {'PGSSLMODE': 'require'}):
                scorer.verify_runtime(bench)

    def test_main_reports_stop_without_live_reads(self):
        args = ['--benchmark-checkout', str(self.checkout), '--expected-head', '0' * 40,
                '--expected-policy', POLICY]
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(scorer.main(args), 1)
        self.assertIn('STOP: benchmark worktree head drift', err.getvalue())
        self.urlopen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
