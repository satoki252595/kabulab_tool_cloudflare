"""Captured 634A row/source metadata; physical ZIP is an existing local-only original."""
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import reparse_financials_from_notion as reparse  # noqa: E402
from conftest import fixture_path  # noqa: E402
from jp_stock_pipeline.notion.client import QueryTruncatedError  # noqa: E402

SAVED = json.loads((Path(__file__).resolve().parents[2]
                    / "scripts/notion/fixtures/financial-null-634a.json").read_text())


def pinned(path, value):
    content = (json.dumps(value, ensure_ascii=False) + "\n").encode()
    path.write_bytes(content)
    return hashlib.sha256(content).hexdigest()


def inputs(tmp_path, *, missing=False, mutate=None, response_mutate=None):
    page = json.loads(json.dumps(SAVED["response"]))
    raw = json.loads(json.dumps(SAVED["raw"]))
    if mutate:
        mutate(raw)
    if response_mutate:
        response_mutate(page)
    response_sha = pinned(tmp_path / "page.json", page)
    capture = {"kind": "financial-null-capture-v1", "version": 1, "status": "complete",
               "databaseId": SAVED["contract"]["databaseId"],
               "rawDatabaseId": SAVED["contract"]["rawDatabaseId"],
               "pages": [{"code": "634A", "file": "page.json", "sha256": response_sha,
                          "rowCount": 1, "hasMore": False, "nextCursor": None}]}
    capture_path = tmp_path / "capture.json"
    capture_sha = pinned(capture_path, capture)
    snapshot = tmp_path / "raw.json"
    snapshot_sha = pinned(snapshot, raw)
    sources = [] if missing else [{"raw_page_id": raw["id"], "snapshot_file": str(snapshot),
                                  "snapshot_sha256": snapshot_sha,
                                  "original_file": str(Path(__file__).parent
                                                       / "fixtures/financial-null-634a/original.zip"),
                                  "original_sha256": raw["properties"]["SHA256"]["rich_text"][0]["plain_text"]}]
    source_map = tmp_path / "sources.json"
    source_sha = pinned(source_map, {"version": 1, "sources": sources})
    return capture_path, capture_sha, source_map, source_sha, tmp_path / "diagnostic.jsonl", 1


def no_network(monkeypatch):
    monkeypatch.setattr(reparse, "NotionClient", lambda *a, **k: pytest.fail("offline mode opened Notion"))
    monkeypatch.setattr(reparse.httpx, "Client", lambda *a, **k: pytest.fail("offline mode opened HTTP"))


def records(journal):
    return [json.loads(line) for line in journal.read_text().splitlines()]


def test_missing_source_map_is_hold_without_network_or_value_inference(tmp_path, monkeypatch):
    no_network(monkeypatch)
    args = inputs(tmp_path, missing=True)
    reparse.diagnose_capture(*args)
    item, end = records(args[4])
    assert item["status"] == "HOLD" and item["reason"] == "local_original_missing"
    assert "cells" not in item
    assert end["summary"]["held"] == 1 and end["summary"]["api_requests"] == 0
    assert args[4].stat().st_mode & 0o077 == 0


@pytest.mark.parametrize("fault", ["source", "metric_type"])
def test_source_or_metric_type_mismatch_stays_hold(tmp_path, monkeypatch, fault):
    no_network(monkeypatch)
    args = inputs(tmp_path,
                  mutate=(lambda raw: raw["properties"]["ソース"]["select"].update(name="TDnet"))
                  if fault == "source" else None,
                  response_mutate=(lambda response: response["results"][0]["properties"].update(
                      {"ROA%": {"type": "rich_text", "rich_text": []}}))
                  if fault == "metric_type" else None)
    reparse.diagnose_capture(*args)
    assert records(args[4])[0]["status"] == "HOLD"


def test_explicit_incomplete_and_row_budget_are_not_accepted(tmp_path, monkeypatch):
    no_network(monkeypatch)
    args = inputs(tmp_path, missing=True, response_mutate=lambda page: page.update(
        request_status={"type": "incomplete", "incomplete_reason": "query_result_limit_reached"}))
    with pytest.raises(QueryTruncatedError):
        reparse.diagnose_capture(*args)
    assert args[4].read_text() == ""
    with pytest.raises(ValueError, match="契約"):
        reparse.diagnose_capture(*args[:-1], 0)


def test_same_original_634a_all_cells_match_without_repair_or_http(tmp_path, monkeypatch):
    content = fixture_path("financial-null-634a/original.zip").read_bytes()
    assert hashlib.sha256(content).hexdigest() == "0278f0d855e184c0252019e82c2e0e4a4f4bda6e342094c6b80a18dc82ba1637"
    no_network(monkeypatch)
    args = inputs(tmp_path)
    reparse.diagnose_capture(*args)
    item, end = records(args[4])
    assert item["status"] == "diagnosed"
    assert len(item["cells"]) == 19
    assert all(cell["old"] == cell["new"] for cell in item["cells"].values())
    assert item["cells"]["dps_actual"]["category"] == "non_numeric"
    assert item["cells"]["forecast_eps"]["category"] == "no_candidate_in_saved_scope"
    assert item["official_non_disclosure_proven"] is False
    assert end["summary"]["checked"] == 1 and end["summary"]["all_history_classified"] is False
