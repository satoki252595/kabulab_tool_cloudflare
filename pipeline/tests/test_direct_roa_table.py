"""同梱した実EDINET部分原典で表の年度・定義・連結と通常DTOを常時CI照合する。"""

import json
from copy import deepcopy
from datetime import date, datetime
from hashlib import sha256
from pathlib import Path
from unicodedata import normalize

import pandas as pd
import pytest
from lxml import html

from jp_stock_pipeline.cloud_store import financials
from jp_stock_pipeline.convert.xbrl_to_csv import TIDY_COLUMNS
from jp_stock_pipeline.licensing import source_license
from jp_stock_pipeline.models import Provenance, Source
from jp_stock_pipeline.notion.schema import FIN_PROP_ROA
from jp_stock_pipeline.notion.upsert import financial_summary_properties
from jp_stock_pipeline.transform.direct_roa import direct_net_profit_roa
from jp_stock_pipeline.transform.direct_roa_table import (
    ROATableConflict,
    direct_table_net_profit_roa,
    has_roa_table_candidate,
)
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record

BASE = Path(__file__).parent / "fixtures/direct-roa-table"
EXPECTED = {"6963": -11.6, "8014": 8.0, "8593": 1.3}
PROVENANCE = json.loads((BASE / "provenance.json").read_text())
PERIOD = date(2026, 3, 31)


def saved(code):
    evidence = next(p for p in PROVENANCE if p["code"] == code)
    content = (BASE / evidence["fixture"]).read_bytes()
    assert sha256(content).hexdigest() == evidence["cutoutSHA256"]
    rows = json.loads(content)
    for row in rows:
        fact = next(f for f in evidence["facts"] if f["element"] == row["element"])
        assert fact["context"] == row["context_ref"]
        assert sha256(row["value"].encode()).hexdigest() == fact["valueSHA256"]
    return pd.DataFrame(rows, columns=TIDY_COLUMNS).astype("string"), evidence


def changed(tidy, old, new):
    copy = tidy.copy()
    text = copy.element.str.startswith("jpcrp_cor:")
    copy.loc[text, "value"] = copy.loc[text, "value"].map(lambda v: normalize("NFKC", v))
    assert copy.loc[text, "value"].str.contains(old, regex=False).any()
    copy.loc[text, "value"] = copy.loc[text, "value"].str.replace(old, new, regex=False)
    return copy


@pytest.mark.parametrize("code", EXPECTED)
def test_actual_table_reaches_normalizer_existing_d1_and_notion(code):
    tidy, evidence = saved(code)
    assert has_roa_table_candidate(tidy)
    assert direct_net_profit_roa(tidy, PERIOD, "本決算", "連結") == EXPECTED[code]
    record = tidy_to_financial_record(
        tidy,
        code,
        Provenance(
            source=Source.EDINET,
            license_tag=source_license(Source.EDINET),
            data_date=PERIOD,
            fetched_at=datetime.fromisoformat(evidence["sourceFetchedAt"]),
        ),
    )
    assert record is not None and record.consolidated == "連結"
    assert record.roa_pct == EXPECTED[code]
    row = financials.record_to_row(
        record, stock_id=None, doc_id=evidence["docID"], raw_sha256=evidence["fullZIPSHA256"]
    )
    assert row[financials.COLUMNS.index("roa_pct")] == EXPECTED[code]
    assert row[financials.COLUMNS.index("raw_sha256")] == evidence["fullZIPSHA256"]
    assert financial_summary_properties(record)[FIN_PROP_ROA] == {"number": EXPECTED[code]}


@pytest.mark.parametrize("code", EXPECTED)
@pytest.mark.parametrize(
    "local,value",
    [
        ("CurrentPeriodEndDateDEI", "2025-03-31"),
        ("TypeOfCurrentPeriodDEI", "HY"),
        ("WhetherConsolidatedFinancialStatementsArePreparedDEI", "false"),
    ],
)
def test_actual_table_rejects_native_period_interim_or_scope_mismatch(code, local, value):
    tidy, _ = saved(code)
    tidy.loc[tidy.element.eq("jpdei_cor:" + local), "value"] = value
    assert direct_net_profit_roa(tidy, PERIOD, "本決算", "連結") is None


