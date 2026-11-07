"""H-1: 短信XBRLの再取得は、③⑤を読み戻して揃った doc_id だけ省く。

修正前は④同値でも `_process_financial_xbrl`（先頭で XBRL fetch）が毎回走る。
このテストはそのコードに当てると失敗し、読戻し証明の後だけ成功する。
数値は構造フィクスチャ（市場の実測ではない）。本番 doc_id は使わない。
"""

from __future__ import annotations

import argparse
import hashlib
import logging
from datetime import date, datetime, timedelta
from uuid import UUID

import pandas as pd
import pytest

from jp_stock_pipeline.cloud_store.financials import COLUMNS, record_to_row
from jp_stock_pipeline.jobs import tdnet_hourly as mod
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import JST, DataQuality, Provenance, Source
from jp_stock_pipeline.notion import schema as S
from jp_stock_pipeline.notion.upsert import financial_summary_title
from jp_stock_pipeline.rawstore import converted_filename
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record

from test_tdnet_hourly import _ctx, _record

RAW_DB = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
FIN_DB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
RAW_PAGE = "12345678-1234-5678-1234-567812345678"
MASTER = "m-7203"
TAG = "[INC-20261105-kabulab_tool_cloudflare-tdnet-deadline-backlog]"
DAY = date(2026, 9, 11)
DISCLOSED = datetime(2026, 9, 11, 15, 0, tzinfo=JST)
FETCHED = datetime(2026, 9, 11, 16, 0, tzinfo=JST)
RAW_FETCHED = FETCHED - timedelta(hours=1)
TIDY_COLUMNS = [
    "code", "doc_id", "element", "context_ref", "period_start", "period_end",
    "instant_date", "consolidated", "unit", "dimensions", "value",
]


def _tidy(doc_id: str) -> pd.DataFrame:
    context = "CurrentAccumulatedQ1Duration_ConsolidatedMember_ResultMember"
    rows = []
    for element, value, unit in (
        ("NetSalesUS", "1000", "JPY"),
        ("NetIncomePerShareUS", "10.5", "JPY/shares"),
    ):
        row = {column: "" for column in TIDY_COLUMNS}
        row.update(
            code="7203", doc_id=doc_id, element=element, context_ref=context,
            period_end="2026-06-30", consolidated="連結", unit=unit, value=value,
        )
        rows.append(row)
    return pd.DataFrame(rows, columns=TIDY_COLUMNS)


def _financial(doc_id: str, sha: str):
    prov = Provenance(
        source=Source.TDNET,
        license_tag=LicenseTag.FACTUAL_CITE,
        data_date=DAY,
        fetched_at=FETCHED,
        raw_page_id=str(UUID(RAW_PAGE)),
        quality=DataQuality.OK,
    )
    record = tidy_to_financial_record(_tidy(doc_id), "7203", prov, disclosed_at=DISCLOSED)
    assert record is not None
    return record


def _d1_row(doc_id: str, sha: str) -> dict:
    record = _financial(doc_id, sha)
    values = record_to_row(record, stock_id=7, doc_id=doc_id, raw_sha256=sha)
    return dict(zip(COLUMNS, values, strict=True))


def _text(value: str, kind: str) -> dict:
    return {kind: [{"type": "text", "plain_text": value, "text": {"content": value}}]}


