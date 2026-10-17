"""Control-plane projection from the saved RAW63 safe summary; no source HTTP."""

import copy
from pathlib import Path
import runpy
import unittest

continuation = runpy.run_path(str(Path(__file__).with_name("raw-index-continue.py")))[
    "continuation"
]
REVISION = "9cdf4f04ba87d1dc8816535883c1f6d45e692489"
MANIFEST_SHA = "fccedf9bb6c1548ff3a0b206634fbdbf531acaac63192275cc31720f1db11362"
EVENT = {
    "ref": "main",
    "inputs": {
        "mode": "apply", "execution_revision": REVISION, "continue_runs": "137",
        "plan_id": "canonical-20261014", "cutoff": "2026-10-13T18:31:00.000Z",
        "expected_count": "78832", "limit": "500", "max_bytes": "2147483648",
        "max_seconds": "3600", "reconcile_sha256": "", "reconcile_state_sha256": "",
    },
}
RECORDS = [
    {"phase": "manifest", "planId": "canonical-20261014", "cutoff": EVENT["inputs"]["cutoff"],
     "count": 78832, "manifestSha256": MANIFEST_SHA},
    {"phase": "summary", "inventoryRows": 78832, "manifestSha256": MANIFEST_SHA,
     "mode": "apply", "upstreamGets": 0, "cursor": 19378, "remaining": 59454,
     "processed": 500, "verified": 500, "status": "partial", "indexAntiJoin": None,
     "limitReached": True, "stoppedByBudget": False, "budgetStopReason": None},
]


class ContinuationTests(unittest.TestCase):
    def test_legacy_and_empty_hosted_input_preserve_exact_dispatch(self):
        expected = {key: EVENT["inputs"][key] for key in (
            "mode", "plan_id", "cutoff", "expected_count", "limit", "max_bytes", "max_seconds"
        )}
        expected.update(continue_runs="136", execution_revision=REVISION)
        for extra in ({}, {"hosted_max_rps": ""}):
            event = copy.deepcopy(EVENT)
            event["inputs"].update(extra)
            self.assertEqual(continuation(event, RECORDS, REVISION), {"ref": "main", "inputs": expected})

    def test_explicit_successful_hosted_mode_is_carried_without_pool_reset(self):
        event = copy.deepcopy(EVENT)
        event["inputs"]["hosted_max_rps"] = "1.0"
        result = continuation(event, RECORDS, REVISION)
        self.assertEqual(result["inputs"]["hosted_max_rps"], "1.0")
        self.assertEqual(result["inputs"]["continue_runs"], "136")
        self.assertEqual(result["inputs"]["execution_revision"], REVISION)

    def test_unknown_or_reconciliation_cannot_continue(self):
        event = copy.deepcopy(EVENT)
        event["inputs"]["hosted_max_rps"] = "1.0"
        records = copy.deepcopy(RECORDS)
        records[1]["status"] = "stopped"
        with self.assertRaises(AssertionError):
            continuation(event, records, REVISION)
        event["inputs"]["reconcile_sha256"] = "a" * 64
        with self.assertRaises(AssertionError):
            continuation(event, RECORDS, REVISION)


if __name__ == "__main__":
    unittest.main()