@pytest.mark.parametrize(
    "code,old,new",
    [
        ("6963", "2026年3月", "2027年3月"),
        ("6963", "親会社株主に帰属する当期純利益", "営業利益"),
        ("6963", "総資産利益率(ROA)", "営業ROA"),
        ("8014", "当連結会計年度", "来連結会計年度"),
        ("8014", "親会社株主に帰属する当期純利益", "経常利益"),
        ("8014", "当期純利益ROA", "営業ROA"),
        ("8593", "2026年3月期実績比", "2025年3月期実績比"),
        ("8593", "親会社株主に帰属する当期純利益", "営業利益"),
        ("8593", "[賞与]", "[株式報酬]"),
        ("8593", "全社業績評価のKPI", "セグメント業績評価のKPI"),
    ],
)
def test_actual_table_rejects_wrong_year_definition_target_or_award_scope(code, old, new):
    tidy, _ = saved(code)
    assert direct_net_profit_roa(changed(tidy, old, new), PERIOD, "本決算", "連結") is None


def test_conflicting_actual_tables_hold_even_when_narrative_agrees_with_one_value():
    # 保存8014の複製を明示改変する拒否試験。元fixture/本番値は変更しない。
    tidy, _ = saved("8014")
    block = tidy.element.eq("jpcrp_cor:ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock")
    original = normalize("NFKC", tidy.loc[block, "value"].item())
    assert "8.0%" in original
    narrative = "<p>当連結会計年度の経営成績、当社グループの主な経営指標は総資産純利益率8.0%となりました。</p>"
    tidy.loc[block, "value"] = "<div>" + original + narrative + "</div>"
    assert direct_net_profit_roa(tidy, PERIOD, "本決算", "連結") == 8.0
    tidy.loc[block, "value"] = "<div>" + original + original.replace("8.0%", "9.0%") + narrative + "</div>"
    with pytest.raises(ROATableConflict):
        direct_table_net_profit_roa(tidy, PERIOD)
    assert direct_net_profit_roa(tidy, PERIOD, "本決算", "連結") is None


@pytest.mark.parametrize("boundary", ["next-table", "heading", "outside-tail", "empty-p-tail", "ancestor-tail", "comment-tail"])
def test_actual_table_cannot_borrow_net_profit_definition_across_another_table_or_heading(boundary):
    # 同じ実8014 DOMの表/見出しを注記直前へ移す、境界だけの明示改変。
    tidy, _ = saved("8014")
    block = tidy.element.eq("jpcrp_cor:ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock")
    tree = html.fromstring(normalize("NFKC", tidy.loc[block, "value"].item()))
    definition = [p for p in tree.xpath("//p") if "当期純利益ROA=親会社株主に帰属する当期純利益÷総資産期中平均" in "".join(p.itertext())]
    assert len(definition) == 1
    if boundary == "next-table":
        marker = tree.xpath("//table")[0]
    else:
        headings = [p for p in tree.xpath("//p") if "ii.財政状態の分析" in "".join(p.itertext())]
        assert len(headings) == 1
        if boundary == "heading":
            marker = headings[0]
        elif boundary == "ancestor-tail":
            # tableを含む外側wrapperの末尾textも、次の注記より先に読む。
            actual_table = definition[0].xpath("preceding::table")[-1]
            wrapper = html.Element("div")
            actual_table.addprevious(wrapper)
            wrapper.append(actual_table)
            wrapper.tail = "".join(headings[0].itertext())
            marker = None
        else:
            if boundary == "comment-tail":
                marker = html.etree.Comment("boundary")
            else:
                marker = html.Element("p" if boundary == "empty-p-tail" else "span")
            marker.tail = "".join(headings[0].itertext())
    if marker is not None:
        definition[0].addprevious(deepcopy(marker))
    tidy.loc[block, "value"] = html.tostring(tree, encoding="unicode")
    assert direct_net_profit_roa(tidy, PERIOD, "本決算", "連結") is None