def _notion_financial(doc_id: str, sha: str) -> dict:
    record = _financial(doc_id, sha)
    numbers = {
        prop: {"type": "number", "number": None}
        for prop in (
            "売上高", "営業利益", "経常利益", "純利益", "EPS", "BPS", "ROE%", "ROA%",
            "自己資本比率%", "営業CF", "投資CF", "財務CF", "1株配当(実績)", "1株配当(予想)",
            "来期予想売上高", "来期予想営業利益", "来期予想経常利益", "来期予想純利益",
            "来期予想EPS",
        )
    }
    from jp_stock_pipeline.notion.upsert import _FIN_FIELD_TO_PROP
    for field, prop in _FIN_FIELD_TO_PROP.items():
        numbers[prop] = {"type": "number", "number": getattr(record, field)}
    title = financial_summary_title(record)
    return {
        "id": "fin-page",
        "properties": {
            S.FIN_PROP_TITLE: {"type": "title", **_text(title, "title")},
            S.FIN_PROP_CODE: {"type": "rich_text", **_text(record.code, "rich_text")},
            S.FIN_PROP_PERIOD_END: {"type": "date", "date": {"start": record.fiscal_period_end.isoformat()}},
            S.FIN_PROP_DISCLOSURE_TYPE: {"type": "select", "select": {"name": record.disclosure_type}},
            S.FIN_PROP_CONSOLIDATED: {"type": "select", "select": {"name": record.consolidated}},
            S.FIN_PROP_STANDARD: {"type": "select", "select": None},
            **numbers,
            S.FIN_PROP_DISCLOSED_AT: {"type": "date", "date": {"start": record.disclosed_at.isoformat()}},
            S.PROP_SOURCE: {"type": "select", "select": {"name": "TDnet"}},
            S.PROP_LICENSE_TAG: {"type": "select", "select": {"name": "factual-cite"}},
            S.PROP_DATA_DATE: {"type": "date", "date": {"start": DAY.isoformat()}},
            S.PROP_QUALITY: {"type": "select", "select": {"name": "正常"}},
            S.PROP_MASTER_RELATION: {"type": "relation", "relation": [{"id": MASTER}], "has_more": False},
            S.PROP_RAW_RELATION: {
                "type": "relation", "relation": [{"id": str(UUID(RAW_PAGE))}], "has_more": False,
            },
            S.PROP_FETCHED_AT: {"type": "date", "date": {"start": FETCHED.isoformat()}},
        },
    }


def _raw_page(doc_id: str, raw: bytes, csv: bytes, *, archived: bool = False, files=None) -> dict:
    filename = "tdnet_tdnet_xbrl_7203_20260911.zip"
    if files is None:
        files = [
            {
                "name": filename,
                "type": "file",
                "file": {
                    "url": "https://files.example.test/original",
                    "expiry_time": "2000-01-01T00:00:00.000Z",
                },
            },
            {
                "name": converted_filename(filename, "csv"),
                "type": "file",
                "file": {
                    "url": "https://files.example.test/tidy",
                    "expiry_time": "2000-01-01T00:00:00.000Z",
                },
            },
        ]
    return {
        "object": "page",
        "id": str(UUID(RAW_PAGE)),
        "archived": archived,
        "in_trash": False,
        "parent": {"type": "database_id", "database_id": RAW_DB},
        "properties": {
            S.RAW_PROP_FILENAME: {"type": "title", **_text(filename, "title")},
            S.RAW_PROP_FILES: {"type": "files", "files": files},
            S.RAW_PROP_DATATYPE: {"type": "rich_text", **_text("tdnet_xbrl", "rich_text")},
            S.RAW_PROP_SCOPE: {"type": "rich_text", **_text("7203", "rich_text")},
            S.RAW_PROP_SHA256: {"type": "rich_text", **_text(hashlib.sha256(raw).hexdigest(), "rich_text")},
            S.RAW_PROP_SIZE: {"type": "number", "number": len(raw)},
            S.PROP_SOURCE: {"type": "select", "select": {"name": "TDnet"}},
            S.PROP_LICENSE_TAG: {"type": "select", "select": {"name": "factual-cite"}},
            S.PROP_DATA_DATE: {"type": "date", "date": {"start": DAY.isoformat()}},
            S.PROP_FETCHED_AT: {"type": "date", "date": {"start": RAW_FETCHED.isoformat()}},
        },
    }


class _D1:
    def __init__(self, rows: list[dict], *, error: Exception | None = None, rows_read: int | None = 12):
        self.rows = rows
        self.error = error
        self.rows_read = rows_read
        self.calls: list[tuple[str, list]] = []

    def query(self, sql, params=None, **kwargs):
        self.calls.append((sql, list(params or [])))
        observe = kwargs.get("observe")
        if isinstance(observe, dict) and self.rows_read is not None:
            observe["rows_read"] = self.rows_read
        if self.error is not None:
            raise self.error
        wanted = set(params[1:]) if params else set()
        return [row for row in self.rows if row.get("doc_id") in wanted]


