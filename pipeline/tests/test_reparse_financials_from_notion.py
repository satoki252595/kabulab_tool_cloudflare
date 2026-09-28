"""原本照合・再開・旧キーの隔離で、財務の誤補正を防ぐ。"""

from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Barrier, Event, Lock
from types import SimpleNamespace

import pytest
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import reparse_financials_from_notion as reparse  # noqa: E402
from test_backfill_financials_from_notion import _page  # noqa: E402
from jp_stock_pipeline.notion import schema as S  # noqa: E402
from jp_stock_pipeline.cloud_store.financials import COLUMNS, record_to_row  # noqa: E402
from jp_stock_pipeline.cloud_store.schema import _FINANCIALS  # noqa: E402
from test_financial_context_units import EDINET_CASES, fixture_provenance, fixture_tidy  # noqa: E402
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record  # noqa: E402


def test_parallel_repair_drains_inflight_failure_and_reproves_without_repatch(tmp_path, monkeypatch):
    """実EDINETの値は不変。旧連結欄の欠損・再読ドリフトだけを障害注入する。"""
    cases = {case["code"]: case for case in EDINET_CASES}
    records = {code: tidy_to_financial_record(fixture_tidy(case), code, fixture_provenance(case))
               for code, case in cases.items()}
    assert len(records) == 4
    pages = {code: {"id": code, "record": replace(record, consolidated=None)}
             for code, record in records.items()}
    journal, receipts = tmp_path / "audit.jsonl", tmp_path / "applied.jsonl"
    journal.write_text("\n".join(json.dumps({
        "page_id": code, "old": reparse._record_dict(pages[code]["record"]),
        "new": reparse._record_dict(record), "changes": {"consolidated": {}},
        "parser_sha256": reparse.PARSER_SHA256, "raw_sha256": cases[code]["raw_sha256"],
    }) for code, record in records.items()) + "\n")
    lock, simultaneous = Lock(), Barrier(2)
    failed_reread, release_inflight = Event(), Event()
    updates, queries, clients = [], [], []
    stop_signals = []
    failing = True

    class Client:
        def query_database(self, *args, **kwargs):
            code = kwargs["filter"]["or"][0]["rich_text"]["equals"]
            with lock:
                queries.append(code)
                page = pages[code].copy()
                if failing and code == "5918" and page["record"] == records[code]:
                    page["record"] = replace(records[code], consolidated=None)
                    failed_reread.set()
                return [page]

        def update_page(self, code, *args):
            with lock:
                updates.append(code)
            if failing:
                simultaneous.wait(timeout=3)
                if code == "6269":
                    assert release_inflight.wait(3)
            with lock:
                pages[code]["record"] = records[code]
                return pages[code].copy()

        def archive_page(self, *args):
            pytest.fail("同じ原ページの修復で退避しない")

    def connect(*args, **kwargs):
        clients.append(Client())
        return clients[-1]

    def stopping_event():
        signal = Event()
        stop_signals.append(signal)
        return signal

    monkeypatch.setattr(reparse, "NotionClient", connect)
    monkeypatch.setattr(reparse, "load_settings", lambda: SimpleNamespace(
        notion_token="test-token", notion_rps=6, db_id=lambda key: "db"))
    monkeypatch.setattr(reparse, "_page_record", lambda page: page["record"])
    monkeypatch.setattr(reparse, "financial_overwrite_allowed", lambda *args: True)
    monkeypatch.setattr(reparse, "APPLY_BATCH_CODES", 1)
    monkeypatch.setattr(reparse, "Event", stopping_event)
    with ThreadPoolExecutor(max_workers=1) as caller:
        future = caller.submit(reparse.apply_journal, journal, receipts, workers=2)
        try:
            assert failed_reread.wait(3)
            assert stop_signals[-1].wait(3)
            assert not future.done()  # 先行失敗でも開始済みPATCHの応答をdrainする。
        finally:
            release_inflight.set()
        with pytest.raises(ValueError, match="まとめ再読値"):
            future.result(timeout=3)
    assert len(clients) == 1
    assert set(queries) == set(updates) == {"5918", "6269"}
    assert receipts.read_text() == ""
    failing = False
    queries.clear()
    reparse.apply_journal(journal, receipts, workers=2)
    assert len(clients) == 2  # 各runは1 clientだけ。
    assert updates.count("5918") == updates.count("6269") == 1
    proved = reparse._journal_items(receipts)
    assert set(proved) == set(records)
    for code, record in records.items():
        assert proved[code]["record"] == reparse._record_dict(record)
        assert proved[code]["raw_sha256"] == cases[code]["raw_sha256"]
        assert proved[code]["parser_sha256"] == reparse.PARSER_SHA256


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
    with reparse.httpx.Client() as client, pytest.raises(ValueError, match="SHA256が一致しません"):
        reparse.reparse_record(old, raw, tmp_path, client)
    assert parsed == []


