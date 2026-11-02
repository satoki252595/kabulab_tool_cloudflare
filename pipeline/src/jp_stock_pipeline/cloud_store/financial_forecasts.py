"""会社業績予想の開示単位レコード `jss_financial_forecasts` への書込 (#652)。

会社予想は TDnet 短信にしか無いのに、③財務サマリ `jss_financials` は
TDnet / EDINET 共通の最新断面で、EDINET の同 PK 完全上書きが予想列を
NULL で消してしまう (#648)。行内 COALESCE で残す案は、行に 1 つしか無い
license_tag のため TDnet (factual-cite) の予想が EDINET (commercial-ok)
の行に紛れて出所とライセンスの両方を偽る。そこで予想だけを TDnet 単独
writer の別表にし、開示 1 件 = 1 行で保持する。

## 保持と取得の原則

- 1 行は 1 開示が述べた予想そのもの。列ごとの最新値合成はしない。
  「予想未定」(要素はあるが nil) の開示も NULL のまま 1 行残し、
  古い予想へのフォールバックで未定を隠さない (§3-1)。
- 予想の対象期末は tidy の文脈 (period_end) から読めた場合だけ入れる。
  複数候補や欠損では NULL にし、+12 か月のような導出はしない。
- writer は tdnet_hourly のみ。edinet_daily はここを一切触らない。
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any

from ..licensing import stricter_tag_sql
from .d1 import D1Error
from .financials import UNKNOWN_CONSOLIDATED

if TYPE_CHECKING:
    from ..models import FinancialSummaryRecord
    from .d1 import D1Store

logger = logging.getLogger(__name__)

TABLE = "jss_financial_forecasts"

COLUMNS: tuple[str, ...] = (
    "code",
    "doc_id",
    "target_period_end",
    "forecast_scope",
    "consolidated",
    "forecast_net_sales",
    "forecast_operating_income",
    "forecast_ordinary_income",
    "forecast_net_income",
    "forecast_eps",
    "dps_forecast",
    "dps_target_period_end",
    "source_period_end",
    "source_disclosure_type",
    "disclosed_at",
    "raw_sha256",
    "source",
    "license_tag",
    "fetched_at",
)

PK: tuple[str, ...] = ("code", "doc_id")

# 損益系の通期予想 (normalize の diagnostics キー = 属性名)。
FLOW_FIELDS: tuple[str, ...] = (
    "forecast_net_sales",
    "forecast_operating_income",
    "forecast_ordinary_income",
    "forecast_net_income",
    "forecast_eps",
)
DPS_FIELD = "dps_forecast"
FORECAST_FIELDS: tuple[str, ...] = FLOW_FIELDS + (DPS_FIELD,)

LICENSE_COLUMN = "license_tag"
GUARD_COLUMN = "fetched_at"

OVERWRITE_COLUMNS: tuple[str, ...] = tuple(
    c for c in COLUMNS if c not in PK and c != LICENSE_COLUMN
)


def build_upsert_sql(row_count: int) -> str:
    """`row_count` 行ぶんの INSERT ... ON CONFLICT DO UPDATE を組み立てる。

    同一書類の再処理は冪等に上書きする。ただし古い取得時刻の再処理が
    新しい抽出結果を巻き戻さないよう `fetched_at` ガードを付ける。
    """
    if row_count <= 0:
        raise D1Error("financial_forecasts: 0 行の upsert は組み立てない")
    placeholders = "(" + ", ".join("?" for _ in COLUMNS) + ")"
    assignments = [f"{c} = excluded.{c}" for c in OVERWRITE_COLUMNS]
    assignments.append(
        f"{LICENSE_COLUMN} = "
        + stricter_tag_sql(f"excluded.{LICENSE_COLUMN}", f"{TABLE}.{LICENSE_COLUMN}")
    )
    return (
        f"INSERT INTO {TABLE} ({', '.join(COLUMNS)})"
        f" VALUES {', '.join(placeholders for _ in range(row_count))}"
        f" ON CONFLICT ({', '.join(PK)}) DO UPDATE SET"
        f" {', '.join(assignments)}"
        f" WHERE excluded.{GUARD_COLUMN} >= {TABLE}.{GUARD_COLUMN}"
    )


def _epoch(value: datetime | None) -> int | None:
    return int(value.timestamp()) if value is not None else None


def _single_period(diags: list[dict], keys: tuple[str, ...]) -> str | None:
    """採用行の期間がちょうど 1 つに定まるときだけ返す。推測で補わない。"""
    periods: set[str] = set()
    for diag in diags:
        for key in keys:
            periods.update(str(p) for p in (diag.get(key) or []) if p)
    if len(periods) == 1:
        return periods.pop()
    if len(periods) > 1:
        logger.warning("予想の対象期末が複数に分かれるため NULL にする: %s", sorted(periods))
    return None


def _forecast_scope(diags: list[dict]) -> str:
    """採用した予想が当期分か来期分か。混在・不明は断定しない。"""
    flags = [bool(d.get("next_year")) for d in diags if d.get("status") == "value"]
    if flags and all(flags):
        return "next_year"
    if flags and not any(flags):
        return "current_year"
    return "unknown"


def build_rows(
    record: FinancialSummaryRecord,
    diagnostics: dict[str, dict],
    *,
    doc_id: str | None,
    raw_sha256: str | None,
) -> list[list[Any]]:
    """財務サマリ 1 レコードと抽出診断から予想行 (0 または 1 行) を作る。

    予想要素が書類に 1 つも無い場合は行を作らない (予想の不在は
    行の不在で表す)。要素はあるが nil 等で値が無い場合は、会社が
    「予想を述べなかった」開示として NULL のまま行を残す。
    doc_id が無い場合は開示を特定できないため例外にする。
    """
    if not doc_id:
        raise D1Error("financial_forecasts: doc_id が無い予想行は書かない")
    if not record.code or record.fiscal_period_end is None:
        raise D1Error(
            f"financial_forecasts: 主キー要素が欠ける"
            f" (code={record.code!r}, fiscal_period_end={record.fiscal_period_end!r})"
        )
    prov = record.provenance
    fetched_at = _epoch(prov.fetched_at)
    if fetched_at is None:
        raise D1Error("financial_forecasts: fetched_at が無い予想行は書かない")

    diags = {field: diagnostics.get(field) or {} for field in FORECAST_FIELDS}
    if not any((d.get("allowlisted_rows") or 0) > 0 for d in diags.values()):
        return []

    flow_diags = [diags[f] for f in FLOW_FIELDS]
    row: dict[str, Any] = {
        "code": record.code,
        "doc_id": doc_id,
        # 対象期末は損益系の文脈から単一に定まるときだけ。
        "target_period_end": _single_period(flow_diags, ("period_ends",)),
        "forecast_scope": _forecast_scope(list(diags.values())),
        "consolidated": record.consolidated or UNKNOWN_CONSOLIDATED,
        "forecast_net_sales": record.forecast_net_sales,
        "forecast_operating_income": record.forecast_operating_income,
        "forecast_ordinary_income": record.forecast_ordinary_income,
        "forecast_net_income": record.forecast_net_income,
        "forecast_eps": record.forecast_eps,
        "dps_forecast": record.dps_forecast,
        # 配当予想の対象期は損益系と別文脈のため列を分ける (混ぜない)。
        "dps_target_period_end": _single_period(
            [diags[DPS_FIELD]], ("period_ends", "instant_dates")
        ),
        "source_period_end": record.fiscal_period_end.isoformat(),
        "source_disclosure_type": record.disclosure_type or "",
        "disclosed_at": _epoch(record.disclosed_at),
        "raw_sha256": raw_sha256,
        "source": prov.source.value,
        "license_tag": prov.license_tag.value,
        "fetched_at": fetched_at,
    }
    return [[row[c] for c in COLUMNS]]


def write(store: D1Store, rows: list[list[Any]]) -> int:
    """予想行をチャンクして書く。返り値は投げた行数。"""
    if not rows:
        return 0
    for i, row in enumerate(rows):
        if len(row) != len(COLUMNS):
            raise D1Error(
                f"financial_forecasts: {i} 行目の列数が {len(row)} (期待 {len(COLUMNS)})"
            )
    written = 0
    per_request = store.rows_per_request(len(COLUMNS))
    for start in range(0, len(rows), per_request):
        chunk = rows[start : start + per_request]
        params = [value for row in chunk for value in row]
        store.query(build_upsert_sql(len(chunk)), params)
        written += len(chunk)
    return written


__all__ = [
    "COLUMNS",
    "FORECAST_FIELDS",
    "PK",
    "TABLE",
    "build_rows",
    "build_upsert_sql",
    "write",
]
