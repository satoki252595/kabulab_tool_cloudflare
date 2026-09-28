"""原本の会社全体/円建て/比率/年間配当の範囲を守る回帰テスト。"""

from __future__ import annotations

import io
import json
import zipfile
import hashlib
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest
import pandas as pd

from jp_stock_pipeline.convert.xbrl_to_csv import edinet_csv_zip_to_tidy, xbrl_zip_to_tidy
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Provenance, Source, now_jst
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record
from conftest import fixture_path
from test_normalize import tidy_frame

FIXTURES = Path(__file__).parent / "fixtures/edinet/context-unit"
EDINET_CASES = json.loads((FIXTURES / "manifest.json").read_text())
TDNET_CASES = json.loads((FIXTURES / "tdnet.source.txt").read_text())
# 原公開資料の確認値をassertionに限定。TDnet原本はignored fixtureだけへ保存する。
EXPECTED_TDNET = {
    "8154": {"net_sales": 170450000000, "eps": 144.24, "dps_forecast": 140},
    "7699": {"dps_forecast": None, "forecast_net_sales": 85302000000,
             "forecast_net_income": 2745000000, "forecast_ordinary_income": 3388000000,
             "forecast_eps": 114.32},
    "3463": {"operating_income": 1625000000, "ordinary_income": 1232000000},
}
CASES = EDINET_CASES + TDNET_CASES


def fixture_zip(case):
    if case["datatype"] != "csv":
        content = fixture_path(f"tdnet/context-unit/{case['code']}.zip").read_bytes()
        assert hashlib.sha256(content).hexdigest() == case["raw_sha256"]
        return content
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        content = (FIXTURES / case["file"]).read_text().encode("utf-16")
        archive.writestr(case["file"].replace(".tsv", ".csv"), content)
    return output.getvalue()


def fixture_tidy(case):
    converter = edinet_csv_zip_to_tidy if case["datatype"] == "csv" else xbrl_zip_to_tidy
    return converter(fixture_zip(case), case["code"], case["page_id"])


def fixture_provenance(case):
    return Provenance(source=Source.EDINET if case["datatype"] == "csv" else Source.TDNET,
                      license_tag=LicenseTag.FACTUAL_CITE,
                      data_date=date.fromisoformat(case["fiscal_period_end"]), fetched_at=now_jst(),
                      raw_page_id=case["page_id"])


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["file"])
def test_real_csv_and_inline_facts_use_only_company_wide_jpy_and_annual_dividend(case):
    tidy = fixture_tidy(case)
    record = tidy_to_financial_record(tidy, case["code"], fixture_provenance(case))
    assert record is not None
    assert record.fiscal_period_end.isoformat() == case["fiscal_period_end"]
    assert record.disclosure_type == case["disclosure_type"]
    expected_values = case.get("expected", EXPECTED_TDNET.get(case["code"]))
    for field, expected in expected_values.items():
        if expected is None:
            assert getattr(record, field) is None
        else:
            assert getattr(record, field) == pytest.approx(expected)


def test_unknown_currency_is_not_assumed_to_be_yen():
    case = CASES[0]
    tidy = fixture_tidy(case)
    tidy["unit"] = ""
    record = tidy_to_financial_record(tidy, case["code"], fixture_provenance(case))
    assert record is not None
    assert record.net_sales is None
    assert record.eps is None
    assert record.equity_ratio_pct is None


def test_segment_dimension_is_rejected_even_when_context_id_looks_company_wide():
    case = CASES[0]
    tidy = fixture_tidy(case)
    sales = tidy["element"].str.endswith(":NetSales")
    segment = sales & tidy["context_ref"].str.contains("Member")
    assert (tidy.loc[segment, "value"] == "3473000000").any()
    # 同じ実原本値で、ID名がdimensionを表さないXBRL構造を検証する。
    tidy.loc[segment, "context_ref"] = "CurrentYTDDuration"
    tidy.loc[segment, "dimensions"] = '[["jpcrp_cor:OperatingSegmentsAxis", "issuer:SegmentMember"]]'
    record = tidy_to_financial_record(tidy, case["code"], fixture_provenance(case))
    assert record is not None
    assert record.net_sales == 4_422_000_000


def test_conflicting_whole_company_values_do_not_pick_first_fact():
    case = CASES[0]
    tidy = fixture_tidy(case)
    sales = tidy["element"].str.endswith(":NetSales")
    tidy.loc[sales, "context_ref"] = "CurrentYTDDuration"
    record = tidy_to_financial_record(tidy, case["code"], fixture_provenance(case))
    assert record is not None
    assert record.net_sales is None


def test_conflicting_current_interim_instants_remain_missing():
    case = next(case for case in EDINET_CASES if case["code"] == "7384")
    tidy = fixture_tidy(case)
    # 実原本の異なる時点値が同じ当中間期末を名乗る場合は、先頭採用しない。
    tidy.loc[tidy["context_ref"].eq("CurrentYearInstant"), "context_ref"] = "InterimInstant"
    record = tidy_to_financial_record(tidy, case["code"], fixture_provenance(case))
    assert record.bps is None
    assert record.equity_ratio_pct is None


def test_unusable_current_interim_unit_does_not_use_year_end_values():
    case = next(case for case in EDINET_CASES if case["code"] == "7384")
    tidy = fixture_tidy(case)
    tidy.loc[tidy["context_ref"].eq("InterimInstant"), "unit"] = ""
    record = tidy_to_financial_record(tidy, case["code"], fixture_provenance(case))
    assert record.bps is None
    assert record.equity_ratio_pct is None