def test_stream_download_rejects_over_limit_before_buffering_more(monkeypatch):
    monkeypatch.setattr(reparse, "MAX_RAW_BYTES", 3)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b"abcd"))
    with httpx.Client(transport=transport) as client, pytest.raises(ValueError, match="上限"):
        reparse._download("https://example.invalid/archive", "8154", client)


def test_resumed_success_supersedes_error_without_erasing_history(tmp_path):
    journal = tmp_path / "audit.jsonl"
    lines = [{"page_id": "p", "error": "HTTP 503"}, {"page_id": "p", "changes": {}}]
    journal.write_text("\n".join(map(json.dumps, lines)) + "\n")
    assert reparse._journal_items(journal) == {"p": lines[-1]}
    assert len(journal.read_text().splitlines()) == 2


def test_stale_parser_journal_is_rejected_before_notion_connection(tmp_path, monkeypatch):
    journal = tmp_path / "audit.jsonl"
    journal.write_text(
        json.dumps({"page_id": "p", "parser_sha256": "old-parser", "changes": {}}) + "\n"
    )
    monkeypatch.setattr(
        reparse, "NotionClient", lambda *args, **kwargs: pytest.fail("未検証のparserで接続しない")
    )
    with pytest.raises(ValueError, match="parserが監査後に変わりました"):
        reparse.apply_journal(journal)


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
    assert reparse.apply_reparsed(Client(), "db", old_page, corrected) == ("reparsed", target)
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
        == ("newer_disclosure_preserved", target)
    )
    assert events == [("read", "target"), ("archive", "old")]


def test_bulk_proof_repair_is_read_back_and_resumes_without_rewriting(tmp_path, monkeypatch):
    old = reparse.notion_financial(_page())
    corrected = replace(old, consolidated="単体", net_sales=117_513_000_000)
    journal, receipts = tmp_path / "audit.jsonl", tmp_path / "applied.jsonl"
    item = {
        "page_id": "p", "old": reparse._record_dict(old),
        "new": reparse._record_dict(corrected), "changes": {"consolidated": {}},
        "parser_sha256": reparse.PARSER_SHA256, "raw_sha256": "a" * 64,
    }
    journal.write_text(json.dumps(item) + "\n")
    page = {"id": "p", "record": old}
    events = []

    class Client:
        def query_database(self, *args, **kwargs):
            events.append("bulk_read")
            return [page.copy()]

        def update_page(self, *args):
            events.append("update")
            page["record"] = corrected
            return page.copy()

        def get_page(self, *args):
            events.append("read_back")
            return page.copy()

    monkeypatch.setattr(reparse, "NotionClient", lambda *args, **kwargs: Client())
    monkeypatch.setattr(reparse, "load_settings", lambda: SimpleNamespace(
        notion_token="test-token", notion_rps=2.5, db_id=lambda key: "db",
    ))
    monkeypatch.setattr(reparse, "_page_record", lambda page: page["record"])
    monkeypatch.setattr(reparse, "financial_overwrite_allowed", lambda *args: True)
    reparse.apply_journal(journal, receipts)
    assert events == ["bulk_read", "update", "bulk_read"]
    receipt = reparse._journal_items(receipts)["p"]
    assert receipt["record"] == item["new"]
    assert receipt["raw_sha256"] == item["raw_sha256"]
    events.clear()
    reparse.apply_journal(journal, receipts)
    assert events == ["bulk_read"]
    assert reparse._journal_items(receipts)["p"]["record"] == item["new"]


