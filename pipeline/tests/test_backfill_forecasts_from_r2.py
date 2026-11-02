"""予想バックフィル (scripts/backfill_forecasts_from_r2.py) の純粋部テスト (#652)。

- TDnet 一覧 payload から doc_id -> 開示時刻を作る際の重複・競合の扱い
- doc_id の解決 (索引を正とし、③との食い違いは捏造せず落とす)
- 実短信 zip (6532) から予想行が作れること (取得時刻は呼び出し側が渡した
  原本の first_fetched_at のまま = 再解析時刻を塗らない)
"""

from __future__ import annotations

import hashlib
import sys
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from backfill_forecasts_from_r2 import (  # noqa: E402
    build_disclosure_map,
    forecast_rows_from_zip,
    resolve_doc_id,
)
from conftest import fixture_path  # noqa: E402
from jp_stock_pipeline.cloud_store import financial_forecasts  # noqa: E402

SHA_6532 = "3d010eb3eb80832108df320ab374a1495a7078140a051dfb2090b532bd5f7dd9"
DOC_6532 = "140120261009548418"
JST = timezone(timedelta(hours=9))
FETCHED = datetime(2026, 10, 15, 7, 0, tzinfo=UTC)


def _payload(doc_id: str, pubdate: str, code: str = "65320") -> dict:
    return {
        "items": [
            {
                "Tdnet": {
                    "id": 1287578,
                    "title": "2027年2月期 第2四半期決算短信〔IFRS〕（連結）",
                    "pubdate": pubdate,
                    "company_code": code,
                    "document_url": f"https://example.invalid/{doc_id}.pdf",
                    "url_xbrl": "https://example.invalid/xbrl.zip",
                }
            }
        ]
    }


def test_build_disclosure_map_reads_pubdate_and_code():
    mapping, conflicts, failed = build_disclosure_map(
        [_payload(DOC_6532, "2026-10-15 15:30:00")], fetched_at=FETCHED
    )
    assert failed == 0
    assert conflicts == set()
    disclosed_at, code = mapping[DOC_6532]
    assert disclosed_at == datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    assert code == "6532"


def test_build_disclosure_map_drops_conflicting_doc():
    mapping, conflicts, failed = build_disclosure_map(
        [
            _payload(DOC_6532, "2026-10-15 15:30:00"),
            _payload(DOC_6532, "2026-10-15 16:00:00"),
        ],
        fetched_at=FETCHED,
    )
    assert failed == 0
    assert DOC_6532 in conflicts
    assert DOC_6532 not in mapping


def test_build_disclosure_map_counts_unreadable_payload():
    mapping, conflicts, failed = build_disclosure_map(
        [{"items": "not-a-list"}], fetched_at=FETCHED
    )
    assert mapping == {}
    assert conflicts == set()
    assert failed == 1


def test_resolve_doc_id():
    assert resolve_doc_id("1401", None) == "1401"
    assert resolve_doc_id(None, "1401") == "1401"
    assert resolve_doc_id("1401", "1401") == "1401"
    # 食い違いはどちらとも断定せず None (呼び出し側が失敗として数える)。
    assert resolve_doc_id("1401", "1402") is None
    assert resolve_doc_id(None, None) is None


def test_forecast_rows_from_real_6532_zip():
    content = fixture_path("tdnet/context-unit/6532.zip").read_bytes()
    assert hashlib.sha256(content).hexdigest() == SHA_6532
    disclosed = datetime(2026, 10, 15, 15, 30, tzinfo=JST)
    rows, status = forecast_rows_from_zip(
        content,
        code="6532",
        doc_id=DOC_6532,
        raw_sha256=SHA_6532,
        disclosed_at=disclosed,
        fetched_at=FETCHED,
        data_date=disclosed.date(),
    )
    assert status == "written"
    assert len(rows) == 1
    row = dict(zip(financial_forecasts.COLUMNS, rows[0]))
    assert row["forecast_net_sales"] == 190_000_000_000
    assert row["forecast_eps"] == 323.79
    assert row["dps_forecast"] == 130
    assert row["target_period_end"] == "2027-02-28"
    # 開示時刻・取得時刻は渡した一次値のまま (再解析時刻を塗らない)。
    assert row["disclosed_at"] == int(disclosed.timestamp())
    assert row["fetched_at"] == int(FETCHED.timestamp())
    assert row["license_tag"] == "factual-cite"
