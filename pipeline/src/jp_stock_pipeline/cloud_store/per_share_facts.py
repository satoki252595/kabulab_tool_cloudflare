"""1株当たり指標の出典 fact `jss_per_share_facts` への書込 (#651)。

③財務サマリ `jss_financials` は最新開示への完全置換で、値の出典
(どの書類の・どの要素・どの文脈から採ったか) が残らない。EPS/BPS/DPS は
株式分割・連結/単体の取り違えで意味が変わるため、採用した fact の来歴を
書類単位で別表に残す。`jss_financials` 自体は変えない (最新断面のまま)。

## Phase 1 の範囲

- normalize が既に生成している diagnostic (採用要素・文脈・区分・理由) を
  そのまま永続化する。新しい抽出ロジックは足さない。
- `split_basis` は一次根拠 (有報注記等) を資格化できるまで常に `unknown`。
  分割イベントの存在だけで「調整済み」と断定しない (§3-1)。
- 整合性チェック (自己資本÷株数等) は Phase 2。Phase 1 の
  `check_status` は全行 `not_checkable` で、未実施を合格と偽らない。
- 書くのは新規書類のみ。過去分のバックフィルは原本が辿れる範囲に
  限って別途行い、辿れない行は fact を作らない (補完しない)。

## コスト

外部取得は増えない (既存 tidy の diagnostic を使う)。行数は
1書類あたり最大5指標で、D1 の収容条件 (年10万行以下) の範囲。
鮮度走査・孤児検査の対象には Phase 1 では入れていないため、
日次の全表走査も増えない。
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

TABLE = "jss_per_share_facts"

COLUMNS: tuple[str, ...] = (
    "code",
    "fiscal_period_end",
    "disclosure_type",
    "consolidated",
    "metric",
    "doc_id",
    "value",
    "element",
    "element_scope",
    "context_refs",
    "source_context_kind",
    "split_basis",
    "check_status",
    "check_reason",
    "diagnostic_status",
    "diagnostic_reason",
    "disclosed_at",
    "raw_sha256",
    "source",
    "license_tag",
    "fetched_at",
)

PK: tuple[str, ...] = (
    "code",
    "fiscal_period_end",
    "disclosure_type",
    "consolidated",
    "metric",
    "doc_id",
)

# FinancialSummaryRecord の属性名 = diagnostics のキー = metric 名。
METRICS: tuple[str, ...] = ("eps", "bps", "dps_actual", "dps_forecast", "forecast_eps")

LICENSE_COLUMN = "license_tag"
GUARD_COLUMN = "fetched_at"

OVERWRITE_COLUMNS: tuple[str, ...] = tuple(
    c for c in COLUMNS if c not in PK and c != LICENSE_COLUMN
)


def build_upsert_sql(row_count: int) -> str:
    """`row_count` 行ぶんの INSERT ... ON CONFLICT DO UPDATE を組み立てる。

    同一書類の再処理は冪等に上書きする。ただし古い取得時刻の再処理が
    新しい抽出結果を巻き戻さないよう `fetched_at` ガードを付ける。
    訂正開示は doc_id が変わるため別行として残る。
    """
    if row_count <= 0:
        raise D1Error("per_share_facts: 0 行の upsert は組み立てない")
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


def _element_scope(diag: dict) -> str:
    """採用factの連結区分。診断に無ければ断定せず「不明」。"""
    scope = diag.get("consolidated")
    return scope if scope in ("連結", "単体") else UNKNOWN_CONSOLIDATED


def build_rows(
    record: FinancialSummaryRecord,
    diagnostics: dict[str, dict],
    *,
    doc_id: str | None,
    raw_sha256: str | None,
) -> list[list[Any]]:
    """財務サマリ1レコードと抽出診断から fact 行を作る (純関数)。

    行を作るのは「値がある」か「候補要素が選ばれた形跡 (nil・多値hold
    含む) がある」指標だけ。候補自体が無い指標は fact の不在で表す。
    doc_id が無い場合は書類を特定できないため例外にする (キーを捏造しない)。
    """
    if not doc_id:
        raise D1Error("per_share_facts: doc_id が無い fact は書かない")
    if not record.code or record.fiscal_period_end is None:
        raise D1Error(
            f"per_share_facts: 主キー要素が欠ける"
            f" (code={record.code!r}, fiscal_period_end={record.fiscal_period_end!r})"
        )
    prov = record.provenance
    fetched_at = _epoch(prov.fetched_at)
    if fetched_at is None:
        raise D1Error("per_share_facts: fetched_at が無い fact は書かない")
    consolidated = record.consolidated or UNKNOWN_CONSOLIDATED
    disclosed_at = _epoch(record.disclosed_at)

    rows: list[list[Any]] = []
    for metric in METRICS:
        value = getattr(record, metric)
        diag = diagnostics.get(metric) or {}
        element = diag.get("element")
        if value is None and not element:
            continue
        refs = diag.get("context_refs") or []
        row: dict[str, Any] = {
            "code": record.code,
            "fiscal_period_end": record.fiscal_period_end.isoformat(),
            "disclosure_type": record.disclosure_type or "",
            "consolidated": consolidated,
            "metric": metric,
            "doc_id": doc_id,
            "value": value,
            "element": element,
            "element_scope": _element_scope(diag),
            "context_refs": "|".join(str(r) for r in refs) or None,
            # normalize は提出書類の当期文脈だけを採用する。後年書類の
            # Prior 文脈を取り始める段で prior_restated を足す。
            "source_context_kind": "current",
            # 一次根拠を資格化できるまで断定しない。
            "split_basis": "unknown",
            # Phase 1 はチェック未実施。合格とは書かない。
            "check_status": "not_checkable",
            "check_reason": None,
            "diagnostic_status": diag.get("status"),
            "diagnostic_reason": diag.get("reason"),
            "disclosed_at": disclosed_at,
            "raw_sha256": raw_sha256,
            "source": prov.source.value,
            "license_tag": prov.license_tag.value,
            "fetched_at": fetched_at,
        }
        rows.append([row[c] for c in COLUMNS])
    return rows


def write(store: D1Store, rows: list[list[Any]]) -> int:
    """fact 行をチャンクして書く。返り値は投げた行数。"""
    if not rows:
        return 0
    for i, row in enumerate(rows):
        if len(row) != len(COLUMNS):
            raise D1Error(
                f"per_share_facts: {i} 行目の列数が {len(row)} (期待 {len(COLUMNS)})"
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
    "METRICS",
    "PK",
    "TABLE",
    "build_rows",
    "build_upsert_sql",
    "write",
]