@pytest.mark.parametrize("drift", ["target", "old", "duplicate"])
def test_batch_reread_drift_blocks_all_archive_and_receipts_then_resumes(tmp_path, monkeypatch, drift):
    original = reparse.notion_financial(_page())
    old = replace(original, fiscal_period_end=reparse.date(2027, 3, 31))
    target_old = replace(original, net_sales=None)
    pages = {"old": {"id": "old", "record": old},
             "target": {"id": "target", "record": target_old}}
    journal, receipts = tmp_path / "audit.jsonl", tmp_path / "applied.jsonl"
    item = {"page_id": "old", "old": reparse._record_dict(old),
            "new": reparse._record_dict(original), "changes": {"fiscal_period_end": {}},
            "parser_sha256": reparse.PARSER_SHA256, "raw_sha256": "a" * 64}
    journal.write_text(json.dumps(item) + "\n")
    events, queries = [], 0
    mismatch = True

    class Client:
        def query_database(self, *args, **kwargs):
            nonlocal queries
            queries += 1
            events.append("query")
            result = {key: page.copy() for key, page in pages.items()}
            if mismatch and queries == 2:
                if drift == "duplicate":
                    result["duplicate"] = {"id": "duplicate", "record": original}
                else:
                    result[drift]["record"] = replace(result[drift]["record"], net_sales=1)
            return list(result.values())
        def update_page(self, page_id, *args):
            events.append("update")
            pages[page_id]["record"] = original
            return pages[page_id].copy()
        def get_page(self, *args):
            pytest.fail("まとめ再読で個別GETを増やさない")
        def archive_page(self, page_id):
            events.append("archive")
            del pages[page_id]

    monkeypatch.setattr(reparse, "NotionClient", lambda *args, **kwargs: Client())
    monkeypatch.setattr(reparse, "load_settings", lambda: SimpleNamespace(
        notion_token="test-token", notion_rps=2.5, db_id=lambda key: "db"))
    monkeypatch.setattr(reparse, "_page_record", lambda page: page["record"])
    monkeypatch.setattr(reparse, "financial_overwrite_allowed", lambda *args: True)
    with pytest.raises(ValueError, match="まとめ再読値|旧正本が変わりました|新正本キーが重複"):
        reparse.apply_journal(journal, receipts)
    assert events == ["query", "update", "query"]
    assert receipts.read_text() == "" and "old" in pages
    mismatch = False
    events.clear()
    reparse.apply_journal(journal, receipts)
    assert events == ["query", "query", "archive"]
    assert reparse._journal_items(receipts)["old"]["record"] == item["new"]


def test_verified_repair_clears_wrong_values_and_protects_newer_disclosure():
    conn = sqlite3.connect(":memory:")
    conn.execute(_FINANCIALS)
    original = reparse.notion_financial(_page())
    wrong = replace(original, net_sales=117_513_000_000, dps_actual=999)
    old_row = record_to_row(wrong, stock_id=None, doc_id="S100YNQJ", raw_sha256=None)
    old_row[COLUMNS.index("license_tag")] = "factual-cite"
    conn.execute(reparse._repair_sql(), [json.dumps([old_row])])
    correct_row = record_to_row(original, stock_id=None, doc_id=None, raw_sha256="a" * 64)
    for _ in range(2):
        conn.execute(reparse._repair_sql(), [json.dumps([correct_row])])
    assert conn.execute("SELECT net_sales,dps_actual,doc_id,license_tag,raw_sha256 "
                        "FROM jss_financials").fetchone() == (
        547_779_000_000, None, "S100YNQJ", "factual-cite", "a" * 64,
    )
    newer = replace(original, disclosed_at=original.disclosed_at + timedelta(days=1),
                    net_sales=original.net_sales + 1)
    conn.execute(reparse._repair_sql(), [json.dumps([
        record_to_row(newer, stock_id=None, doc_id=None, raw_sha256="b" * 64)
    ])])
    conn.execute(reparse._repair_sql(), [json.dumps([correct_row])])
    assert conn.execute("SELECT net_sales,raw_sha256 FROM jss_financials").fetchone() == (
        newer.net_sales, "b" * 64,
    )


