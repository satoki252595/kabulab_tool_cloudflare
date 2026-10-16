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
REVISION = "b" * 40  # Protocol revision shape only, not a source observation.


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
        execution_revision="",
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


@pytest.mark.parametrize("remaining_runs", [2, 155])
def test_same_snapshot_revision_and_decremented_finite_budget(remaining_runs):
    event, records = pilot()
    event["inputs"]["continue_runs"] = str(remaining_runs)
    result = module.continuation(event, records, REVISION)
    assert result["ref"] == "main"
    assert result["inputs"] == {
        **event["inputs"], "continue_runs": str(remaining_runs - 1), "execution_revision": REVISION,
    }
    # The next main workflow still checks out the initial SHA, not its own head.
    second = module.continuation(result, records, REVISION)
    assert second["inputs"] == {**result["inputs"], "continue_runs": str(remaining_runs - 2)}


@pytest.mark.parametrize("revision", ["", "main", "b" * 39, "b" * 41, "B" * 40, REVISION + "\n", "$(git rev-parse HEAD)"])
def test_invalid_execution_revision_cannot_dispatch(revision):
    event, records = pilot()
    with pytest.raises(AssertionError):
        module.continuation(event, records, revision)


@pytest.mark.parametrize("explicit", ["main", "c" * 40])
def test_explicit_revision_and_actual_checkout_must_match(explicit):
    event, records = pilot()
    event["inputs"]["execution_revision"] = explicit
    with pytest.raises(AssertionError):
        module.continuation(event, records, REVISION)


def test_largest_real_original_fits_an_explicit_bounded_reservation():
    event, records = pilot()
    # Frozen manifest's largest original is 293,241,734 bytes; all four transfers
    # plus wrapper reservation require 1,173,264,274 bytes before starting it.
    event["inputs"]["max_bytes"] = "1173264274"
    assert module.continuation(event, records, REVISION)["inputs"]["max_bytes"] == "1173264274"
    event["inputs"]["max_bytes"] = str(2 * 1024**3 + 1)
    with pytest.raises(AssertionError):
        module.continuation(event, records, REVISION)


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
        module.continuation(event, records, REVISION)


def test_complete_snapshot_does_not_dispatch():
    event, records = pilot()
    records[1].update(
        status="snapshot_complete",
        cursor=78832,
        remaining=0,
        indexAntiJoin={"checked": 78832, "missing": 0},
    )
    assert module.continuation(event, records, REVISION) is None
