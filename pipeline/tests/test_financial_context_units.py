"""原本の会社全体/円建て/比率/年間配当の範囲を守る回帰テスト。"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest
import pandas as pd

from jp_stock_pipeline.convert.xbrl_to_csv import edinet_csv_zip_to_tidy, xbrl_zip_to_tidy
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Provenance, Source, now_jst
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record

FIXTURES = Path(__file__).parent / "fixtures/transform/context-unit"
CASES = json.loads((FIXTURES / "manifest.json").read_text())


def fixture_zip(case):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        if case["datatype"] == "csv":
            content = (FIXTURES / case["file"]).read_text().encode("utf-16")
            archive.writestr(case["file"].replace(".tsv", ".csv"), content)
        else:
            for part in case["parts"]:
                archive.writestr(part, (FIXTURES / part).read_bytes())
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
    for field, expected in case["expected"].items():
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


def test_inline_converter_retains_divide_unit_and_actual_dimensions():
    tidy = fixture_tidy(CASES[4])
    per_share = tidy["element"].str.endswith(":NetIncomePerShare")
    assert set(tidy.loc[per_share, "unit"]) == {"JPY/shares"}
    assert tidy["dimensions"].str.contains("AnnualDividendPaymentScheduleAxis").any()
    assert tidy["dimensions"].str.contains("ConsolidatedNonconsolidatedAxis").any()


@pytest.mark.parametrize("unit", ["USD", ""])
def test_unusable_next_year_forecast_does_not_mix_in_current_year_values(unit):
    case = CASES[5]
    tidy = fixture_tidy(case)
    sales = tidy[tidy["element"].str.endswith(":NetSalesIFRS")
                 & tidy["context_ref"].eq("CurrentYearDuration_ConsolidatedMember_ForecastMember")].copy()
    assert len(sales) == 1
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
    case = CASES[4]
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for index, part in enumerate(case["parts"]):
            content = (FIXTURES / part).read_bytes()
            archive.writestr(part, content)
            if b"<xbrli:unit" in content:
                conflicting = content.replace(b"iso4217:JPY", b"iso4217:USD")
                assert conflicting != content
                archive.writestr(f"conflicting-{index}-resources-ixbrl.htm", conflicting)
    with pytest.raises(ValueError, match="同ID.*不一致"):
        xbrl_zip_to_tidy(output.getvalue(), case["code"], case["page_id"])


def test_cached_reparse_verifies_hash_without_any_notion_or_http_request(tmp_path, monkeypatch):
    import hashlib
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
