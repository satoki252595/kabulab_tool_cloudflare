"""refetch_plan: ops_check が検知した欠測のうち、既存の手動 dispatch 入口で
安全に埋め直せる分だけを「再取得計画」として組み立てる（純粋関数）。

背景（2026-11-24 の ops_check 実測）: 検知は毎日できているのに、対処は
SLO 違反 Issue へのコメント蓄積だけで、欠測が翌日以降も残り続けていた
（VWAP 保存日足 4 銘柄が 2 取引日以上遅れ・最古書込 2026-11-17、
適時開示 PDF の Notion 未保管 3 件など）。いずれも既存 workflow の
手動入口（`vwap-ingest.yml` の `target=daily` + `daily_codes`、
`backfill.yml` の `job=ir` + 月範囲）で対象を絞って再実行できる。

境界（守らないと自動化が事故になる）:
- ここは計画を返すだけ。dispatch は ops_check.yml のシェルが行う。
- 対象は「再実行が冪等で、対象を銘柄・月へ絞れる」欠測だけ。HOLD・
  結果不明（unknown）・コード起因の失敗・全量再実行が要る欠測は
  計画に入れない（Issue で人が見る。docs/deterministic-production.md）。
- 件数の上限を超えたら計画に入れない。全母集団規模の欠測は個別の
  取りこぼしではなく系統障害なので、自動再実行で誤魔化さず人が見る。
- 上限で外したことも黙らない: 呼び出し側が理由をログに残す。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from ..models import JST

# VWAP 日足の銘柄絞り再取得の上限。実測の欠測は 4〜19 銘柄規模。
# これを超える欠測は当夜 run 自体の系統障害とみなし、自動で叩かない。
MAX_VWAP_DAILY_CODES = 50

# IR PDF 未保管の自動 backfill 上限。ops_check の sample 上限（30）と
# 保持窓（40 日 = 月範囲は最大 3 か月）に合わせる。
MAX_IR_PDF_GAPS = 30
MAX_IR_PDF_MONTH_SPAN = 3


@dataclass(frozen=True)
class RefetchRequest:
    """1 件の workflow_dispatch 要求。inputs は `gh workflow run -f` に渡す。"""

    kind: str
    workflow: str
    inputs: dict[str, str]
    reason: str


def vwap_daily_request(
    stale_codes: list[str], *, expected_date: str
) -> RefetchRequest | None:
    """2 取引日以上遅れ・欠落の銘柄だけを日足再取得する計画。

    `vwap-ingest.yml` の手動 `target=daily` は `daily_codes` で対象を
    絞れる既存入口。空・上限超過・不正コードがあれば None（叩かない）。
    """
    codes = sorted(set(stale_codes))
    if not codes or len(codes) > MAX_VWAP_DAILY_CODES:
        return None
    if any(not code or "," in code or any(ch.isspace() for ch in code) for code in codes):
        return None
    return RefetchRequest(
        kind="vwap_daily",
        workflow="vwap-ingest.yml",
        inputs={"target": "daily", "daily_codes": ",".join(codes)},
        reason=(
            f"VWAP保存日足: 期待取引日 {expected_date} に対し"
            f"2取引日以上遅れ・欠落 {len(codes)} 銘柄"
        ),
    )


def _month_of(epoch_seconds: int) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=UTC).astimezone(JST).strftime("%Y-%m")


def _month_span(first: str, last: str) -> int:
    y1, m1 = (int(part) for part in first.split("-"))
    y2, m2 = (int(part) for part in last.split("-"))
    return (y2 - y1) * 12 + (m2 - m1) + 1


def ir_pdf_request(
    *, gap_count: int, oldest_epoch: int, newest_epoch: int
) -> RefetchRequest | None:
    """Notion 未保管の適時開示 PDF を月範囲で backfill する計画。

    `backfill.yml` の `job=ir` は `--from/--to`（YYYY-MM）で冪等に
    埋め直す既存入口。件数・月範囲が上限を超えたら None。
    """
    if gap_count <= 0 or gap_count > MAX_IR_PDF_GAPS:
        return None
    if oldest_epoch <= 0 or newest_epoch < oldest_epoch:
        return None
    first, last = _month_of(oldest_epoch), _month_of(newest_epoch)
    if _month_span(first, last) > MAX_IR_PDF_MONTH_SPAN:
        return None
    return RefetchRequest(
        kind="ir_pdf",
        workflow="backfill.yml",
        inputs={"job": "ir", "from": first, "to": last},
        reason=f"適時開示 PDF の Notion 未保管 {gap_count} 件 ({first}〜{last})",
    )


def write_plan(path: str, requests: list[RefetchRequest]) -> None:
    """計画を JSON で書く。ops_check.yml の dispatch ステップが読む。"""
    payload = {"requests": [asdict(request) for request in requests]}
    Path(path).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
