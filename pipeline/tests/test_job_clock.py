"""Native cancellation budget must include setup, not just the source step."""

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

path = Path(__file__).resolve().parents[2] / "scripts/ci/job-clock.py"
spec = importlib.util.spec_from_file_location("job_clock", path)
clock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(clock)


def row(**changes):
    return {"run_id": 39928733182, "run_attempt": 1, "name": "moneyflow / ingest-yahoo",
            "runner_name": "qualified-runner", "status": "in_progress", "started_at": "2026-10-23T09:00:00Z", **changes}


def qualify(rows, count=None):
    return clock.qualify_job_clock({"jobs": rows, "total_count": len(rows) if count is None else count},
                                   "39928733182", "1", "ingest-yahoo", "qualified-runner")


def test_reusable_and_direct_job_clock_are_exactly_qualified():
    assert qualify([row()]) == "2026-10-23T09:00:00.000Z"
    assert qualify([row(name="ingest-yahoo"), row(name="ingest-non-yahoo")]) == "2026-10-23T09:00:00.000Z"


@pytest.mark.parametrize("changes", [{"run_id": 39928733183}, {"run_id": 39928733182.0},
    {"run_attempt": True}, {"run_attempt": 2}, {"runner_name": "other"},
    {"status": "queued"}, {"status": "completed"}, {"name": "other"}, {"started_at": None},
    {"started_at": "2099-01-01T00:00:00Z"}, {"started_at": "2026-02-30T00:00:00Z"}])
def test_wrong_run_attempt_runner_state_or_clock_is_not_substituted(changes):
    with pytest.raises(ValueError):
        qualify([row(**changes)])


@pytest.mark.parametrize(("rows", "count"), [([], 0), ([row(), row()], 2), ([row()], 2), ([row()], 101), ([row()], True)])
def test_ambiguous_or_truncated_pages_fail_before_source(rows, count):
    with pytest.raises(ValueError):
        qualify(rows, count)


