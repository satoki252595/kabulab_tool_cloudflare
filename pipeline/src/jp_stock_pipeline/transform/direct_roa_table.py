"""保存XBRLの実HTML表だけから当期純利益ROAを読む。flat CSVの列を復元しない。"""

from __future__ import annotations

import math
import re
import unicodedata
from datetime import date

import pandas as pd
from lxml import html

_MDA = "ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock"
_POLICY = "BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock"
_PAY = "RemunerationForDirectorsAndOtherOfficersTextBlock"
_NUM = re.compile(r"[-+△▲]?\d+(?:\.\d+)?%?")


class ROATableConflict(ValueError):
    """同じ当期資格を満たす表の値が衝突した。不在として本文で救済しない。"""


def _plain(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value))


def _block(tidy: pd.DataFrame, local: str) -> str | None:
    rows = tidy[
        tidy.element.eq(f"jpcrp_cor:{local}")
        & tidy.context_ref.eq("FilingDateInstant")
        & tidy.dimensions.isin(("", "{}"))
    ]
    values = set(rows.value)
    return values.pop() if len(values) == 1 else None


def _grid(table) -> list[list[str]] | None:
    """実例の単純横結合だけ。行結合/入れ子/未知幅は推定せず不採用。"""
    if table.xpath(".//table"):
        return None
    rows: list[list[str]] = []
    for tr in table.xpath("./tr|./thead/tr|./tbody/tr"):
        cells: list[str] = []
        for cell in tr.xpath("./th|./td"):
            span = cell.get("colspan", "1")
            if cell.get("rowspan", "1") != "1" or span not in ("1", "2"):
                return None
            cells.extend([_plain("".join(cell.itertext()))] * int(span))
        if not cells or len(cells) > 32:
            return None
        rows.append(cells)
    if not rows or len(rows) > 128 or len({len(r) for r in rows}) != 1:
        return None
    return rows


def _value(cell: str, percent_unit: bool) -> float | None:
    if not _NUM.fullmatch(cell) or (not cell.endswith("%") and not percent_unit):
        return None
    value = float(cell.removesuffix("%").replace("△", "-").replace("▲", "-"))
    return value if math.isfinite(value) else None


def _following_notes(table, limit: int) -> str:
    """直後の注記段落だけ。要素/祖先のtailも文書順に境界検査する。"""
    notes: list[str] = []
    node = table
    descend = False
    while node is not None:
        if descend and len(node):
            node = node[0]
        else:
            # 部分木を読み終えた後、次の兄弟まで祖先を上がる。
            # 空p、comment、wrapperのtailも可視本文なので省略しない。
            while node is not None:
                if _plain(node.tail or ""):
                    return "".join(notes)[:limit]
                sibling = node.getnext()
                if sibling is not None:
                    node = sibling
                    break
                node = node.getparent()
            if node is None:
                break
        descend = False
        if not isinstance(node.tag, str):  # comment本文は非表示。tailは次周で検査。
            continue
        if node.tag in ("table", "h1", "h2", "h3", "h4", "h5", "h6"):
            break
        if node.tag == "p":
            text = _plain("".join(node.itertext()))
            if text:
                if not text.startswith(("(注)", "※", "・")):
                    break
                notes.append(text)
                if sum(map(len, notes)) >= limit:
                    break
        else:
            if _plain(node.text or ""):
                break
            descend = True
    return "".join(notes)[:limit]


def has_roa_table_candidate(tidy: pd.DataFrame) -> bool:
    """type1を追加照会する範囲。CSVの値/列は採用せず定義と見出しだけを見る。"""
    if tidy.empty:
        return False
    dei = {}
    for name in (
        "TypeOfCurrentPeriodDEI",
        "WhetherConsolidatedFinancialStatementsArePreparedDEI",
        "CurrentPeriodEndDateDEI",
        "CurrentFiscalYearEndDateDEI",
    ):
        rows = tidy[tidy.element.eq("jpdei_cor:" + name) & tidy.context_ref.eq("FilingDateInstant")]
        values = set(rows.value)
        if len(values) != 1:
            return False
        dei[name] = values.pop()
    if (
        dei["TypeOfCurrentPeriodDEI"] != "FY"
        or dei["WhetherConsolidatedFinancialStatementsArePreparedDEI"] != "true"
        or dei["CurrentPeriodEndDateDEI"] != dei["CurrentFiscalYearEndDateDEI"]
    ):
        return False
    try:
        date.fromisoformat(dei["CurrentPeriodEndDateDEI"])
    except ValueError:
        return False
    mda = _plain(_block(tidy, _MDA) or "")
    if (
        "決算年月" in mda
        and "各指標は、いずれも連結財務諸表に基づいて算定" in mda
        and "総資産利益率(ROA):親会社株主に帰属する当期純利益/総資産" in mda
    ) or (
        "当連結会計年度" in mda
        and "当期純利益ROA=親会社株主に帰属する当期純利益÷総資産期中平均" in mda
    ):
        return True
    policy = _plain(_block(tidy, _POLICY) or "")
    pay = _plain(_block(tidy, _PAY) or "")
    return (
        "ROEおよびROAの算定においては、親会社株主に帰属する当期純利益を使用" in policy
        and "実績比" in policy
        and "全社業績評価のKPI" in pay
        and "目標および実績は、以下のとおり" in pay
    )


