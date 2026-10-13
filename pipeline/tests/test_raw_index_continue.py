"""Bounded continuation uses a terminal receipt, never a failed/unknown write."""

import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "raw_index_continue",
    Path(__file__).resolve().parents[2] / "scripts/notion/raw-index-continue.py",
)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def pilot():
    # Actual terminal counts from public run38468127742; no raw data/credentials.
    digest = "b" * 64  # Only shape is used; both receipt records must agree.
    inputs = dict(
        mode="apply",
        plan_id="canonical-20261014",
        cutoff="2026-10-13T18:31:00.000Z",
        expected_count="78832",
        limit="43",
        max_bytes="67108864",
        max_seconds="2400",
        continue_runs="2",
    )
    manifest = dict(
        phase="manifest",
        planId=inputs["plan_id"],
        cutoff=inputs["cutoff"],
        count=78832,
        manifestSha256=digest,
    )
    summary = dict(
        phase="summary",
        mode="apply",
        inventoryRows=78832,
        manifestSha256=digest,
        cursor=50,
        remaining=78782,
        processed=43,
        verified=43,
        upstreamGets=0,
        status="partial",
        limitReached=True,
        stoppedByBudget=False,
        budgetStopReason=None,
        indexAntiJoin=None,
    )
    return {"ref": "refs/heads/main", "inputs": inputs}, [manifest, summary]


def test_same_snapshot_and_decremented_finite_budget():
    event, records = pilot()
    result = module.continuation(event, records)
    assert result["ref"] == "main"
    assert result["inputs"] == {**event["inputs"], "continue_runs": "1"}


@pytest.mark.parametrize(
    "change", ["unknown", "no_progress", "other_snapshot", "unbounded", "reconcile", "not_main"]
)
def test_unsafe_continuation_stops(change):
    event, records = pilot()
    if change == "unknown":
        records[1]["phase"] = "stopped"
    elif change == "no_progress":
        records[1].update(processed=0, verified=0)
    elif change == "other_snapshot":
        records[0]["cutoff"] = "2026-10-14T00:00:00.000Z"
    elif change == "unbounded":
        event["inputs"]["continue_runs"] = "201"
    elif change == "reconcile":
        event["inputs"]["reconcile_sha256"] = "not-allowed"
    elif change == "not_main":
        event["ref"] = "refs/heads/feature"
    with pytest.raises(AssertionError):
        module.continuation(event, records)


def test_complete_snapshot_does_not_dispatch():
    event, records = pilot()
    records[1].update(
        status="snapshot_complete",
        cursor=78832,
        remaining=0,
        indexAntiJoin={"checked": 78832, "missing": 0},
    )
    assert module.continuation(event, records) is None
