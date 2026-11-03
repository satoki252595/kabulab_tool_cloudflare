"""事業タグ×週の「買いの勢い」を集計して JSON に出す (moneyflow レポート用)。

- タグ: Notion「銘柄マスタ（補足）」の統合列「事業タグ」(2026-11-03 に
  旧3列から1列化)。状態が「判定済」の行だけ。
- 売買代金: D1 swing_daily_ohlcv の close×volume。前日比の上下分けは
  moneyflow-sector.ts と同じ定義 (前日終値より上=up / 下=down、同値は両方なし)。
- 1銘柄が複数タグを持つ場合は各タグへ重複計上する (タグ単位のコホート指標)。
- 出力: TOOL/mf-biztag-heatmap.json (mf-report.mts / mf-biztag-report.mts が読む)。読み取りのみ。
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline" / "src"))

from jp_stock_pipeline.cloud_store.d1 import D1Store
from jp_stock_pipeline.config import load_settings

DB_ID = "3e6d74ff84cd8119a15ec61865c436a1"  # 銘柄マスタ（補足）
TAG_COLUMN = "事業タグ"
DIVISIONS_PATH = Path(__file__).with_name("mf-vocab-divisions.json")
DIVISION_LABELS = {
    "upstream": "川上（素材・部品・装置）",
    "downstream": "川下（製品・サービス）",
    "distribution": "流通・サービス",
}
# 日足の全銘柄同期が揃い、上下分類できる売買代金が99%を超える最初の週から。
# W25 は残存バーが40銘柄分のみ、W26 も分類可能82.8% のため表示対象外 (実測)。
FROM_DATE = date(2026, 6, 29)   # 2026-W27 の月曜
TO_DATE = date(2026, 10, 30)    # 2026-W44 の金曜 (保管日足の最新)
OUT = Path(__file__).with_name("mf-biztag-heatmap.json")


def notion_query_all(token: str) -> list[dict]:
    pages: list[dict] = []
    cursor = None
    while True:
        body: dict = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        req = urllib.request.Request(
            f"https://api.notion.com/v1/databases/{DB_ID}/query",
            data=json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        pages.extend(data["results"])
        if not data.get("has_more"):
            return pages
        cursor = data["next_cursor"]
        time.sleep(0.35)  # Notion 3 req/s 目安


def plain(prop: dict | None) -> str:
    if not prop:
        return ""
    return "".join(p.get("plain_text", "") for p in prop.get("rich_text", []))


def load_tags(token: str) -> tuple[dict[str, list[str]], dict, set[str]]:
    pages = notion_query_all(token)
    code_to_tags: dict[str, list[str]] = {}
    judged_codes: set[str] = set()
    status_counts: dict[str, int] = {}
    for page in pages:
        props = page.get("properties", {})
        state = (props.get("事業タグの状態", {}).get("select") or {}).get("name") or "(未設定)"
        status_counts[state] = status_counts.get(state, 0) + 1
        if state != "判定済":
            continue
        code = plain(props.get("銘柄コード")).strip()
        if not code:
            continue
        judged_codes.add(code)
        tags: list[str] = []
        for opt in props.get(TAG_COLUMN, {}).get("multi_select", []) or []:
            name = opt.get("name")
            if name:
                tags.append(name)
        if tags:
            code_to_tags[code] = tags
    meta = {
        "db_rows": len(pages),
        "judged_rows": len(judged_codes),
        "tagged_stocks": len(code_to_tags),
        "status_counts": status_counts,
    }
    return code_to_tags, meta, judged_codes


def load_weekly_bars(store: D1Store) -> list[dict]:
    extended_from = (FROM_DATE - timedelta(days=7)).isoformat()
    sql = (
        "WITH bars AS ("
        " SELECT o.stock_id AS sid, s.code AS code, o.date AS d, o.close AS close,"
        " o.volume AS volume,"
        " LAG(o.close) OVER (PARTITION BY o.stock_id ORDER BY o.date) AS pc"
        " FROM swing_daily_ohlcv o JOIN core_stocks s ON s.id = o.stock_id"
        " WHERE o.date BETWEEN ? AND ? AND s.is_active = 1"
        " AND s.instrument_type = 'equity' AND o.close IS NOT NULL"
        " AND o.stock_id BETWEEN ? AND ?"
        ")"
        " SELECT code,"
        " date(d, '-' || ((CAST(strftime('%w', d) AS INTEGER) + 6) % 7) || ' days') AS monday,"
        " SUM(CASE WHEN pc IS NOT NULL AND close > pc THEN close * volume END) AS up,"
        " SUM(CASE WHEN pc IS NOT NULL AND close < pc THEN close * volume END) AS down,"
        " SUM(close * volume) AS total"
        " FROM bars WHERE d >= ? GROUP BY code, monday"
    )
    bounds = store.query("SELECT MIN(id) AS lo, MAX(id) AS hi FROM core_stocks")[0]
    rows: list[dict] = []
    lo, hi = int(bounds["lo"]), int(bounds["hi"])
    for start in range(lo, hi + 1, 400):
        rows.extend(store.query(
            sql,
            [extended_from, TO_DATE.isoformat(), start, start + 399, FROM_DATE.isoformat()],
        ))
    return rows


def main() -> int:
    token = os.environ.get("NOTION_TOKEN") or ""
    if not token:
        raise SystemExit("NOTION_TOKEN が無い (.env を読み込んでから実行)")
    settings = load_settings()
    store = D1Store(settings.cloud_store, writer="mf-biztag-precompute")

    code_to_tags, tag_meta, judged_codes = load_tags(token)
    print(f"tags: {tag_meta}", file=sys.stderr)
    bars = load_weekly_bars(store)
    print(f"weekly bar rows: {len(bars)}", file=sys.stderr)

    # 週ラベル (ISO) を月曜から作る
    periods: list[str] = []
    monday = FROM_DATE
    while monday <= TO_DATE:
        iso = monday.isocalendar()
        periods.append(f"{iso.year}-W{iso.week:02d}")
        monday += timedelta(days=7)

    # tag -> period index -> [up, down, total], tag -> 股票集合
    agg: dict[str, dict[int, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0]))
    tag_stocks: dict[str, set[str]] = defaultdict(set)
    for code, tags in code_to_tags.items():
        for tag in tags:
            tag_stocks[tag].add(code)
    # カバレッジ検証用: 市場全体 / タグ付き銘柄(重複なし) / 判定済み無タグ銘柄
    market_week = [0.0] * len(periods)
    tagged_unique_week = [0.0] * len(periods)
    judged_untagged_week = [0.0] * len(periods)
    for row in bars:
        monday = date.fromisoformat(str(row["monday"]))
        idx = (monday - FROM_DATE).days // 7
        if idx < 0 or idx >= len(periods):
            continue
        tot = row["total"] or 0
        market_week[idx] += tot
        tags = code_to_tags.get(row["code"])
        if tags:
            tagged_unique_week[idx] += tot
        elif row["code"] in judged_codes:
            judged_untagged_week[idx] += tot
        if not tags:
            continue
        for tag in tags:
            cell = agg[tag][idx]
            cell[0] += row["up"] or 0
            cell[1] += row["down"] or 0
            cell[2] += row["total"] or 0

    # 単語帳の区分 (notionColumn)。mf-dump-divisions.mts で台帳の現行版から取得。
    if not DIVISIONS_PATH.exists():
        raise SystemExit("mf-vocab-divisions.json が無い (TOOL/mf-dump-divisions.mts を実行。手順は TOOL/README.md)")
    divisions_doc = json.loads(DIVISIONS_PATH.read_text())
    label_division: dict[str, str] = divisions_doc["divisions"]
    unmapped = sorted(tag for tag in agg if tag not in label_division)
    if unmapped:
        print(f"WARN unmapped tags: {unmapped}", file=sys.stderr)

    # 週ごとの全タグ売買代金合計 (重複計上ベース。シェアの分母)
    week_total = [0.0] * len(periods)
    for per in agg.values():
        for i, c in per.items():
            week_total[i] += c[2]

    out_rows = []
    for tag, per in agg.items():
        total = sum(c[2] for c in per.values())
        if total <= 0:
            continue
        cells = []
        share_cells = []
        turnover_cells = []
        for i in range(len(periods)):
            up, down, tot = per.get(i, [0.0, 0.0, 0.0])
            cells.append(round(up / (up + down), 4) if up + down > 0 else None)
            share_cells.append(round(tot / week_total[i], 5) if week_total[i] > 0 else None)
            turnover_cells.append(round(tot))
        out_rows.append({
            "tag": tag,
            "stocks": len(tag_stocks[tag]),
            "division": label_division.get(tag),
            "turnover_total": round(total),
            "cells": cells,
            "share_cells": share_cells,
            "turnover_cells": turnover_cells,
        })
    out_rows.sort(key=lambda r: r["turnover_total"], reverse=True)

    # 区分別 (川上/川下/流通) 集計。タグの単純合計 (重複計上ベースで統一)
    div_agg: dict[str, dict[int, list[float]]] = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0]))
    div_stocks: dict[str, set[str]] = defaultdict(set)
    for tag, per in agg.items():
        div = label_division.get(tag)
        if div is None:
            continue
        div_stocks[div] |= tag_stocks[tag]
        for i, c in per.items():
            cell = div_agg[div][i]
            cell[0] += c[0]
            cell[1] += c[1]
            cell[2] += c[2]
    divisions = []
    for div in ("upstream", "downstream", "distribution"):
        per = div_agg.get(div, {})
        divisions.append({
            "division": div,
            "label": DIVISION_LABELS[div],
            "stocks": len(div_stocks[div]),
            "tags": sum(1 for t in agg if label_division.get(t) == div),
            "turnover_total": round(sum(c[2] for c in per.values())),
            "cells": [
                round(per.get(i, [0.0, 0.0, 0.0])[0] / (per.get(i, [0.0, 0.0, 0.0])[0] + per.get(i, [0.0, 0.0, 0.0])[1]), 4)
                if per.get(i, [0.0, 0.0, 0.0])[0] + per.get(i, [0.0, 0.0, 0.0])[1] > 0 else None
                for i in range(len(periods))
            ],
            "share_cells": [
                round(per.get(i, [0.0, 0.0, 0.0])[2] / week_total[i], 5) if week_total[i] > 0 else None
                for i in range(len(periods))
            ],
        })

    # 資金の出入り: 直近4週 vs その前4週のシェア変化 (3銘柄以上のタグ)
    n = len(periods)
    recent_idx = list(range(n - 4, n))
    prev_idx = list(range(n - 8, n - 4))
    tot_recent = sum(week_total[i] for i in recent_idx)
    tot_prev = sum(week_total[i] for i in prev_idx)
    flow = []
    for tag, per in agg.items():
        if len(tag_stocks[tag]) < 3:
            continue
        t_r = sum(per.get(i, [0.0, 0.0, 0.0])[2] for i in recent_idx)
        t_p = sum(per.get(i, [0.0, 0.0, 0.0])[2] for i in prev_idx)
        if t_r <= 0 or t_p <= 0:
            continue
        up_r = sum(per.get(i, [0.0, 0.0, 0.0])[0] for i in recent_idx)
        dn_r = sum(per.get(i, [0.0, 0.0, 0.0])[1] for i in recent_idx)
        flow.append({
            "tag": tag,
            "stocks": len(tag_stocks[tag]),
            "division": label_division.get(tag),
            "share_recent": round(t_r / tot_recent, 5),
            "share_prev": round(t_p / tot_prev, 5),
            "change_pp": round((t_r / tot_recent - t_p / tot_prev) * 100, 3),
            "recent_upratio": round(up_r / (up_r + dn_r), 4) if up_r + dn_r > 0 else None,
            "turnover_recent": round(t_r),
        })
    flow.sort(key=lambda r: r["change_pp"], reverse=True)
    flow_doc = {
        "recent": [periods[i] for i in recent_idx],
        "prev": [periods[i] for i in prev_idx],
        "inflow": flow[:10],
        "outflow": list(reversed(flow[-10:])),
    }

    # ---- 全タグ検証 (粒度・MECE性・カバレッジの実測) ----
    from collections import Counter
    from itertools import combinations

    assigned = set()
    for tags in code_to_tags.values():
        assigned.update(tags)
    unused_terms = [
        {"tag": label, "division": div}
        for label, div in sorted(label_division.items())
        if label not in assigned
    ]
    counts = [len(tags) for tags in code_to_tags.values()]
    counts_sorted = sorted(counts)
    median = counts_sorted[len(counts_sorted) // 2] if counts_sorted else 0
    hist_counter = Counter(min(c, 6) for c in counts)
    histogram = [
        {"n": ("6+" if k == 6 else str(k)), "stocks": hist_counter.get(k, 0)}
        for k in range(1, 7)
    ]
    pair_counter: Counter = Counter()
    for tags in code_to_tags.values():
        for a, b in combinations(sorted(set(tags)), 2):
            pair_counter[(a, b)] += 1
    cooccurrence = [
        {"pair": [a, b], "stocks": n} for (a, b), n in pair_counter.most_common(10)
    ]
    dup_total = sum(week_total)
    tagged_total = sum(tagged_unique_week)
    period_shares = sorted(
        ((r["turnover_total"] / dup_total) if dup_total > 0 else 0 for r in out_rows),
        reverse=True,
    )
    cum, tags_for_half = 0.0, 0
    for s in period_shares:
        cum += s
        tags_for_half += 1
        if cum >= 0.5:
            break
    audit = {
        "vocab_terms": len(label_division),
        "assigned_terms": len(assigned),
        "unused_terms": unused_terms,
        "judged_untagged_stocks": len(judged_codes) - len(code_to_tags),
        "tags_per_stock": {
            "mean": round(sum(counts) / len(counts), 2) if counts else 0,
            "median": median,
            "max": max(counts) if counts else 0,
            "histogram": histogram,
        },
        "coverage": {
            "market_turnover": round(sum(market_week)),
            "tagged_turnover": round(tagged_total),
            "tagged_share_of_market": round(tagged_total / sum(market_week), 4) if sum(market_week) > 0 else None,
            "judged_untagged_turnover": round(sum(judged_untagged_week)),
            "duplicated_total": round(dup_total),
            "duplication_factor": round(dup_total / tagged_total, 3) if tagged_total > 0 else None,
        },
        "concentration": {
            "top10_share": round(sum(period_shares[:10]), 4),
            "tags_for_half": tags_for_half,
        },
        "cooccurrence_top10": cooccurrence,
    }

    payload = {
        "periods": periods,
        "from": FROM_DATE.isoformat(),
        "to": TO_DATE.isoformat(),
        "meta": {**tag_meta, "vocab_version": divisions_doc["version"], "unmapped_tags": unmapped},
        "tags_total": len(out_rows),
        "rows": out_rows,
        "divisions": divisions,
        "flow": flow_doc,
        "audit": audit,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False))
    print(json.dumps({
        "tags": len(out_rows),
        "top5": [(r["tag"], round(r["turnover_total"] / 1e12, 2), r["stocks"]) for r in out_rows[:5]],
        **tag_meta,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