@pytest.mark.parametrize("wrong_value", [False, True])
def test_d1_repair_rejects_missing_notion_read_proof_before_connecting(
    tmp_path, monkeypatch, wrong_value,
):
    old = reparse.notion_financial(_page())
    item = {"page_id": "p", "old": reparse._record_dict(old),
            "new": reparse._record_dict(old), "changes": {},
            "parser_sha256": reparse.PARSER_SHA256, "raw_sha256": "a" * 64}
    journal, receipts = tmp_path / "audit.jsonl", tmp_path / "applied.jsonl"
    journal.write_text(json.dumps(item) + "\n")
    receipt = {"page_id": "p", "target_page_id": "p",
               "record": reparse._record_dict(replace(old, net_sales=old.net_sales + 1)),
               "parser_sha256": reparse.PARSER_SHA256, "raw_sha256": "a" * 64}
    receipts.write_text(json.dumps(receipt) + "\n" if wrong_value else "")
    monkeypatch.setattr(reparse, "load_settings", lambda: pytest.fail("未検証なら接続しない"))
    with pytest.raises(ValueError, match="Notion再読成功"):
        reparse.sync_d1(journal, receipts)


def test_d1_repair_rejects_receipt_from_another_original_key(tmp_path, monkeypatch):
    cases = EDINET_CASES[:2]
    records = [tidy_to_financial_record(fixture_tidy(case), case["code"], fixture_provenance(case))
               for case in cases]
    journal, receipts = tmp_path / "audit.jsonl", tmp_path / "applied.jsonl"
    journal.write_text("\n".join(json.dumps({
        "page_id": case["code"], "old": reparse._record_dict(record),
        "new": reparse._record_dict(record), "parser_sha256": reparse.PARSER_SHA256,
        "raw_sha256": case["raw_sha256"],
    }) for case, record in zip(cases, records, strict=True)) + "\n")
    receipts.write_text("\n".join(json.dumps({
        "page_id": case["code"], "target_page_id": cases[1]["code"],
        "record": reparse._record_dict(records[1]), "parser_sha256": reparse.PARSER_SHA256,
        "raw_sha256": case["raw_sha256"],
    }) for case in cases) + "\n")
    monkeypatch.setattr(reparse, "load_settings", lambda: pytest.fail("別原本キーなら接続しない"))
    with pytest.raises(ValueError, match="元原本の財務キー"):
        reparse.sync_d1(journal, receipts)


@pytest.mark.parametrize("newer", [False, True])
def test_d1_repair_rejects_duplicate_live_key_before_d1_write(tmp_path, monkeypatch, newer):
    case = EDINET_CASES[0]
    record = tidy_to_financial_record(fixture_tidy(case), case["code"], fixture_provenance(case))
    journal, receipts = tmp_path / "audit.jsonl", tmp_path / "applied.jsonl"
    journal.write_text(json.dumps({
        "page_id": "original", "old": reparse._record_dict(record),
        "new": reparse._record_dict(record), "parser_sha256": reparse.PARSER_SHA256,
        "raw_sha256": case["raw_sha256"],
    }) + "\n")
    receipts.write_text(json.dumps({
        "page_id": "original", "target_page_id": "original",
        "record": reparse._record_dict(record), "parser_sha256": reparse.PARSER_SHA256,
        "raw_sha256": case["raw_sha256"],
    }) + "\n")
    # 実原本の値は不変。後発の重複ページというメタ情報だけを障害注入する。
    duplicate = replace(record, disclosed_at=record.provenance.fetched_at + timedelta(days=1)) if newer else record

    class Client:
        def query_database(self, *args, **kwargs):
            return [{"id": "original", "record": record}, {"id": "duplicate", "record": duplicate}]

    monkeypatch.setattr(reparse, "NotionClient", lambda *args, **kwargs: Client())
    monkeypatch.setattr(reparse, "_page_record", lambda page: page["record"])
    monkeypatch.setattr(reparse, "load_settings", lambda: SimpleNamespace(
        notion_token="test-token", notion_rps=2.5, db_id=lambda key: "db",
        cloud_store=SimpleNamespace(d1_enabled=lambda: True),
    ))
    monkeypatch.setattr(reparse, "D1Store", lambda *args, **kwargs: pytest.fail("重複ならD1接続しない"))
    with pytest.raises(ValueError, match="財務キーが一意"):
        reparse.sync_d1(journal, receipts)


