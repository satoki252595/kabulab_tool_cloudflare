"""有報の当期実績文に直接開示された純利益ROA。表境界や比率を復元・計算しない。"""

from __future__ import annotations

import logging
import math
import re
import unicodedata
from datetime import date

import pandas as pd
from lxml import html

logger = logging.getLogger(__name__)
_BLOCK = "jpcrp_cor:ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock"
_NET_LABEL = (
    r"(?:総資産(?:当期)?純利益率(?:\s*\(ROA\))?|ROA\s*\(総資産(?:当期)?純利益率\)"
    r"|総資本利益率\(当社株主に帰属する当期純利益を前年度末及び当年度末の総資産平均で除した割合\))"
)
_NUMBER = r"[-+△▲]?\d+(?:\.\d+)?"
_LABEL = rf"(?:{_NET_LABEL}|(?<![A-Za-z0-9_ぁ-んァ-ヶ一-龠])ROA(?![A-Za-z0-9_]))"
# 比較文の前期値は捕捉せず、明示された当期の値だけを捕捉する。
_COMPARISON = re.compile(
    rf"{_LABEL}\s*[」』]?\s*(?:は|が)[、,]?\s*前期の\s*{_NUMBER}\s*%\s*から\s*"
    rf"(?P<value>{_NUMBER})\s*%\s*(?:へ|となった|となりました)"
)
_DIRECT = re.compile(
    rf"{_LABEL}\s*[」』]?\s*は[、,]?\s*(?:当連結会計年度では|当事業年度では)?"
    rf"\s*(?P<value>{_NUMBER})\s*%"
)
_INDICATORS = re.compile(rf"{_NET_LABEL}\s*(?P<value>{_NUMBER})\s*%")
_COMPLETED = re.compile(
    r"とな(?:った|りました|っており)|であります|(?:増加|減少|上昇|低下)(?:いたしました|しました)"
)
_GOAL = re.compile(r"目標|予想|計画|見通し|目指|予定|%\s*(?:以上|以下)")


def _dei(tidy: pd.DataFrame, name: str) -> str | None:
    rows = tidy[
        (tidy["element"] == f"jpdei_cor:{name}") & (tidy["context_ref"] == "FilingDateInstant")
    ]
    values = set(rows["value"].str.strip())
    return values.pop() if len(values) == 1 else None


def direct_net_profit_roa(
    tidy: pd.DataFrame,
    fiscal_period_end: date,
    disclosure_type: str,
    consolidated: str | None,
) -> float | None:
    """native DEI・全社主体・実績完了文・純利益定義が揃った百分率だけを返す。

    FilingDateInstant の文章を財務値の期間フィルタで落とさず、年度末/FYをDEIで
    照合する。比較表・目標・セグメント・多値は採用しない。type5/type1共通入口。
    """
    if tidy.empty or disclosure_type != "本決算" or consolidated not in ("連結", "単体"):
        return None
    if _dei(tidy, "TypeOfCurrentPeriodDEI") != "FY":
        return None
    if _dei(tidy, "CurrentPeriodEndDateDEI") != fiscal_period_end.isoformat():
        return None
    native_consolidated = _dei(tidy, "WhetherConsolidatedFinancialStatementsArePreparedDEI")
    if native_consolidated != ("true" if consolidated == "連結" else "false"):
        return None
    from .direct_roa_table import ROATableConflict, direct_table_net_profit_roa  # noqa: PLC0415

    try:
        table_value = (
            direct_table_net_profit_roa(tidy, fiscal_period_end) if consolidated == "連結" else None
        )
    except ROATableConflict:
        logger.warning("当期純利益ROAの実表値が衝突しているため本文で補わずHOLD")
        return None
    blocks = tidy[
        (tidy["element"] == _BLOCK)
        & (tidy["context_ref"] == "FilingDateInstant")
        & tidy["dimensions"].isin(("", "{}"))
    ]
    texts = set(blocks["value"])
    if len(texts) != 1:
        return None
    text = texts.pop()
    if "<" in text:
        # 既存lxmlでタグの境界を空白として保つ。セルの数値を連結しない。
        text = " ".join(html.fromstring(text).itertext())
    text = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text))
    if "総資産経常利益率" in text:
        return None
    if not re.search(_NET_LABEL, text):
        return table_value
    current_scope = "当連結会計年度" if consolidated == "連結" else "当事業年度"
    other_scope = "当事業年度" if consolidated == "連結" else "当連結会計年度"
    values: set[float] = {table_value} if table_value is not None else set()
    for pattern in (_COMPARISON, _DIRECT, _INDICATORS):
        for match in pattern.finditer(text):
            start = text.rfind("。", 0, match.start()) + 1
            end = text.find("。", match.end())
            if end < 0:
                continue  # 完結した実績文のない切り詰め原文は受け入れない。
            sentence = text[start:end]
            if other_scope in match[0]:
                continue
            prefix = text[: match.start()]
            if prefix.rfind(current_scope) < 0 or prefix.rfind(other_scope) > prefix.rfind(
                current_scope
            ):
                continue
            # 最後の明示主体がセグメント/単体なら全社へ転用しない。
            company = max(
                prefix.rfind("当社グループ"),
                prefix.rfind("連結財政状態"),
                prefix.rfind(f"{current_scope}の経営成績"),
            )
            # 有報MDAの独立した財政状態節は全社の当期財政状態を記述する。
            sections = list(re.finditer(r"\([1-9][0-9]*\)\s*財政状態(?:の状況)?", prefix))
            if sections and "当社グループ" in prefix:
                company = max(company, sections[-1].start())
            # 当社株主への帰属利益という全社定義と当年度が同じ実績文に明示される。
            if current_scope in match[0] and "当社株主に帰属する当期純利益" in match[0]:
                company = match.start()
            if consolidated == "単体":
                company = max(company, prefix.rfind("当社の"))
            if company < 0 or max(prefix.rfind("セグメント"), prefix.rfind(other_scope)) > company:
                continue
            before_label = text[start : match.start()]
            if re.search(
                r"(?:営業|事業|経常|税引前|EBITDA|調整後|セグメント|部門)\s*$", before_label
            ):
                continue
            if re.search(
                r"(?:前期|前年度|前連結会計年度|前事業年度)(?:の|における|では|は)[^。、]{0,30}$",
                before_label,
            ):
                continue
            # 『経営上の目標として重要な指標』も、結果の明示文なら実績を記述する。
            goal_text = sentence
            if "これらの結果" in before_label:
                goal_text = goal_text.replace("経営上の目標として重要な指標と位置付けている", "")
            if _GOAL.search(goal_text) or not _COMPLETED.search(text[match.start() : end]):
                continue
            if pattern is _INDICATORS and "主な経営指標は" not in before_label:
                continue
            value = float(match["value"].replace("△", "-").replace("▲", "-"))
            if math.isfinite(value):
                values.add(value)
    if len(values) == 1:
        return values.pop()
    if values:
        logger.warning("純利益ROAの直接実績文が多値のため採用しない")
    return None
