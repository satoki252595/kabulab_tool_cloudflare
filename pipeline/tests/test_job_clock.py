"""Native cancellation budget must include setup, not just the source step."""

import importlib.util
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


@pytest.mark.parametrize("changes", [{"run_id": 39928733183}, {"run_attempt": 2}, {"runner_name": "other"},
    {"status": "queued"}, {"status": "completed"}, {"name": "other"}, {"started_at": None},
    {"started_at": "2099-01-01T00:00:00Z"}, {"started_at": "2026-02-30T00:00:00Z"}])
def test_wrong_run_attempt_runner_state_or_clock_is_not_substituted(changes):
    with pytest.raises(ValueError):
        qualify([row(**changes)])


@pytest.mark.parametrize(("rows", "count"), [([], 0), ([row(), row()], 2), ([row()], 2), ([row()], 101), ([row()], True)])
def test_ambiguous_or_truncated_pages_fail_before_source(rows, count):
    with pytest.raises(ValueError):
        qualify(rows, count)