def inline_structure(*, conflicting_unit=False):
    """市場データではない最小XML構造で共有resourcesを検証する。"""
    header = '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">'
    resources = ('<xbrli:context id="ctx"><xbrli:entity><xbrli:segment>'
                 '<xbrldi:explicitMember dimension="t:ConsolidatedNonconsolidatedAxis">t:ConsolidatedMember</xbrldi:explicitMember>'
                 '</xbrli:segment></xbrli:entity><xbrli:period><xbrli:endDate>2026-06-30</xbrli:endDate></xbrli:period></xbrli:context>'
                 '<xbrli:unit id="u"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unitNumerator>'
                 '<xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>')
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr('resources-ixbrl.htm', header + resources + '</html>')
        archive.writestr('facts-ixbrl.htm', header + '<ix:nonFraction name="t:EPS" contextRef="ctx" unitRef="u">1</ix:nonFraction></html>')
        if conflicting_unit:
            archive.writestr('conflict-ixbrl.htm', header + resources.replace('iso4217:JPY', 'iso4217:USD') + '</html>')
    return output.getvalue()


def test_inline_converter_retains_shared_divide_unit_and_actual_dimensions():
    tidy = xbrl_zip_to_tidy(inline_structure(), "structure", "structure")
    assert tidy.iloc[0]["unit"] == "JPY/shares"
    assert tidy.iloc[0]["period_end"] == "2026-06-30"
    assert "ConsolidatedNonconsolidatedAxis" in tidy.iloc[0]["dimensions"]


@pytest.mark.parametrize("annual, expected", [("1", 1), ("", None)])
def test_annual_dividend_does_not_use_half_or_year_end_when_annual_missing(annual, expected):
    # 選択ロジックだけの構造テスト。1/2/3は市場値ではない。
    rows = [{"element": "NetSales", "context_ref": "CurrentYTDDuration", "value": "1",
             "period_end": "2026-06-30"}]
    for member, value in (("SecondQuarterMember", "2"), ("YearEndMember", "3"), ("AnnualMember", annual)):
        rows.append({"element": "DividendPerShare", "value": value,
                     "context_ref": f"CurrentYearDuration_{member}_ForecastMember"})
    record = tidy_to_financial_record(tidy_frame(rows), "structure", fixture_provenance(CASES[0]))
    assert record.dps_forecast == expected


@pytest.mark.parametrize("unit", ["USD", ""])
def test_unusable_next_year_forecast_does_not_mix_in_current_year_values(unit):
    case = CASES[0]
    tidy = fixture_tidy(case)
    # 実績の原本値を使って予想年の入力構造だけを変更する。
    current = tidy[tidy["context_ref"].eq("CurrentYTDDuration")].copy()
    current["context_ref"] = "CurrentYearDuration_ConsolidatedMember_ForecastMember"
    tidy = pd.concat([tidy, current], ignore_index=True)
    sales = current[current["element"].str.endswith(":NetSales")].copy()
    assert len(sales) >= 1
    sales["context_ref"] = "NextYearDuration_ConsolidatedMember_ForecastMember"
    sales["unit"] = unit
    tidy = pd.concat([tidy, sales], ignore_index=True)
    record = tidy_to_financial_record(tidy, case["code"], fixture_provenance(case))
    assert record is not None
    assert record.forecast_net_sales is None
    # 来期売上があるのに当期の利益/EPSを混ぜない。
    assert record.forecast_net_income is None
    assert record.forecast_eps is None


def test_inline_document_set_conflicting_unit_ids_stop_parsing():
    with pytest.raises(ValueError, match="同ID.*不一致"):
        xbrl_zip_to_tidy(inline_structure(conflicting_unit=True), "structure", "structure")


def test_cached_reparse_verifies_hash_without_any_notion_or_http_request(tmp_path, monkeypatch):
    import sys

    sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
    import reparse_financials_from_notion as reparse

    case = CASES[0]
    old = tidy_to_financial_record(fixture_tidy(case), case["code"], fixture_provenance(case))
    old = replace(old, net_sales=3_473_000_000)
    content = fixture_zip(case)
    digest = hashlib.sha256(content).hexdigest()
    (tmp_path / f"{digest}.zip").write_bytes(content)
    previous = tmp_path / "previous.jsonl"
    previous.write_text(json.dumps({"page_id": case["page_id"], "old": reparse._record_dict(old),
                                   "raw_sha256": digest, "raw_url": case["raw_url"]}) + "\n")
    monkeypatch.setattr(reparse, "NotionClient", lambda *a, **kw: pytest.fail("cache再解析はNotion APIを呼ばない"))
    monkeypatch.setattr(reparse, "_download", lambda *a, **kw: pytest.fail("cache再解析は原本HTTPを呼ばない"))
    journal = tmp_path / "new.jsonl"
    reparse.reparse_cached(previous, journal, tmp_path)
    item = json.loads(journal.read_text())
    assert item["new"]["net_sales"] == 4_422_000_000
    assert item["parser_sha256"] == reparse.PARSER_SHA256
    (tmp_path / f"{digest}.zip").write_bytes(b"corrupted archive")
    with pytest.raises(ValueError, match="SHA256"):
        reparse._cached_item(item, tmp_path)
    (tmp_path / f"{digest}.zip").unlink()
    with pytest.raises(ValueError, match="cache欠損"):
        reparse._cached_item(item, tmp_path)
