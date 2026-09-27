"""Notion ③からD1への一度きりの移行で、値・範囲・来歴を変えない検証。"""

from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from backfill_financials_from_notion import _insert_sql, notion_financial  # noqa: E402
from jp_stock_pipeline.cloud_store.financials import record_to_row  # noqa: E402
from jp_stock_pipeline.cloud_store.schema import _FINANCIALS  # noqa: E402
from jp_stock_pipeline.notion import schema as S  # noqa: E402
from jp_stock_pipeline.notion.upsert import _FIN_FIELD_TO_PROP  # noqa: E402


def _page() -> dict:
    properties = {name: {"type": "number", "number": None} for name in _FIN_FIELD_TO_PROP.values()}
    properties.update(
        {
            S.FIN_PROP_CODE: {"type": "rich_text", "rich_text": [{"plain_text": "8154"}]},
            S.FIN_PROP_PERIOD_END: {"type": "date", "date": {"start": "2025-03-31"}},
            S.FIN_PROP_DISCLOSURE_TYPE: {"type": "select", "select": {"name": "本決算"}},
            S.FIN_PROP_CONSOLIDATED: {"type": "select", "select": {"name": "連結"}},
            S.FIN_PROP_STANDARD: {"type": "select", "select": {"name": "日本基準"}},
            S.FIN_PROP_NET_SALES: {"type": "number", "number": 547_779_000_000},
            S.PROP_SOURCE: {"type": "select", "select": {"name": "EDINET"}},
            S.PROP_LICENSE_TAG: {"type": "select", "select": {"name": "commercial-ok"}},
            S.PROP_DATA_DATE: {"type": "date", "date": {"start": "2025-06-27"}},
            S.PROP_FETCHED_AT: {"type": "date", "date": {"start": "2025-06-27T18:00:00+09:00"}},
            S.PROP_QUALITY: {"type": "select", "select": {"name": "正常"}},
            S.FIN_PROP_DISCLOSED_AT: {
                "type": "date",
                "date": {"start": "2025-06-27T15:30:00+09:00"},
            },
        }
    )
    return {
        "id": "notion-page-id",
        "last_edited_time": "2025-06-28T00:00:00Z",
        "properties": properties,
    }


def test_notion_row_keeps_yen_scope_source_and_period_type() -> None:
    record = notion_financial(_page())
    assert record.code == "8154"
    assert record.disclosure_type == "本決算"
    assert record.consolidated == "連結"
    assert record.net_sales == 547_779_000_000
    assert record.provenance.source.value == "EDINET"
    assert record.provenance.license_tag.value == "commercial-ok"
    assert record.provenance.data_date.isoformat() == "2025-06-27"
    assert record.disclosed_at.isoformat() == "2025-06-27T15:30:00+09:00"


def test_bulk_insert_preserves_existing_and_separates_consolidation() -> None:
    conn = sqlite3.connect(":memory:")
    conn.execute(_FINANCIALS)
    record = notion_financial(_page())
    standalone = replace(record, consolidated="単体", net_sales=117_513_000_000)
    rows = [
        record_to_row(r, stock_id=None, doc_id=None, raw_sha256=None) for r in (record, standalone)
    ]
    sql = _insert_sql()
    conn.execute(sql, [json.dumps(rows, ensure_ascii=False)])
    changed = replace(record, net_sales=999)
    conn.execute(
        sql,
        [
            json.dumps(
                [record_to_row(changed, stock_id=None, doc_id=None, raw_sha256=None)],
                ensure_ascii=False,
            )
        ],
    )
    result = conn.execute(
        "SELECT consolidated, net_sales, source, license_tag, disclosure_type "
        "FROM jss_financials ORDER BY consolidated"
    ).fetchall()
    assert result == [
        ("単体", 117_513_000_000, "EDINET", "commercial-ok", "本決算"),
        ("連結", 547_779_000_000, "EDINET", "commercial-ok", "本決算"),
    ]
