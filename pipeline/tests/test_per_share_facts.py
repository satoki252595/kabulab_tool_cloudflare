"""`jss_per_share_facts` (1株当たり指標の出典fact) の行構築・upsert テスト (#651)。

6532 の実短信XBRL (ignored fixture) を使い、抽出diagnosticが
要素・文脈つきのfact行として保存されることを固定する。
"""

from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from jp_stock_pipeline.cloud_store import per_share_facts
from jp_stock_pipeline.cloud_store.schema import SCHEMA_STATEMENTS
from jp_stock_pipeline.convert.xbrl_to_csv import xbrl_zip_to_tidy
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Provenance, Source
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record
from conftest import fixture_path

SHA_6532 = "3d010eb3eb80832108df320ab374a1495a7078140a051dfb2090b532bd5f7dd9"
DOC_6532 = "140120261009548418"
JST = timezone(timedelta(hours=9))


def _record_6532(disc: datetime):
    content = fixture_path("tdnet/context-unit/6532.zip").read_bytes()
    assert hashlib.sha256(content).hexdigest() == SHA_6532
    tidy = xbrl_zip_to_tidy(content, "6532", DOC_6532)
    prov = Provenance(
        source=Source.TDNET,
        license_tag=LicenseTag.FACTUAL_CITE,
        data_date=disc.date(),
        fetched_at=disc,
    )
    diagnostics: dict[str, dict] = {}
    record = tidy_to_financial_record(
        tidy, "6532", prov, disclosed_at=disc, diagnostics=diagnostics
    )
    assert record is not None
    return record, diagnostics


def _by_metric(rows: list[list]) -> dict[str, dict]:
    return {
        row[per_share_facts.COLUMNS.index("metric")]: dict(
            zip(per_share_facts.COLUMNS, row)
        )
        for row in rows
    }


def test_schema_statements_include_fact_table():
    joined = "\n".join(SCHEMA_STATEMENTS)
    assert "CREATE TABLE IF NOT EXISTS jss_per_share_facts" in joined
    assert "idx_jss_psf_code_metric" in joined


def test_build_rows_from_real_6532_tanshin():
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, diagnostics = _record_6532(disc)
    rows = per_share_facts.build_rows(
        record, diagnostics, doc_id=DOC_6532, raw_sha256=SHA_6532
    )
    by_metric = _by_metric(rows)

    # 実績EPSは連結factとして、要素・文脈つきで残る。
    eps = by_metric["eps"]
    assert eps["value"] == pytest.approx(148.63)
    assert "EarningsPerShare" in (eps["element"] or "")
    assert eps["element_scope"] == "連結"
    assert eps["source_context_kind"] == "current"
    # 分割basisは一次根拠が無いので断定しない。チェックは Phase 1 では未実施。
    assert eps["split_basis"] == "unknown"
    assert eps["check_status"] == "not_checkable"
    assert eps["doc_id"] == DOC_6532
    assert eps["raw_sha256"] == SHA_6532
    assert eps["license_tag"] == "factual-cite"

    # 予想EPS・予想配当も fact になる (予想配当は単体文脈)。
    assert by_metric["forecast_eps"]["value"] == pytest.approx(323.79)
    dpsf = by_metric["dps_forecast"]
    assert dpsf["value"] == pytest.approx(130.0)
    assert dpsf["element_scope"] == "単体"

    # 中間短信で BPS は値が無く、候補要素の選択痕跡も無いため行を作らない。
    assert record.bps is None
    assert "bps" not in by_metric


class _SqliteStore:
    """D1Store の最小面 (query / rows_per_request) を sqlite で代替する。"""

    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def query(self, sql: str, params: list | None = None):
        cur = self._conn.execute(sql, params or [])
        cols = [d[0] for d in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    def rows_per_request(self, column_count: int) -> int:
        return max(1, 100 // column_count)


def test_write_is_idempotent_and_older_fetch_does_not_overwrite():
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, diagnostics = _record_6532(disc)
    rows = per_share_facts.build_rows(
        record, diagnostics, doc_id=DOC_6532, raw_sha256=SHA_6532
    )
    conn = sqlite3.connect(":memory:")
    for stmt in SCHEMA_STATEMENTS:
        if "jss_per_share_facts" in stmt:
            conn.execute(stmt)
    store = _SqliteStore(conn)

    assert per_share_facts.write(store, rows) == len(rows)
    assert per_share_facts.write(store, rows) == len(rows)
    n = conn.execute("SELECT COUNT(*) FROM jss_per_share_facts").fetchone()[0]
    assert n == len(rows)

    # 古い fetched_at の再処理が新しい抽出結果を巻き戻さない。
    value_i = per_share_facts.COLUMNS.index("value")
    fetched_i = per_share_facts.COLUMNS.index("fetched_at")
    stale = [list(r) for r in rows]
    for r in stale:
        if r[per_share_facts.COLUMNS.index("metric")] == "eps":
            r[value_i] = -1.0
        r[fetched_i] = int(disc.timestamp()) - 3600
    per_share_facts.write(store, stale)
    got = conn.execute(
        "SELECT value FROM jss_per_share_facts WHERE metric = 'eps'"
    ).fetchone()[0]
    assert got == pytest.approx(148.63)


def test_build_rows_requires_doc_id():
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, diagnostics = _record_6532(disc)
    with pytest.raises(Exception, match="doc_id"):
        per_share_facts.build_rows(record, diagnostics, doc_id=None, raw_sha256=SHA_6532)