class _Cloud:
    def __init__(self, d1: _D1):
        self.d1 = d1
        self.settings = type("S", (), {"d1_enabled": staticmethod(lambda: True)})()
        self._stock_ids = {"7203": 7}
        self.per_share = 0
        self.forecast = 0

    def prefetch_stock_ids(self, codes):
        return len(list(codes))

    def upsert_per_share_facts(self, *args, **kwargs):
        self.per_share += 1

    def upsert_financial_forecast(self, *args, **kwargs):
        self.forecast += 1


def _run(monkeypatch, tmp_path, *, doc_ids: list[str], d1: _D1, raw_page: dict, financial_pages: list[dict],
         downloads: dict[str, bytes]):
    ctx = _ctx(str(tmp_path))
    ctx.settings.db_ids["raw_files"] = RAW_DB
    ctx.settings.db_ids["financials"] = FIN_DB
    ctx.args = argparse.Namespace(date=DAY, limit=None)
    cloud = _Cloud(d1)
    ctx.cloud = cloud
    records = []
    urls = {}
    for doc_id in doc_ids:
        record = _record(doc_id)
        record.disclosed_at = DISCLOSED
        record.provenance.data_date = DAY
        records.append(record)
        urls[doc_id] = f"https://xbrl.example.test/{doc_id}.zip"
    fetched: list[str] = []
    processed: list[str] = []
    monkeypatch.setattr(mod, "_collect", lambda *a: [(object(), records, urls)])
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: datetime.now(JST))
    monkeypatch.setattr(mod, "_gate_official_list", lambda *a, **k: None)
    monkeypatch.setattr(mod, "_load_master_map", lambda _: ({"7203": MASTER}, True))
    monkeypatch.setattr(mod.upsert, "load_disclosure_page_entries", lambda *a, **kw: {})
    monkeypatch.setattr(mod.file_upload, "load_raw_page_map", lambda *a, **kw: {})
    monkeypatch.setattr(
        mod.file_upload, "find_raw_page_by_sha256", lambda *a, **k: pytest.fail("sha_map逆引き")
    )
    monkeypatch.setattr(mod, "fetch", lambda url, **kw: fetched.append(url))

    def process(*args, **kwargs):
        processed.append(args[1].doc_id)

    monkeypatch.setattr(mod, "_process_financial_xbrl", process)
    gets: list[str] = []
    queries: list[str] = []
    downloaded: list[str] = []

    def get_page(page_id):
        gets.append(page_id)
        return raw_page

    def download_file(url, **kwargs):
        downloaded.append(url)
        if url not in downloads:
            raise RuntimeError("unsigned url")
        return downloads[url]

    def query_database(database_id, **kwargs):
        queries.append(database_id)
        return financial_pages

    ctx.client.get_page = get_page
    ctx.client.download_file = download_file
    ctx.client.query_database = query_database
    mod.execute(ctx)
    return {
        "fetched": fetched, "processed": processed, "gets": gets, "queries": queries,
        "downloaded": downloaded, "d1": d1, "cloud": cloud,
    }


def _complete_bundle(doc_id: str = "81234567"):
    raw = b"PK\x03\x04structural-xbrl"
    csv = _tidy(doc_id).to_csv(index=False).encode("utf-8")
    sha = hashlib.sha256(raw).hexdigest()
    return raw, csv, sha


