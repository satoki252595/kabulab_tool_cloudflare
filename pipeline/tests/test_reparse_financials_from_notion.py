"""原本照合・再開・旧キーの隔離で、財務の誤補正を防ぐ。"""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import reparse_financials_from_notion as reparse  # noqa: E402
from test_backfill_financials_from_notion import _page  # noqa: E402
from jp_stock_pipeline.notion import schema as S  # noqa: E402


def test_mismatched_archive_hash_stops_before_parsing(tmp_path, monkeypatch):
    old = reparse.notion_financial(_page())
    digest = "a" * 64
    (tmp_path / f"{digest}.zip").write_bytes(b"corrupted archive")
    raw = {
        "properties": {
            S.PROP_SOURCE: {"select": {"name": "EDINET"}},
            S.RAW_PROP_SCOPE: {"rich_text": [{"plain_text": "8154"}]},
            S.RAW_PROP_SHA256: {"rich_text": [{"plain_text": digest}]},
        }
    }
    parsed = []
    monkeypatch.setattr(reparse, "edinet_csv_zip_to_tidy", lambda *args: parsed.append(args))
    with pytest.raises(ValueError, match="SHA256が一致しません"):
        reparse.reparse_record(old, raw, tmp_path)
    assert parsed == []


def test_resumed_success_supersedes_error_without_erasing_history(tmp_path):
    journal = tmp_path / "audit.jsonl"
    lines = [{"page_id": "p", "error": "HTTP 503"}, {"page_id": "p", "changes": {}}]
    journal.write_text("\n".join(map(json.dumps, lines)) + "\n")
    assert reparse._journal_items(journal) == {"p": lines[-1]}
    assert len(journal.read_text().splitlines()) == 2


def test_old_key_is_not_archived_until_corrected_value_is_read_back(monkeypatch):
    old = reparse.notion_financial(_page())
    corrected = replace(old, consolidated="単体")
    old_page, target = {"id": "old"}, {"id": "target"}
    events = []

    class Client:
        def query_database(self, *args, **kwargs):
            return [target]

        def update_page(self, page_id, props):
            events.append(("update", page_id))

        def get_page(self, page_id):
            events.append(("read", page_id))
            return target

        def archive_page(self, page_id):
            events.append(("archive", page_id))

    monkeypatch.setattr(reparse, "financial_overwrite_allowed", lambda *args: True)
    monkeypatch.setattr(reparse, "_page_record", lambda page: old)
    with pytest.raises(ValueError, match="再読値"):
        reparse.apply_reparsed(Client(), "db", old_page, corrected)
    assert events == [("update", "target"), ("read", "target")]
    events.clear()
    monkeypatch.setattr(reparse, "_page_record", lambda page: corrected)
    assert reparse.apply_reparsed(Client(), "db", old_page, corrected) == "reparsed"
    assert events == [("update", "target"), ("read", "target"), ("archive", "old")]


def test_newer_disclosure_is_kept_when_old_key_collides(monkeypatch):
    old = reparse.notion_financial(_page())
    corrected = replace(old, consolidated="単体")
    newer = replace(corrected, disclosed_at=old.disclosed_at + timedelta(days=1))
    target = {
        "id": "target",
        "properties": {
            S.FIN_PROP_DISCLOSED_AT: {"date": {"start": newer.disclosed_at.isoformat()}}
        },
    }
    events = []

    class Client:
        def query_database(self, *args, **kwargs):
            return [target]

        def get_page(self, page_id):
            events.append(("read", page_id))
            return target

        def update_page(self, *args):
            pytest.fail("新しい開示は上書きしない")

        def archive_page(self, page_id):
            events.append(("archive", page_id))

    monkeypatch.setattr(reparse, "_page_record", lambda page: newer)
    assert (
        reparse.apply_reparsed(Client(), "db", {"id": "old"}, corrected)
        == "newer_disclosure_preserved"
    )
    assert events == [("read", "target"), ("archive", "old")]
