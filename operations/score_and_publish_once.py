#!/usr/bin/env python3
"""Score and publish one oldest eligible watch cohort-day.

The scheduled contract is deliberately narrow:
- consider watch-v0 cohort dates on/after 2026-08-21 and before today's
  America/New_York date;
- choose the oldest cohort not published under the pinned scoring policy;
- require a one-hour quiet file set;
- project every raw parent, score only missing/stale derived artifacts with
  --publish, then publish the whole cohort with --scoring-run;
- leave already-published historical coverage rows untouched while accepting
  their operator-managed ranking state, and publish every new cohort ranking-open.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence
import urllib.request
from zoneinfo import ZoneInfo

def configured_path(name: str, default: str) -> Path:
    path = Path(os.environ.get(name, default)).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{name} must be an absolute path")
    return path


STATE_DIR = configured_path("OSPEX_STATE_DIR", "~/.ospex")
OUT_DIR = STATE_DIR / "decisions" / "out"
# An existing installation must explicitly preserve its shared lock identity.
LOCK_PATH = configured_path(
    "OSPEX_SCORE_PUBLISH_LOCK_PATH", str(STATE_DIR / "locks" / "score-publish.lock")
)
MIN_COHORT_DATE = dt.date(2026, 8, 21)
RANKING_OPEN_MIN_COHORT_DATE = MIN_COHORT_DATE
HISTORICAL_RANKING_MANUAL_THROUGH = dt.date(2026, 8, 31)
RANKING_OPEN_REASON = "operator-approved recurring scorer publication"
QUIET_SECONDS = 60 * 60
CORE_API_STANDINGS = "https://ospex-core-api-195f635df864.herokuapp.com/v1/benchmark/standings"
YARN = "/usr/bin/yarn"
RAW_RE = re.compile(r"^watch-v0-(\d{4}-\d{2}-\d{2})-([0-9a-f]{6})\.ndjson$")


class Stop(RuntimeError):
    pass


@dataclass(frozen=True)
class Benchmark:
    """One explicit NEW_BENCH binding; no installed-path or policy fallback."""

    checkout: Path
    expected_head: str
    expected_policy: str


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="select and validate; run no yarn commands")
    parser.add_argument("--self-test", action="store_true", help="run deterministic selection tests")
    parser.add_argument("--benchmark-checkout", help="required absolute, non-symlink NEW_BENCH checkout root")
    parser.add_argument("--expected-head", help="required reviewed full 40-character lowercase Git commit")
    parser.add_argument("--expected-policy", help="required reviewed scoring policy; never inferred from HEAD")
    args = parser.parse_args(argv)
    if not args.self_test:
        for name in ("benchmark_checkout", "expected_head", "expected_policy"):
            if not getattr(args, name):
                parser.error(f"--{name.replace('_', '-')} is required except with --self-test")
    return args


def command(argv: Sequence[str], *, benchmark: Benchmark, check: bool = True) -> subprocess.CompletedProcess[str]:
    # Recheck immediately before every child that can publish. A changed HEAD
    # or dirty source must not continue a partially completed pass.
    verify_checkout(benchmark)
    completed = subprocess.run(
        list(argv),
        cwd=benchmark.checkout,
        text=True,
        env=os.environ.copy(),
        check=False,
    )
    if check and completed.returncode != 0:
        raise Stop(f"command exited {completed.returncode}: {' '.join(argv[:2])}")
    return completed


def captured(argv: Sequence[str], *, benchmark: Benchmark) -> str:
    completed = subprocess.run(
        list(argv),
        cwd=benchmark.checkout,
        text=True,
        capture_output=True,
        env=os.environ.copy(),
        check=False,
    )
    if completed.returncode != 0:
        raise Stop(f"preflight command exited {completed.returncode}: {' '.join(argv[:2])}")
    return completed.stdout.strip()


def verify_checkout(benchmark: Benchmark) -> None:
    checkout = benchmark.checkout
    if not checkout.is_absolute() or not checkout.is_dir():
        raise Stop("benchmark checkout must be an existing absolute directory")
    # Reject symlinked ancestors as well as the final component; do not silently
    # resolve an alias or '..' into the operator's explicitly bound checkout.
    if any(path.is_symlink() for path in (checkout, *checkout.parents)) or checkout.resolve() != checkout:
        raise Stop("benchmark checkout must be canonical and non-symlinked")
    if re.fullmatch(r"[0-9a-f]{40}", benchmark.expected_head) is None:
        raise Stop("expected head must be an exact 40-character lowercase Git commit")
    if re.fullmatch(r"scoring-v[0-9]+\.[0-9]+\.[0-9]+", benchmark.expected_policy) is None:
        raise Stop("expected policy must be an explicit scoring-vMAJOR.MINOR.PATCH identity")
    root = captured(["git", "rev-parse", "--show-toplevel"], benchmark=benchmark)
    if root != str(checkout):
        raise Stop("benchmark checkout must be the Git worktree root")
    head = captured(["git", "rev-parse", "HEAD"], benchmark=benchmark)
    if head != benchmark.expected_head:
        raise Stop(f"benchmark worktree head drift: expected {benchmark.expected_head}, observed {head}")
    dirty = captured(["git", "status", "--porcelain=v1", "--untracked-files=all"], benchmark=benchmark)
    if dirty:
        raise Stop("benchmark worktree is dirty (tracked or untracked changes)")
    # Read reviewed source, not a TS import: this guard needs no dependencies,
    # environment file, model, database or network. A changed declaration shape
    # requires review rather than guessing a policy or executing code to find it.
    policies = re.findall(
        r"^export const SCORING_POLICY_VERSION = ['\"]([^'\"]+)['\"];\s*$",
        (checkout / "src" / "scoring.ts").read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    if policies != [benchmark.expected_policy]:
        raise Stop(f"benchmark scoring policy drift: expected {benchmark.expected_policy}, observed {policies!r}")


def verify_runtime(benchmark: Benchmark) -> None:
    verify_checkout(benchmark)
    if OUT_DIR.is_symlink() or not OUT_DIR.is_dir():
        raise Stop("decision output directory is missing or symlinked")
    if not (benchmark.checkout / "node_modules" / ".bin" / "tsx").is_file():
        raise Stop("pinned benchmark dependencies are not installed")
    missing = [name for name in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "BENCHMARK_DB_URL") if not os.environ.get(name)]
    if missing:
        raise Stop("missing required environment names: " + ", ".join(missing))
    if os.environ.get("PGSSLMODE") != "require":
        raise Stop("PGSSLMODE is not require")


def fetch_standings(expected_policy: str) -> dict[str, Any]:
    request = urllib.request.Request(
        CORE_API_STANDINGS,
        headers={"Accept": "application/json", "User-Agent": "ospex-score-publisher/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise Stop(f"standings returned HTTP {response.status}")
            raw = response.read()
    except Stop:
        raise
    except Exception as exc:
        raise Stop(f"standings read failed: {type(exc).__name__}: {exc}") from exc
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise Stop("standings returned invalid JSON") from exc
    if not isinstance(document, dict):
        raise Stop("standings response is not an object")
    version = document.get("scoringPolicyVersion")
    if version != expected_policy:
        raise Stop(f"standings default policy drift: expected {expected_policy}, observed {version!r}")
    cohorts = document.get("cohorts")
    if not isinstance(cohorts, list):
        raise Stop("standings cohorts is not an array")
    return document


def cohort_rows(document: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    rows: dict[str, Mapping[str, Any]] = {}
    for item in document.get("cohorts", []):
        if not isinstance(item, Mapping):
            raise Stop("standings contains a non-object cohort")
        cohort_id = item.get("cohortId")
        if not isinstance(cohort_id, str) or not cohort_id:
            raise Stop("standings contains a cohort without an id")
        if cohort_id in rows:
            raise Stop(f"standings contains duplicate cohort {cohort_id}")
        rows[cohort_id] = item
    return rows


def ranking_allowed_for(day: dt.date) -> bool:
    return day >= RANKING_OPEN_MIN_COHORT_DATE


def is_complete_coverage(
    row: Mapping[str, Any] | None,
    *,
    expected_ranking_allowed: bool | None,
) -> bool:
    if row is None or row.get("scored") is not True:
        return False
    coverage = row.get("operatorCoverage")
    if not isinstance(coverage, Mapping):
        raise Stop("scored cohort has no operator coverage object")
    observed = coverage.get("rankingAllowed")
    if not isinstance(observed, bool):
        raise Stop(f"scored cohort has invalid ranking_allowed value: {observed!r}")
    if expected_ranking_allowed is not None and observed is not expected_ranking_allowed:
        raise Stop(
            "scored cohort ranking_allowed mismatch: "
            f"expected {str(expected_ranking_allowed).lower()}, observed {observed!r}"
        )
    return True


def raw_groups() -> dict[dt.date, list[Path]]:
    groups: dict[dt.date, list[Path]] = {}
    for path in OUT_DIR.iterdir():
        match = RAW_RE.fullmatch(path.name)
        if match is None:
            continue
        if path.is_symlink() or not path.is_file():
            raise Stop(f"raw artifact is not a regular non-symlink file: {path.name}")
        try:
            day = dt.date.fromisoformat(match.group(1))
        except ValueError as exc:
            raise Stop(f"raw artifact carries an invalid date: {path.name}") from exc
        groups.setdefault(day, []).append(path)
    for paths in groups.values():
        paths.sort(key=lambda p: p.name)
    return groups


def select_oldest(
    groups: Mapping[dt.date, Sequence[Path]],
    rows: Mapping[str, Mapping[str, Any]],
    today_eastern: dt.date,
) -> tuple[dt.date, list[Path]] | None:
    for day in sorted(groups):
        if day < MIN_COHORT_DATE or day >= today_eastern:
            continue
        cohort_id = f"watch-v0-{day.isoformat()}"
        expected_ranking_allowed = (
            None if day <= HISTORICAL_RANKING_MANUAL_THROUGH else ranking_allowed_for(day)
        )
        if not is_complete_coverage(
            rows.get(cohort_id),
            expected_ranking_allowed=expected_ranking_allowed,
        ):
            return day, list(groups[day])
    return None


def file_snapshot(paths: Sequence[Path]) -> tuple[tuple[str, int, int], ...]:
    return tuple((path.name, path.stat().st_size, path.stat().st_mtime_ns) for path in paths)


def read_first_record(path: Path) -> Mapping[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise Stop(f"artifact is not a regular non-symlink file: {path.name}")
    with path.open("r", encoding="utf-8", errors="strict") as handle:
        line = handle.readline()
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        raise Stop(f"artifact first record is invalid JSON: {path.name}") from exc
    if not isinstance(value, Mapping):
        raise Stop(f"artifact first record is not an object: {path.name}")
    return value


def validate_raw_set(day: dt.date, paths: Sequence[Path]) -> None:
    if not paths:
        raise Stop(f"cohort {day} has no raw artifacts")
    expected_cohort = f"watch-v0-{day.isoformat()}"
    run_ids: set[str] = set()
    for path in paths:
        match = RAW_RE.fullmatch(path.name)
        if match is None or match.group(1) != day.isoformat():
            raise Stop(f"raw artifact name/date mismatch: {path.name}")
        record = read_first_record(path)
        run_id = record.get("runId")
        if record.get("recordType") != "run_meta":
            raise Stop(f"raw artifact lacks run_meta first record: {path.name}")
        if record.get("slateDate") != day.isoformat() or record.get("cohortId") != expected_cohort:
            raise Stop(f"raw artifact cohort/date mismatch: {path.name}")
        if run_id != path.stem:
            raise Stop(f"raw artifact run id/name mismatch: {path.name}")
        if not isinstance(run_id, str) or run_id in run_ids:
            raise Stop(f"duplicate or invalid run id in cohort {day}")
        run_ids.add(run_id)


def scored_path(raw_path: Path) -> Path:
    return raw_path.with_name(raw_path.stem + "-scored.ndjson")


def scored_is_current(raw_path: Path, expected_policy: str) -> bool:
    path = scored_path(raw_path)
    if not path.exists():
        return False
    record = read_first_record(path)
    return (
        record.get("recordType") == "scored_run_meta"
        and record.get("runId") == raw_path.stem
        and record.get("cohortId") == f"watch-v0-{record.get('slateDate')}"
        and record.get("scoringPolicyVersion") == expected_policy
        and record.get("integrityVerified") is True
    )


def validate_scored_set(day: dt.date, raw_paths: Sequence[Path], expected_policy: str) -> list[Path]:
    expected_cohort = f"watch-v0-{day.isoformat()}"
    scored: list[Path] = []
    for raw_path in raw_paths:
        path = scored_path(raw_path)
        record = read_first_record(path)
        if (
            record.get("recordType") != "scored_run_meta"
            or record.get("runId") != raw_path.stem
            or record.get("cohortId") != expected_cohort
            or record.get("slateDate") != day.isoformat()
            or record.get("scoringPolicyVersion") != expected_policy
            or record.get("integrityVerified") is not True
        ):
            raise Stop(f"scored artifact metadata mismatch: {path.name}")
        scored.append(path)
    return scored


def require_quiet(paths: Sequence[Path]) -> None:
    latest_ns = max(path.stat().st_mtime_ns for path in paths)
    age = time.time() - latest_ns / 1_000_000_000
    if age < QUIET_SECONDS:
        raise Stop(f"oldest unscored cohort is not quiet for {QUIET_SECONDS} seconds")


def require_projected_game_count(day: dt.date, expected: int, expected_policy: str) -> None:
    document = fetch_standings(expected_policy)
    row = cohort_rows(document).get(f"watch-v0-{day.isoformat()}")
    if row is None:
        raise Stop(f"projected cohort {day} is absent from standings")
    games = row.get("games")
    if games != expected:
        raise Stop(f"projected cohort {day} game count mismatch: expected {expected}, observed {games!r}")


def wait_for_coverage(day: dt.date, expected_games: int, expected_policy: str) -> Mapping[str, Any]:
    cohort_id = f"watch-v0-{day.isoformat()}"
    expected_ranking_allowed = ranking_allowed_for(day)
    last: Mapping[str, Any] | None = None
    for attempt in range(12):
        document = fetch_standings(expected_policy)
        row = cohort_rows(document).get(cohort_id)
        if row is not None:
            last = row
            if row.get("games") == expected_games and is_complete_coverage(
                row,
                expected_ranking_allowed=expected_ranking_allowed,
            ):
                return row
        if attempt < 11:
            time.sleep(5)
    if last is None:
        raise Stop(f"published cohort {day} did not appear in standings")
    raise Stop(
        f"published cohort {day} did not reach verified "
        f"ranking_allowed {str(expected_ranking_allowed).lower()} coverage"
    )


def acquire_lock() -> Any:
    LOCK_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = LOCK_PATH.open("a+", encoding="utf-8")
    os.chmod(LOCK_PATH, 0o600)
    try:
        fcntl.flock(descriptor.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        descriptor.close()
        raise Stop("another benchmark score-and-publish pass holds the lock") from exc
    return descriptor


def self_test() -> None:
    fake = Path("/tmp/fake.ndjson")
    groups = {
        dt.date(2026, 8, 20): [fake],
        dt.date(2026, 8, 21): [fake],
        dt.date(2026, 8, 22): [fake],
        dt.date(2026, 8, 23): [fake],
        dt.date(2026, 9, 1): [fake],
    }
    complete_closed = {"scored": True, "operatorCoverage": {"rankingAllowed": False}}
    complete_open = {"scored": True, "operatorCoverage": {"rankingAllowed": True}}
    pending = {"scored": False, "operatorCoverage": None}
    rows = {"watch-v0-2026-08-21": complete_closed, "watch-v0-2026-08-22": pending}
    selected = select_oldest(groups, rows, dt.date(2026, 8, 23))
    assert selected is not None and selected[0] == dt.date(2026, 8, 22)
    assert select_oldest(groups, {**rows, "watch-v0-2026-08-22": complete_closed}, dt.date(2026, 8, 23)) is None
    assert select_oldest({dt.date(2026, 8, 21): [fake]}, {}, dt.date(2026, 8, 22))[0] == dt.date(2026, 8, 21)
    assert select_oldest(
        {dt.date(2026, 8, 31): [fake]},
        {"watch-v0-2026-08-31": complete_open},
        dt.date(2026, 9, 1),
    ) is None
    try:
        select_oldest(
            {dt.date(2026, 9, 1): [fake]},
            {"watch-v0-2026-09-01": complete_closed},
            dt.date(2026, 9, 2),
        )
    except Stop:
        pass
    else:
        raise AssertionError("future ranking-withheld cohort was accepted")
    assert is_complete_coverage(complete_closed, expected_ranking_allowed=None)
    assert is_complete_coverage(complete_open, expected_ranking_allowed=None)
    assert is_complete_coverage(complete_open, expected_ranking_allowed=True)
    assert not is_complete_coverage(pending, expected_ranking_allowed=True)
    for row, expected in ((complete_closed, True), (complete_open, False)):
        try:
            is_complete_coverage(row, expected_ranking_allowed=expected)
        except Stop:
            pass
        else:
            raise AssertionError("ranking_allowed mismatch was accepted")
    assert ranking_allowed_for(dt.date(2026, 8, 21)) is True
    assert ranking_allowed_for(dt.date(2026, 8, 31)) is True
    assert ranking_allowed_for(dt.date(2026, 9, 1)) is True
    assert RAW_RE.fullmatch("watch-v0-2026-08-27-abcdef.ndjson") is not None
    assert RAW_RE.fullmatch("watch-v0-2026-08-27-abcdef-scored.ndjson") is None
    print("SELFTEST PASS ranking policy")


def run(dry_run: bool, benchmark: Benchmark) -> int:
    lock = acquire_lock()
    try:
        verify_checkout(benchmark)
        document = fetch_standings(benchmark.expected_policy)
        rows = cohort_rows(document)
        today_eastern = dt.datetime.now(ZoneInfo("America/New_York")).date()
        selected = select_oldest(raw_groups(), rows, today_eastern)
        if selected is None:
            print(f"{utc_now()} NOOP no eligible unscored cohort-day before {today_eastern.isoformat()}")
            return 0
        day, raw_paths = selected
        ranking_allowed = ranking_allowed_for(day)
        ranking_text = str(ranking_allowed).lower()
        validate_raw_set(day, raw_paths)
        require_quiet(raw_paths)
        snapshot = file_snapshot(raw_paths)
        current = sum(1 for path in raw_paths if scored_is_current(path, benchmark.expected_policy))
        print(
            f"{utc_now()} SELECT cohort {day.isoformat()} raw {len(raw_paths)} "
            f"current-scored {current} ranking_allowed {ranking_text}"
        )
        if dry_run:
            print(f"{utc_now()} DRY-RUN no yarn commands executed")
            return 0

        verify_runtime(benchmark)
        print(f"{utc_now()} PROJECT-PARENTS cohort {day.isoformat()} files {len(raw_paths)}")
        command([YARN, "project", *[str(path) for path in raw_paths]], benchmark=benchmark)
        require_projected_game_count(day, len(raw_paths), benchmark.expected_policy)

        scored_now = 0
        for raw_path in raw_paths:
            if scored_is_current(raw_path, benchmark.expected_policy):
                continue
            print(f"{utc_now()} SCORE-PUBLISH {raw_path.name}")
            command([YARN, "score", "--run", str(raw_path), "--publish"], benchmark=benchmark)
            scored_now += 1

        current_paths = raw_groups().get(day, [])
        if file_snapshot(current_paths) != snapshot:
            raise Stop(f"cohort {day} raw file set changed during scoring; coverage row not attempted")
        scored_paths = validate_scored_set(day, raw_paths, benchmark.expected_policy)
        print(
            f"{utc_now()} PROJECT-COVERAGE cohort {day.isoformat()} files {len(scored_paths)} "
            f"ranking_allowed {ranking_text}"
        )
        ranking_args = (
            ["--ranking-allowed", f"--ranking-reason={RANKING_OPEN_REASON}"]
            if ranking_allowed
            else []
        )
        command(
            [
                YARN,
                "project:scores",
                "--scoring-run",
                *ranking_args,
                *[str(path) for path in scored_paths],
            ],
            benchmark=benchmark,
        )
        row = wait_for_coverage(day, len(raw_paths), benchmark.expected_policy)
        coverage = row["operatorCoverage"]
        print(
            f"{utc_now()} COMPLETE cohort {day.isoformat()} artifacts {len(scored_paths)} "
            f"eligible {coverage.get('eligible')} scored {coverage.get('scored')} "
            f"refused {coverage.get('refused')} schedule-held-out {coverage.get('scheduleHeldOut')} "
            f"newly-scored {scored_now} ranking_allowed {ranking_text} policy {benchmark.expected_policy}"
        )
        return 0
    finally:
        lock.close()


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    try:
        benchmark = Benchmark(Path(args.benchmark_checkout), args.expected_head, args.expected_policy)
        return run(args.dry_run, benchmark)
    except Stop as exc:
        print(f"{utc_now()} STOP: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"{utc_now()} STOP: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
