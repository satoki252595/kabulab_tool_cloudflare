"""Continue only a successfully verified, bounded run of the same frozen snapshot."""

import json
from pathlib import Path
import re
import sys


def continuation(event: dict, records: list[dict], execution_revision: str) -> dict | None:
    inputs = event["inputs"]
    assert re.fullmatch(r"[0-9a-f]{40}", execution_revision)
    # 初回空欄だけworkflowのgithub.sha。以後は実checkoutと指定SHAの完全一致が必須。
    assert inputs["execution_revision"] in ("", execution_revision)
    runs = int(inputs["continue_runs"])
    assert event["ref"] in ("main", "refs/heads/main") and 1 <= runs <= 200
    assert inputs["mode"] == "apply"
    assert not inputs.get("reconcile_sha256") and not inputs.get("reconcile_state_sha256")
    count, limit = int(inputs["expected_count"]), int(inputs["limit"])
    assert 0 < count <= 100000 and 0 < limit <= 500
    assert 0 < int(inputs["max_bytes"]) <= 2 * 1024**3
    assert 0 < int(inputs["max_seconds"]) <= 3600
    manifest, summary = records
    assert manifest["phase"] == "manifest" and summary["phase"] == "summary"
    assert manifest["planId"] == inputs["plan_id"] and manifest["cutoff"] == inputs["cutoff"]
    assert manifest["count"] == summary["inventoryRows"] == count
    assert re.fullmatch(r"[a-f0-9]{64}", manifest["manifestSha256"])
    assert manifest["manifestSha256"] == summary["manifestSha256"]
    assert summary["mode"] == "apply" and summary["upstreamGets"] == 0
    assert all(
        type(summary[key]) is int for key in ("cursor", "remaining", "processed", "verified")
    )
    assert 0 <= summary["cursor"] <= count and summary["remaining"] == count - summary["cursor"]
    assert 0 <= summary["processed"] == summary["verified"] <= limit
    if summary["status"] == "snapshot_complete":
        assert summary["cursor"] == count and summary["indexAntiJoin"] == {
            "checked": count,
            "missing": 0,
        }
        return None
    assert summary["status"] == "partial" and summary["indexAntiJoin"] is None
    assert summary["limitReached"] or (
        summary["stoppedByBudget"] and summary["budgetStopReason"] in ("bytes", "seconds")
    )
    # A final anti-join may be deferred to a fresh run after the last data item.
    assert summary["processed"] > 0 or (
        summary["cursor"] == count and summary["budgetStopReason"] == "seconds"
    )
    next_inputs = {
        k: inputs[k]
        for k in (
            "mode",
            "plan_id",
            "cutoff",
            "expected_count",
            "limit",
            "max_bytes",
            "max_seconds",
        )
    }
    next_inputs["continue_runs"] = str(runs - 1)
    next_inputs["execution_revision"] = execution_revision
    return {"ref": "main", "inputs": next_inputs}


if __name__ == "__main__":
    event_path, receipt_path, output_path = map(Path, sys.argv[1:4])
    execution_revision, = sys.argv[4:]
    selected, last = [], None
    with receipt_path.open() as receipt:
        for line in receipt:
            record = json.loads(line)
            last = record
            if record.get("phase") in ("manifest", "summary"):
                selected.append(record)
    assert last is not None and last.get("phase") == "summary", (
        "incomplete/STOP receipt; no dispatch"
    )
    assert len(selected) == 2
    result = continuation(json.loads(event_path.read_text()), selected, execution_revision)
    if result is not None:
        with output_path.open("x") as output:
            json.dump(result, output)
