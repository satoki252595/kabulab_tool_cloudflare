"""`jss_financial_forecasts` (会社予想の開示単位レコード) のテスト (#652)。

守るべき不変条件:
- 予想は TDnet 書類 1 件 = 1 行で残り、対象期末は文脈から単一に
  定まるときだけ入る (導出しない)。
- 予想要素の無い書類は行を作らず、nil (予想未定) の書類は NULL の
  まま行を残す (古い予想へのフォールバックで未定を隠さない)。
- EDINET の ③上書きが予想行を消さない (#648 の回帰テスト)。
"""

from __future__ import annotations

import hashlib
import sqlite3
from dataclasses import replace
from datetime import datetime, timedelta, timezone

import pytest

from _doubles import SqliteD1
from test_cloud_financials import _write as _write_financials

from conftest import fixture_path
from jp_stock_pipeline.cloud_store import financial_forecasts, financials as F
from jp_stock_pipeline.cloud_store.schema import SCHEMA_STATEMENTS
from jp_stock_pipeline.convert.xbrl_to_csv import xbrl_zip_to_tidy
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Provenance, Source
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record

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


def _as_dict(row: list) -> dict:
    return dict(zip(financial_forecasts.COLUMNS, row))


def test_schema_statements_include_forecast_table():
    joined = "\n".join(SCHEMA_STATEMENTS)
    assert "CREATE TABLE IF NOT EXISTS jss_financial_forecasts" in joined
    assert "idx_jss_fc_code_disclosed" in joined


def test_build_rows_from_real_6532_tanshin():
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, diagnostics = _record_6532(disc)
    rows = financial_forecasts.build_rows(
        record, diagnostics, doc_id=DOC_6532, raw_sha256=SHA_6532
    )
    assert len(rows) == 1
    row = _as_dict(rows[0])
    # 短信の通期予想が開示単位でそのまま残る。
    assert row["forecast_net_sales"] == pytest.approx(190_000_000_000.0)
    assert row["forecast_operating_income"] == pytest.approx(64_800_000_000.0)
    assert row["forecast_net_income"] == pytest.approx(48_100_000_000.0)
    assert row["forecast_eps"] == pytest.approx(323.79)
    assert row["dps_forecast"] == pytest.approx(130.0)
    # IFRS に経常利益は無い。無いものは NULL のまま。
    assert row["forecast_ordinary_income"] is None
    # 対象期末は文脈 period_end から読んだ値 (導出ではない)。
    assert row["target_period_end"] == "2027-02-28"
    assert row["dps_target_period_end"] == "2027-02-28"
    assert row["forecast_scope"] == "current_year"
    assert row["source_period_end"] == "2026-08-31"
    assert row["source_disclosure_type"] == "中間"
    assert row["consolidated"] == "連結"
    assert row["doc_id"] == DOC_6532
    assert row["raw_sha256"] == SHA_6532
    assert row["license_tag"] == "factual-cite"
    assert row["disclosed_at"] == int(disc.timestamp())


def test_build_rows_no_forecast_elements_yields_no_row():
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, _ = _record_6532(disc)
    rows = financial_forecasts.build_rows(
        record, {}, doc_id=DOC_6532, raw_sha256=SHA_6532
    )
    assert rows == []


def test_build_rows_undetermined_keeps_null_row():
    """予想要素はあるが値が無い (未定) 開示は NULL のまま 1 行残す。"""
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, _ = _record_6532(disc)
    undetermined = replace(
        record,
        forecast_net_sales=None,
        forecast_operating_income=None,
        forecast_ordinary_income=None,
        forecast_net_income=None,
        forecast_eps=None,
        dps_forecast=None,
    )
    diagnostics = {
        field: {"allowlisted_rows": 3, "status": "null", "next_year": False}
        for field in financial_forecasts.FORECAST_FIELDS
    }
    rows = financial_forecasts.build_rows(
        undetermined, diagnostics, doc_id=DOC_6532, raw_sha256=SHA_6532
    )
    assert len(rows) == 1
    row = _as_dict(rows[0])
    assert row["forecast_net_sales"] is None
    assert row["forecast_eps"] is None
    assert row["target_period_end"] is None
    assert row["forecast_scope"] == "unknown"


