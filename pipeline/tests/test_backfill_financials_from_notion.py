"""Notion ③共有コンバータの検証 (_page は reparse テストも使う)。"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from backfill_financials_from_notion import notion_financial  # noqa: E402
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