def test_unpublished_metadata_is_observed_without_replacing_original_clock(capsys):
    pages = iter([{"jobs": [], "total_count": 0},
                  {"jobs": [row(runner_name=None)], "total_count": 1},
                  {"jobs": [row()], "total_count": 1}])
    elapsed, remaining = [0.0], []

    def read(timeout):
        remaining.append(timeout)
        return next(pages)

    result = clock.observe_job_clock(read, "39928733182", "1", "ingest-yahoo", "qualified-runner",
                                     monotonic=lambda: elapsed[0],
                                     sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
    assert result == "2026-10-23T09:00:00.000Z"
    assert remaining == [30.0, 20.0, 10.0]
    log = capsys.readouterr().err
    assert log == ("native_job_clock observation=1 reason=job_not_visible\n"
                   "native_job_clock observation=2 reason=runner_unassigned\n")
    assert "qualified-runner" not in log and "39928733182" not in log


@pytest.mark.parametrize("changes", [{"runner_name": None}, {"started_at": None}])
def test_metadata_published_after_fifteen_seconds_keeps_the_original_start(changes):
    elapsed, calls = [0.0], []

    def read(timeout):
        calls.append((elapsed[0], timeout))
        changes_now = changes if elapsed[0] < 15 else {}
        return {"jobs": [row(**changes_now)], "total_count": 1}

    result = clock.observe_job_clock(read, "39928733182", "1", "ingest-yahoo", "qualified-runner",
                                     monotonic=lambda: elapsed[0],
                                     sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
    assert result == "2026-10-23T09:00:00.000Z"
    assert calls == [(0.0, 30.0), (10.0, 20.0), (20.0, 10.0)]
    assert elapsed[0] < 30


@pytest.mark.parametrize("changes", [{"runner_name": None}, {"runner_name": ""},
                                    {"started_at": None}, {"started_at": ""}, {"status": "queued"}])
def test_unpublished_metadata_stops_after_three_gets(changes):
    elapsed, calls = [0.0], []

    def read(timeout):
        calls.append(timeout)
        return {"jobs": [row(**changes)], "total_count": 1}

    with pytest.raises(clock.JobClockNotReady):
        clock.observe_job_clock(read, "39928733182", "1", "ingest-yahoo", "qualified-runner",
                                monotonic=lambda: elapsed[0],
                                sleep=lambda seconds: elapsed.__setitem__(0, elapsed[0] + seconds))
    assert calls == [30.0, 20.0, 10.0]
    assert elapsed[0] == 20.0


@pytest.mark.parametrize("payload", [
    {"jobs": [row(), row()], "total_count": 2},
    {"jobs": [row(runner_name="other")], "total_count": 1},
    {"jobs": [row(run_attempt=2)], "total_count": 1},
    {"jobs": [row(run_id=39928733183)], "total_count": 1},
    {"jobs": [row(started_at="2099-01-01T00:00:00Z")], "total_count": 1},
    {"jobs": [row(status="completed", runner_name=None)], "total_count": 1},
    {"jobs": [row()], "total_count": 2},
    {"jobs": [row()], "total_count": 101},
])
def test_invalid_identity_ambiguity_future_and_incomplete_pages_do_not_observe_again(payload):
    calls = []

    def read(timeout):
        calls.append(timeout)
        return payload

    with pytest.raises(clock.JobClockError) as caught:
        clock.observe_job_clock(read, "39928733182", "1", "ingest-yahoo", "qualified-runner",
                                monotonic=lambda: 0, sleep=lambda _: pytest.fail("unexpected wait"))
    assert not isinstance(caught.value, clock.JobClockNotReady)
    assert calls == [30]


@pytest.mark.parametrize(("duration", "ready"), [(30, True), (29, False)])
def test_elapsed_read_cannot_extend_the_thirty_second_observation_budget(duration, ready):
    elapsed, calls = [0], []

    def read(timeout):
        calls.append(timeout)
        elapsed[0] += duration
        return {"jobs": [row()], "total_count": 1} if ready else {"jobs": [], "total_count": 0}

    with pytest.raises(clock.JobClockError, match="observation_timeout"):
        clock.observe_job_clock(read, "39928733182", "1", "ingest-yahoo", "qualified-runner",
                                monotonic=lambda: elapsed[0], sleep=lambda _: pytest.fail("unexpected wait"))
    assert calls == [30]


def test_metadata_fetch_is_get_only_and_preserves_remaining_timeout(monkeypatch):
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"jobs": [], "total_count": 0}))

    monkeypatch.setattr(clock.subprocess, "run", run)
    assert clock.read_github_job_page("satoki252595/kabulab_tool_cloudflare", "40126995621", "1", 12) == {
        "jobs": [], "total_count": 0,
    }
    args, kwargs = calls[0]
    assert args == ["gh", "api", "--method", "GET",
                    "/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/40126995621/attempts/1/jobs?per_page=100"]
    assert kwargs == {"capture_output": True, "text": True, "timeout": 12, "check": True}


@pytest.mark.parametrize("failure", [subprocess.CalledProcessError(1, "gh", stderr="private response"),
                                     subprocess.TimeoutExpired("gh", 30, stderr="private response")])
def test_http_failure_is_not_retried_or_exposed(monkeypatch, capsys, failure):
    calls = []

    def run(*args, **kwargs):
        calls.append(args)
        raise failure

    monkeypatch.setattr(clock.subprocess, "run", run)
    with pytest.raises(clock.JobClockError) as caught:
        clock.observe_job_clock(lambda timeout: clock.read_github_job_page(
            "satoki252595/kabulab_tool_cloudflare", "39928733182", "1", timeout),
            "39928733182", "1", "ingest-yahoo", "qualified-runner",
            sleep=lambda _: pytest.fail("unexpected wait"))
    assert str(caught.value) in ("api_read_failed", "observation_timeout")
    assert len(calls) == 1 and capsys.readouterr() == ("", "")