def test_d1_repair_does_not_keep_document_id_from_a_known_different_raw_sha():
    case = EDINET_CASES[0]
    record = tidy_to_financial_record(fixture_tidy(case), case["code"], fixture_provenance(case))
    conn = sqlite3.connect(":memory:")
    conn.execute(_FINANCIALS)
    row = record_to_row(record, stock_id=None, doc_id="previous-document", raw_sha256="a" * 64)
    conn.execute(reparse._repair_sql(), [json.dumps([row])])
    row[COLUMNS.index("doc_id")] = None
    row[COLUMNS.index("raw_sha256")] = case["raw_sha256"]
    conn.execute(reparse._repair_sql(), [json.dumps([row])])
    assert conn.execute("SELECT doc_id,raw_sha256 FROM jss_financials").fetchone() == (
        None, case["raw_sha256"],
    )


@pytest.mark.parametrize("read_back_net_sales", [547_779_000_000, 547_779_000_000.0])
@pytest.mark.parametrize("archive_parser", ["current", "previous-parser"])
@pytest.mark.parametrize("target_old_replaced", [False, True])
def test_newer_collision_is_reparsed_first_and_keeps_original_archive_proof(
    tmp_path, monkeypatch, read_back_net_sales, archive_parser, target_old_replaced,
):
    older = replace(reparse.notion_financial(_page()), fiscal_period_end=reparse.date(2027, 3, 31))
    older_new = replace(older, fiscal_period_end=reparse.date(2025, 3, 31))
    newer_old = replace(older_new, disclosed_at=older.disclosed_at + timedelta(days=1), net_sales=None)
    newer_new = replace(newer_old, net_sales=547_779_000_000)
    read_back = replace(newer_new, net_sales=read_back_net_sales)
    journal, receipts = tmp_path / "audit.jsonl", tmp_path / "applied.jsonl"
    def item(page_id, old, new, digest):
        return {"page_id": page_id, "old": reparse._record_dict(old),
                "new": reparse._record_dict(new), "changes": {"net_sales": {}},
                "parser_sha256": reparse.PARSER_SHA256, "raw_sha256": digest}
    originals = [
        item("archived", older, older_new, "a" * 64),
        item("target", newer_old, newer_new, "b" * 64),
    ]
    if target_old_replaced:
        # 後日原本の誤キーを古い原本の正しいキーへ合流済み。数値は同じ実fixture。
        originals = [
            item("archived", replace(newer_old, fiscal_period_end=older.fiscal_period_end),
                 newer_new, "b" * 64),
            item("target", older_new, older_new, "a" * 64),
        ]
    journal.write_text("\n".join(map(json.dumps, originals)) + "\n")
    receipts.write_text(json.dumps({
        "page_id": "archived", "target_page_id": "target",
        "record": reparse._record_dict(newer_old),
        "parser_sha256": reparse.PARSER_SHA256 if archive_parser == "current" else archive_parser,
        "raw_sha256": originals[0]["raw_sha256"], "action": "newer_disclosure_preserved",
    }) + "\n")
    page, events = {"id": "target", "record": read_back if target_old_replaced else newer_old}, []
    class Client:
        def query_database(self, *args, **kwargs):
            return [page.copy()]
        def update_page(self, *args):
            events.append("update_latest")
            page["record"] = read_back
            return page.copy()
        def get_page(self, *args):
            events.append("read_latest")
            return page.copy()
    monkeypatch.setattr(reparse, "NotionClient", lambda *args, **kwargs: Client())
    monkeypatch.setattr(reparse, "load_settings", lambda: SimpleNamespace(
        notion_token="test-token", notion_rps=2.5, db_id=lambda key: "db",
    ))
    monkeypatch.setattr(reparse, "_page_record", lambda page: page["record"])
    monkeypatch.setattr(reparse, "financial_overwrite_allowed",
                        lambda page, record: page["record"].disclosed_at <= record.disclosed_at)
    reparse.apply_journal(journal, receipts)
    assert events == ([] if target_old_replaced else ["update_latest"])
    proof = reparse._journal_items(receipts)
    assert proof["archived"]["record"] == reparse._record_dict(newer_new)
    assert proof["archived"]["raw_sha256"] == originals[0]["raw_sha256"]
    assert proof["target"]["raw_sha256"] == originals[1]["raw_sha256"]
    events.clear()
    reparse.apply_journal(journal, receipts)
    assert events == []
    if target_old_replaced:
        page["record"] = replace(read_back, net_sales=None)
        with pytest.raises(ValueError, match="監査後に正本が変わりました"):
            reparse.apply_journal(journal, receipts)
        assert events == []  # 未検証の欠損をcanonical最新版として認めない。