def test_complete_doc_skips_refetch_after_full_readback(monkeypatch, tmp_path, caplog):
    doc_id = "81234567"
    raw, csv, sha = _complete_bundle(doc_id)
    other = "81234568"
    d1 = _D1([_d1_row(doc_id, sha)], rows_read=12)
    caplog.set_level(logging.INFO)
    out = _run(
        monkeypatch, tmp_path, doc_ids=[doc_id, other], d1=d1,
        raw_page=_raw_page(doc_id, raw, csv),
        financial_pages=[_notion_financial(doc_id, sha)],
        downloads={
            "https://files.example.test/original": raw,
            "https://files.example.test/tidy": csv,
        },
    )
    assert out["processed"] == [other]
    assert out["fetched"] == []
    assert out["gets"] == [str(UUID(RAW_PAGE))]
    assert out["downloaded"] == [
        "https://files.example.test/original",
        "https://files.example.test/tidy",
    ]
    assert out["queries"] == [FIN_DB]
    assert len(d1.calls) == 1
    sql, params = d1.calls[0]
    assert "jss_raw_files" not in sql
    assert "jss_financial_forecasts" not in sql
    assert "jss_per_share" not in sql
    assert "FROM jss_financials" in sql
    assert "doc_id IN" in sql
    assert params[0] == "TDnet"
    assert params[1:] == [doc_id, other]
    assert out["cloud"].per_share == 0 and out["cloud"].forecast == 0
    text = caplog.text
    assert f"{TAG} xbrl_skip=1 xbrl_reprocess=1" in text
    assert "d1_queries=1" in text
    assert "d1_rows_returned=1" in text
    assert "d1_rows_read=12" in text
    assert "notion_gets=1" in text
    assert f"downloads=2 download_bytes={len(raw) + len(csv)}" in text


def test_missing_rows_read_does_not_invent_a_scan_or_block_skip(monkeypatch, tmp_path, caplog):
    doc_id, other = "81234567", "81234568"
    raw, csv, sha = _complete_bundle(doc_id)
    caplog.set_level(logging.INFO)
    out = _run(
        monkeypatch, tmp_path, doc_ids=[doc_id, other],
        d1=_D1([_d1_row(doc_id, sha)], rows_read=None),
        raw_page=_raw_page(doc_id, raw, csv),
        financial_pages=[_notion_financial(doc_id, sha)],
        downloads={
            "https://files.example.test/original": raw,
            "https://files.example.test/tidy": csv,
        },
    )
    assert out["processed"] == [other]
    assert "d1_rows_read=unknown" in caplog.text


def test_tidy_that_builds_no_financial_record_reprocesses(monkeypatch, tmp_path):
    doc_id = "81234567"
    raw, _csv, sha = _complete_bundle(doc_id)
    unresolved = _tidy(doc_id)
    unresolved["period_end"] = ""
    unresolved["context_ref"] = "NoPeriod"
    empty = unresolved.to_csv(index=False).encode("utf-8")
    out = _run(
        monkeypatch, tmp_path, doc_ids=[doc_id], d1=_D1([_d1_row(doc_id, sha)]),
        raw_page=_raw_page(doc_id, raw, empty),
        financial_pages=[_notion_financial(doc_id, sha)],
        downloads={
            "https://files.example.test/original": raw,
            "https://files.example.test/tidy": empty,
        },
    )
    assert out["processed"] == [doc_id]
    assert "https://files.example.test/tidy" in out["downloaded"]


@pytest.mark.parametrize("flaw", ["archived", "upload_id", "sha", "no_tidy", "no_row", "many_rows", "read_error"])
def test_incomplete_evidence_reprocesses(monkeypatch, tmp_path, flaw):
    doc_id = "81234567"
    raw, csv, sha = _complete_bundle(doc_id)
    page = _raw_page(doc_id, raw, csv)
    rows = [_d1_row(doc_id, sha)]
    downloads = {
        "https://files.example.test/original": raw,
        "https://files.example.test/tidy": csv,
    }
    error = None
    if flaw == "archived":
        page = _raw_page(doc_id, raw, csv, archived=True)
    elif flaw == "upload_id":
        filename = "tdnet_tdnet_xbrl_7203_20260911.zip"
        page = _raw_page(doc_id, raw, csv, files=[{
            "name": filename, "type": "file_upload", "file_upload": {"id": "old-upload"},
        }])
    elif flaw == "sha":
        downloads = dict(downloads)
        downloads["https://files.example.test/original"] = b"not-the-original"
    elif flaw == "no_tidy":
        filename = "tdnet_tdnet_xbrl_7203_20260911.zip"
        page = _raw_page(doc_id, raw, csv, files=[{
            "name": filename, "type": "file",
            "file": {"url": "https://files.example.test/original", "expiry_time": "2099-01-01T00:00:00.000Z"},
        }])
    elif flaw == "no_row":
        rows = []
    elif flaw == "many_rows":
        rows = [_d1_row(doc_id, sha), _d1_row(doc_id, sha)]
    elif flaw == "read_error":
        error = RuntimeError("d1 read failed")
    out = _run(
        monkeypatch, tmp_path, doc_ids=[doc_id], d1=_D1(rows, error=error),
        raw_page=page, financial_pages=[_notion_financial(doc_id, sha)], downloads=downloads,
    )
    assert out["processed"] == [doc_id]
    if flaw in {"no_row", "many_rows", "read_error", "archived", "upload_id"}:
        assert out["downloaded"] == []
    if flaw == "upload_id":
        assert all("old-upload" not in url for url in out["downloaded"])