def test_build_rows_conflicting_targets_stay_unknown():
    """対象期末が複数に分かれたら推測せず NULL にする。"""
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, _ = _record_6532(disc)
    diagnostics = {
        "forecast_net_sales": {
            "allowlisted_rows": 1,
            "status": "value",
            "next_year": False,
            "period_ends": ["2027-02-28"],
        },
        "forecast_eps": {
            "allowlisted_rows": 1,
            "status": "value",
            "next_year": False,
            "period_ends": ["2028-02-29"],
        },
    }
    rows = financial_forecasts.build_rows(
        record, diagnostics, doc_id=DOC_6532, raw_sha256=SHA_6532
    )
    assert len(rows) == 1
    assert _as_dict(rows[0])["target_period_end"] is None


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


def _sqlite_with_forecasts() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for stmt in SCHEMA_STATEMENTS:
        if "jss_financial_forecasts" in stmt:
            conn.execute(stmt)
    return conn


def test_write_is_idempotent_and_older_fetch_does_not_overwrite():
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, diagnostics = _record_6532(disc)
    rows = financial_forecasts.build_rows(
        record, diagnostics, doc_id=DOC_6532, raw_sha256=SHA_6532
    )
    conn = _sqlite_with_forecasts()
    store = _SqliteStore(conn)

    assert financial_forecasts.write(store, rows) == 1
    assert financial_forecasts.write(store, rows) == 1
    n = conn.execute("SELECT COUNT(*) FROM jss_financial_forecasts").fetchone()[0]
    assert n == 1

    # 古い fetched_at の再処理が新しい抽出結果を巻き戻さない。
    stale = [list(rows[0])]
    stale[0][financial_forecasts.COLUMNS.index("forecast_eps")] = -1.0
    stale[0][financial_forecasts.COLUMNS.index("fetched_at")] = (
        int(disc.timestamp()) - 3600
    )
    financial_forecasts.write(store, stale)
    got = conn.execute(
        "SELECT forecast_eps FROM jss_financial_forecasts"
    ).fetchone()[0]
    assert got == pytest.approx(323.79)


def test_build_rows_requires_doc_id():
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, diagnostics = _record_6532(disc)
    with pytest.raises(Exception, match="doc_id"):
        financial_forecasts.build_rows(
            record, diagnostics, doc_id=None, raw_sha256=SHA_6532
        )


def test_edinet_overwrite_of_financials_leaves_forecast_row_intact():
    """#648 の回帰: EDINET の同 PK 上書きで ③の予想列は消えるが、
    別表の予想行は残る。"""
    disc = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    record, diagnostics = _record_6532(disc)
    store = SqliteD1(
        ddl=(
            *SCHEMA_STATEMENTS,
            "CREATE TABLE core_stocks (id INTEGER PRIMARY KEY, code TEXT NOT NULL)",
        ),
        seed=(("INSERT INTO core_stocks (id, code) VALUES (65, '6532')", ()),),
    )

    # TDnet 開示: ③と予想別表の両方へ入る。
    _write_financials(store, record, doc_id=DOC_6532, raw_sha256=SHA_6532)
    rows = financial_forecasts.build_rows(
        record, diagnostics, doc_id=DOC_6532, raw_sha256=SHA_6532
    )
    assert financial_forecasts.write(store, rows) == 1

    # 後から来た EDINET 開示が ③の同 PK を完全上書きする (予想列は NULL)。
    later = disc + timedelta(days=1)
    edinet = replace(
        record,
        provenance=Provenance(
            source=Source.EDINET,
            license_tag=LicenseTag.COMMERCIAL_OK,
            data_date=later.date(),
            fetched_at=later,
        ),
        disclosed_at=later,
        forecast_net_sales=None,
        forecast_operating_income=None,
        forecast_ordinary_income=None,
        forecast_net_income=None,
        forecast_eps=None,
        dps_forecast=None,
    )
    _write_financials(store, edinet, doc_id="S100ZZZZ", raw_sha256="b" * 64)

    # ③の予想列は消えている (この危険が別表化の理由。そのものは残る)。
    fin = store.query(
        "SELECT forecast_eps FROM jss_financials WHERE code = '6532'"
    )
    assert len(fin) == 1
    assert fin[0]["forecast_eps"] is None

    # 別表の予想は元のまま残る。
    fc = store.query(
        "SELECT forecast_eps, forecast_net_sales, target_period_end, license_tag"
        " FROM jss_financial_forecasts WHERE code = '6532'"
    )
    assert len(fc) == 1
    assert fc[0]["forecast_eps"] == pytest.approx(323.79)
    assert fc[0]["forecast_net_sales"] == pytest.approx(190_000_000_000.0)
    assert fc[0]["target_period_end"] == "2027-02-28"
    assert fc[0]["license_tag"] == "factual-cite"
    # 別表の writer は TDnet のみ。F (financials) は表を持たない。
    assert F.TABLE == "jss_financials"
