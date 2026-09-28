"""Notion ③財務サマリの共有コンバータ (reparse が import する)。

旧 CLI (run/--apply)・月別取得・INSERT 生成・重複解消は撤去済み。
残る notion_financial/_next_month/_bounds を reparse_financials_from_notion
が使う。
"""

from __future__ import annotations

from datetime import date, datetime

from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import DataQuality, FinancialSummaryRecord, Provenance, Source
from jp_stock_pipeline.notion import schema as S
from jp_stock_pipeline.notion.client import NotionClient
from jp_stock_pipeline.notion.upsert import _FIN_FIELD_TO_PROP


def _property(page: dict, name: str, kind: str):
    prop = page["properties"].get(name)
    if not isinstance(prop, dict) or prop.get("type") != kind:
        raise ValueError(f"Notion {page['id']}: {name} の型が {kind} ではありません")
    return prop[kind]


def _text(page: dict, name: str) -> str:
    blocks = _property(page, name, "rich_text")
    value = "".join(part["plain_text"] for part in blocks).strip()
    if not value:
        raise ValueError(f"Notion {page['id']}: {name} が空です")
    return value


def _select(page: dict, name: str, *, required: bool = False) -> str | None:
    value = _property(page, name, "select")
    if value is None:
        if required:
            raise ValueError(f"Notion {page['id']}: {name} が空です")
        return None
    return value["name"]


def _date(page: dict, name: str, *, required: bool = False) -> date | None:
    value = _property(page, name, "date")
    if value is None:
        if required:
            raise ValueError(f"Notion {page['id']}: {name} が空です")
        return None
    return date.fromisoformat(value["start"][:10])


def _datetime(page: dict, name: str, *, required: bool = False) -> datetime | None:
    value = _property(page, name, "date")
    if value is None:
        if required:
            raise ValueError(f"Notion {page['id']}: {name} が空です")
        return None
    parsed = datetime.fromisoformat(value["start"].replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"Notion {page['id']}: {name} の時刻にタイムゾーンがありません")
    return parsed


def notion_financial(page: dict) -> FinancialSummaryRecord:
    """Notion の数値をそのまま円・円/株・%で取り出し、推定値を作らない。"""
    source = Source(_select(page, S.PROP_SOURCE, required=True))
    license_tag = LicenseTag(_select(page, S.PROP_LICENSE_TAG, required=True))
    quality = DataQuality(_select(page, S.PROP_QUALITY, required=True))
    provenance = Provenance(
        source=source,
        license_tag=license_tag,
        data_date=_date(page, S.PROP_DATA_DATE),
        fetched_at=_datetime(page, S.PROP_FETCHED_AT, required=True),
        quality=quality,
    )
    numbers = {field: _property(page, prop, "number") for field, prop in _FIN_FIELD_TO_PROP.items()}
    return FinancialSummaryRecord(
        code=_text(page, S.FIN_PROP_CODE),
        fiscal_period_end=_date(page, S.FIN_PROP_PERIOD_END, required=True),
        disclosure_type=_select(page, S.FIN_PROP_DISCLOSURE_TYPE, required=True),
        consolidated=_select(page, S.FIN_PROP_CONSOLIDATED),
        accounting_standard=_select(page, S.FIN_PROP_STANDARD),
        disclosed_at=_datetime(page, S.FIN_PROP_DISCLOSED_AT),
        provenance=provenance,
        **numbers,
    )


def _next_month(month: date) -> date:
    return date(month.year + (month.month == 12), month.month % 12 + 1, 1)


def _bounds(client: NotionClient, database_id: str) -> tuple[date, date]:
    ends: list[date] = []
    for direction in ("ascending", "descending"):
        pages = client.query_database(
            database_id,
            sorts=[{"property": S.FIN_PROP_PERIOD_END, "direction": direction}],
            page_size=1,
            max_pages=1,
        )
        if not pages:
            raise ValueError("Notion ③財務サマリに行がありません")
        ends.append(_date(pages[0], S.FIN_PROP_PERIOD_END, required=True))
    return date(ends[0].year, ends[0].month, 1), date(ends[1].year, ends[1].month, 1)