def test_unindexed_doc_id_read_is_one_scan_per_batch_not_per_doc(tmp_path):
    """ローカル sqlite。本番件数は使わない。索引なし doc_id は文ごとに SCAN。"""
    import json
    import sqlite3
    import time
    from jp_stock_pipeline.jobs.tdnet_xbrl_completion import financial_read_statements

    table_rows = 800
    candidates = [f"doc-{index:04d}" for index in range(30)]
    wide = [f"doc-{index:04d}" for index in range(120)]
    connection = sqlite3.connect(tmp_path / "proof.sqlite")
    connection.execute("CREATE TABLE jss_financials (doc_id TEXT, source TEXT, n INTEGER)")
    connection.executemany(
        "INSERT INTO jss_financials (doc_id, source, n) VALUES (?, 'TDnet', ?)",
        [(f"row-{index}", index) for index in range(table_rows)],
    )
    connection.commit()

    produced = financial_read_statements(candidates)
    assert len(produced) == 1 and "doc_id IN" in produced[0][0] and produced[0][1][0] == "TDnet"
    local_in = (
        "SELECT doc_id, source, n FROM jss_financials WHERE source = ? AND doc_id IN ("
        + ", ".join("?" for _ in candidates) + ")"
    )
    per_doc_sql = "SELECT doc_id, source, n FROM jss_financials WHERE source = ? AND doc_id = ?"
    batch_plan = " | ".join(
        " ".join(str(part) for part in row)
        for row in connection.execute("EXPLAIN QUERY PLAN " + local_in, ["TDnet", *candidates])
    )
    per_plan = " ".join(
        str(part) for part in connection.execute(
            "EXPLAIN QUERY PLAN " + per_doc_sql, ["TDnet", candidates[0]]
        ).fetchone()
    )
    assert "SCAN" in batch_plan and "SEARCH" not in batch_plan
    assert "SCAN" in per_plan

    started = time.perf_counter()
    for doc_id in candidates:
        connection.execute(per_doc_sql, ["TDnet", doc_id]).fetchall()
    per_seconds = time.perf_counter() - started
    statements = financial_read_statements(wide)
    local_wide = (
        "SELECT doc_id, source, n FROM jss_financials WHERE source = ? AND doc_id IN ("
        + ", ".join("?" for _ in wide[:99]) + ")"
    )
    started = time.perf_counter()
    returned = len(connection.execute(local_wide, ["TDnet", *wide[:99]]).fetchall())
    returned += len(connection.execute(
        "SELECT doc_id, source, n FROM jss_financials WHERE source = ? AND doc_id IN ("
        + ", ".join("?" for _ in wide[99:]) + ")",
        ["TDnet", *wide[99:]],
    ).fetchall())
    batch_seconds = time.perf_counter() - started
    report = {
        "table_rows": table_rows,
        "per_doc_candidates": len(candidates),
        "per_doc_statements": len(candidates),
        "per_doc_scan_rows": table_rows * len(candidates),
        "per_doc_seconds": round(per_seconds, 6),
        "batch_candidates": len(wide),
        "batch_statements": len(statements),
        "batch_scan_rows": table_rows * len(statements),
        "batch_rows_returned": returned,
        "batch_seconds": round(batch_seconds, 6),
        "batch_plan": batch_plan,
    }
    (tmp_path / "h1-bench.json").write_text(json.dumps(report), encoding="utf-8")
    print("H1_BENCH " + json.dumps(report))
    assert len(financial_read_statements(candidates)) == 1
    assert len(statements) == 2
    assert report["batch_scan_rows"] < report["per_doc_scan_rows"]
    assert returned == 0
