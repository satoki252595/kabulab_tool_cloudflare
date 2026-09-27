"""既存 Notion ③財務サマリを D1 jss_financials に一度だけ補完する。

既定は読み取り検証のみ。--apply は PR の検証・マージ後に実行する。
Notion は 1 クエリ 10,000 件上限なので決算期末の月ごとに全ページを読む。
"""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime

from jp_stock_pipeline.cloud_store.d1 import D1Store
from jp_stock_pipeline.cloud_store.financials import (
    COLUMNS,
    TABLE,
    prefetch_stock_ids,
    record_to_row,
)
from jp_stock_pipeline.cloud_store.schema import FINANCIALS_PK
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import DataQuality, FinancialSummaryRecord, Provenance, Source
from jp_stock_pipeline.notion import schema as S
from jp_stock_pipeline.notion.client import NotionClient
from jp_stock_pipeline.notion.upsert import _FIN_FIELD_TO_PROP

BATCH_SIZE = 100


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


def _month_pages(client: NotionClient, database_id: str, month: date) -> list[dict]:
    following = _next_month(month)
    return client.query_database(
        database_id,
        filter={
            "and": [
                {"property": S.FIN_PROP_PERIOD_END, "date": {"on_or_after": month.isoformat()}},
                {"property": S.FIN_PROP_PERIOD_END, "date": {"before": following.isoformat()}},
            ]
        },
        strict=True,
    )


def _insert_sql() -> str:
    values = ", ".join(f"json_extract(j.value, '$[{index}]')" for index in range(len(COLUMNS)))
    return (
        f"INSERT INTO {TABLE} ({', '.join(COLUMNS)}) "
        f"SELECT {values} FROM json_each(?) AS j WHERE true "
        f"ON CONFLICT ({', '.join(FINANCIALS_PK)}) DO NOTHING"
    )


def _unique_records(pages: list[dict]) -> list[FinancialSummaryRecord]:
    # Notion で同じキーの旧ページが並存しても、最後に編集された方を一意に採る。
    # 同時刻の異なる値は選択不能なので停止する。
    chosen: dict[tuple[str, date, str, str], tuple[str, FinancialSummaryRecord]] = {}
    for page in pages:
        record = notion_financial(page)
        key = (
            record.code,
            record.fiscal_period_end,
            record.disclosure_type,
            record.consolidated or "不明",
        )
        edited = page["last_edited_time"]
        current = chosen.get(key)
        if current is None or edited > current[0]:
            chosen[key] = (edited, record)
        elif edited == current[0] and record != current[1]:
            raise ValueError(f"Notion ③: 同じキーと更新日時で内容が異なります: {key}")
    return [entry[1] for entry in chosen.values()]


def run(*, apply: bool, verify_code: str | None = None) -> None:
    settings = load_settings()
    if not settings.notion_token:
        raise ValueError("NOTION_TOKEN が必要です")
    if apply and not settings.cloud_store.d1_enabled():
        raise ValueError("--apply には CF_ACCOUNT_ID、CF_API_TOKEN、CF_D1_DATABASE_ID が必要です")
    client = NotionClient(settings.notion_token, rps=settings.notion_rps)
    database_id = settings.db_id("financials")
    store = D1Store(settings.cloud_store, writer="financials_notion_backfill") if apply else None
    initial = store.query(f"SELECT COUNT(*) AS n FROM {TABLE}")[0]["n"] if store else None
    stock_ids: dict[str, int | None] = {}
    scanned = unique = target_count = 0
    codes: set[str] = set()
    month, last = _bounds(client, database_id)
    while month <= last:
        pages = _month_pages(client, database_id, month)
        records = _unique_records(pages)
        scanned += len(pages)
        unique += len(records)
        codes.update(r.code for r in records)
        if verify_code:
            target_count += sum(r.code == verify_code for r in records)
        if store:
            prefetch_stock_ids(store, [r.code for r in records], cache=stock_ids)
            sql = _insert_sql()
            for offset in range(0, len(records), BATCH_SIZE):
                batch = records[offset : offset + BATCH_SIZE]
                rows = [
                    record_to_row(r, stock_id=stock_ids[r.code], doc_id=None, raw_sha256=None)
                    for r in batch
                ]
                store.query(
                    sql,
                    [json.dumps(rows, ensure_ascii=False, allow_nan=False, separators=(",", ":"))],
                )
        if pages:
            print(f"{month:%Y-%m}: Notion {len(pages)} 行 / 一意 {len(records)} 行")
        month = _next_month(month)
    if store:
        final = store.query(f"SELECT COUNT(*) AS n FROM {TABLE}")[0]["n"]
        if final < unique:
            raise ValueError(f"D1 {final} 行は Notion の一意キー {unique} 件より少ないです")
        print(f"D1: {initial} → {final} 行。")
        if verify_code:
            target_rows = store.query(
                f"SELECT fiscal_period_end, disclosure_type, consolidated, net_sales, source "
                f"FROM {TABLE} WHERE code = ? ORDER BY fiscal_period_end DESC",
                [verify_code],
            )
            if len(target_rows) < target_count:
                raise ValueError(
                    f"{verify_code}: D1 {len(target_rows)} 行は Notion {target_count} 件より少ないです"
                )
            print(f"{verify_code}: D1 {len(target_rows)} 行 / Notion {target_count} 件")
            for row in target_rows:
                print(row)
    print(
        f"Notion ③: {scanned} 行取得 / {unique} キー / {len(codes)} 銘柄"
        f"。{'反映済み' if apply else '乾式検証のみ'}"
    )
    if verify_code and not store:
        print(f"{verify_code}: Notion {target_count} 件")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="D1 に不足行だけ書き込む")
    parser.add_argument("--verify-code", help="実行後に銘柄の期別行と件数を照合する")
    args = parser.parse_args()
    run(apply=args.apply, verify_code=args.verify_code)