def direct_table_net_profit_roa(tidy: pd.DataFrame, period: date) -> float | None:
    """呼出側のnative FY/期末/連結検証後だけ。年度/実績列の直接値を返す。"""
    values: set[float] = set()
    mda = _block(tidy, _MDA)
    if mda and "<table" in mda.lower():
        tree = html.fromstring(mda)
        for table in tree.xpath("//table"):
            text = _plain("".join(table.itertext()))
            if "ROA" not in text:
                continue
            grid = _grid(table)
            if grid is None:
                continue
            following = _following_notes(table, 600)
            preceding = _plain("".join(table.xpath("preceding::text()")))[-600:]
            column: int | None = None
            label: str | None = None
            if (
                "当社グループが重視している主な経営指標の推移" in preceding
                and "各指標は、いずれも連結財務諸表に基づいて算定" in following
                and "総資産利益率(ROA):親会社株主に帰属する当期純利益/総資産" in following
            ):
                headers = [r for r in grid if r[0] == "決算年月"]
                wanted = f"{period.year}年{period.month}月"
                if len(headers) == 1 and headers[0].count(wanted) == 1:
                    column = headers[0].index(wanted)
                    label = "総資産利益率(ROA)"
            elif (
                "当社グループの財務健全性、収益性及び資本効率を示す指標の推移" in preceding
                and "当期純利益ROA=親会社株主に帰属する当期純利益÷総資産期中平均" in following
                and grid[0].count("当連結会計年度") == 1
            ):
                column = grid[0].index("当連結会計年度")
                label = "当期純利益ROA"
            if column is not None:
                for row in grid[1:]:
                    if row[0] == label:
                        value = _value(row[column], len(row) > 1 and row[1] == "(%)")
                        if value is not None:
                            values.add(value)
    policy, pay = _block(tidy, _POLICY), _block(tidy, _PAY)
    year = f"{period.year}年{period.month}月期"
    if policy and pay and "<table" in policy.lower() and "<table" in pay.lower():
        definition_bound = False
        for table in html.fromstring(policy).xpath("//table"):
            roa_rows = [
                r
                for r in table.xpath(".//tr")
                if re.search(r"ROA(?:※\d+)?", _plain("".join(r.itertext())))
            ]
            if any(year + "実績比" in _plain("".join(r.itertext())) for r in roa_rows):
                after = _following_notes(table, 400)
                definition_bound |= (
                    "ROEおよびROAの算定においては、親会社株主に帰属する当期純利益を使用" in after
                )
        if definition_bound:
            for table in html.fromstring(pay).xpath("//table"):
                before = _plain("".join(table.xpath("preceding::text()")))[-1200:]
                if before.rfind("[賞与]") < 0 or before.rfind("[株式報酬]") > before.rfind(
                    "[賞与]"
                ):
                    continue
                if (
                    year + "における目標および実績は、以下のとおり" not in before
                    or year + "における業務執行取締役に対する賞与の全社業績評価のKPI" not in before
                ):
                    continue
                grid = _grid(table)
                if grid is None or grid[0] != ["KPI", "目標", "実績", "達成率", "評価ウェイト"]:
                    continue
                for row in grid[1:]:
                    if row[0] == "ROA":
                        value = _value(row[2], False)
                        if value is not None:
                            values.add(value)
    if len(values) > 1:
        raise ROATableConflict("当期純利益ROAの適格な実表に複数の値がある")
    return values.pop() if values else None