@pytest.mark.parametrize("stored_hash,source", [(None, "EDINET"), ("b" * 64, "EDINET"),
                                               ("a" * 64, "TDnet")])
def test_notion_verified_d1_repair_retires_only_matching_old_key(tmp_path, monkeypatch, stored_hash, source):
    old = replace(reparse.notion_financial(_page()), fiscal_period_end=reparse.date(2027, 3, 31))
    old = replace(old, provenance=replace(old.provenance, source=reparse.Source(source)))
    corrected = replace(old, fiscal_period_end=reparse.date(2025, 3, 31),
                        consolidated="単体", net_sales=117_513_000_000)
    item = {"page_id": "p", "old": reparse._record_dict(old),
            "new": reparse._record_dict(corrected), "changes": {"fiscal_period_end": {}},
            "parser_sha256": reparse.PARSER_SHA256, "raw_sha256": "a" * 64,
            "raw_url": "https://api.edinet-fsa.go.jp/api/v2/documents/S100YNQJ?type=5"}
    read_back = replace(corrected, net_sales=float(corrected.net_sales))
    receipt = {"page_id": "p", "target_page_id": "p", "record": reparse._record_dict(read_back),
               "parser_sha256": reparse.PARSER_SHA256, "raw_sha256": "a" * 64}
    journal, receipts = tmp_path / "audit.jsonl", tmp_path / "applied.jsonl"
    journal.write_text(json.dumps(item) + "\n")
    receipts.write_text(json.dumps(receipt) + "\n")
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(_FINANCIALS)
    conn.execute(reparse._repair_sql(), [json.dumps([
        record_to_row(old, stock_id=None,
                      doc_id="140120260917537640" if source == "TDnet" else None,
                      raw_sha256=stored_hash)
    ])])
    conn.execute("CREATE TABLE core_stocks (id INTEGER, code TEXT)")
    conn.execute("INSERT INTO core_stocks VALUES (1,'8154')")

    class Store:
        def query(self, sql, params=None):
            return [dict(row) for row in conn.execute(sql, params or []).fetchall()]

    class Client:
        def query_database(self, *args, **kwargs):
            return [{"id": "p", "record": read_back}]

    monkeypatch.setattr(reparse, "D1Store", lambda *args, **kwargs: Store())
    monkeypatch.setattr(reparse, "NotionClient", lambda *args, **kwargs: Client())
    monkeypatch.setattr(reparse, "_page_record", lambda page: page["record"])
    monkeypatch.setattr(reparse, "load_settings", lambda: SimpleNamespace(
        notion_token="test-token", notion_rps=2.5, db_id=lambda key: "db",
        cloud_store=SimpleNamespace(d1_enabled=lambda: True),
    ))
    reparse.sync_d1(journal, receipts)
    reparse.sync_d1(journal, receipts)
    result = [tuple(row) for row in conn.execute(
        "SELECT fiscal_period_end,consolidated,net_sales,stock_id,doc_id FROM jss_financials "
        "ORDER BY fiscal_period_end"
    )]
    doc_id = "140120260917537640" if source == "TDnet" else "S100YNQJ"
    assert result[0] == ("2025-03-31", "単体", 117_513_000_000, 1, doc_id)
    assert len(result) == (2 if stored_hash == "b" * 64 else 1)
