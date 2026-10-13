"""保存済み有報の直接純利益ROA。CI用の公開原本2通だけ同梱し、実行時に取得・生成しない。"""

from datetime import date
from hashlib import sha256
from pathlib import Path
from unicodedata import normalize

import pandas as pd
import pytest

from jp_stock_pipeline.cloud_store import financials
from jp_stock_pipeline.convert.xbrl_to_csv import (
    TIDY_COLUMNS,
    edinet_csv_zip_to_tidy,
    xbrl_zip_to_tidy,
)
from jp_stock_pipeline.licensing import source_license
from jp_stock_pipeline.models import Provenance, Source, now_jst
from jp_stock_pipeline.notion.schema import FIN_PROP_ROA
from jp_stock_pipeline.notion.upsert import financial_summary_properties
from jp_stock_pipeline.transform.direct_roa import direct_net_profit_roa
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record

# 値は同SHAの有報の実績文のみ。前期9533=3.4を当期4.0に取り違えない。
CASES = [
    (
        "3329",
        "S100YSG1",
        "2026-04-30",
        None,
        "7d8ce987c5e507fdc93eee0552b3a9488dd1c6eedd094212dae4b29422126b2f",
    ),
    (
        "6086",
        "S100Y57I",
        "2026-02-28",
        12.3,
        "0df54f4e7bd13dc5dbbedd7b0206d8d96896db85df7992847192d05b4ffabe11",
    ),
    (
        "6963",
        "S100YF41",
        "2026-03-31",
        None,
        "b1f127e76e1d32fe540b48d3c9c162d2470ff6b7399072b665837472cba34fb0",
    ),
    (
        "7751",
        "S100XTLJ",
        "2025-12-31",
        5.6,
        "a03d309dab3d62cd89781038034346a8756e9a148fdf276d7b7faccf12ba9e07",
    ),
    (
        "7911",
        "S100YIAY",
        "2026-03-31",
        2.6,
        "8ac619e4b5c5658e1aa86d80658030d8a9e01e57454546d4c2dd6ada504a9772",
    ),
    (
        "7995",
        "S100YC38",
        "2026-03-31",
        6.4,
        "f86dcc6fa837a7011212192ccf83a429323a983e35c2f03343088d72ccb739b4",
    ),
    (
        "8014",
        "S100YBIN",
        "2026-03-31",
        None,
        "34fd1184fd49346539740cffeeeba55bf74600a886c8c045b491f760ef3e1387",
    ),
    (
        "8566",
        "S100YF3N",
        "2026-03-31",
        0.90,
        "270c211710faf3133d66459f3050700be1378ab8284b627fff50ec0c1d175f25",
    ),
    (
        "8572",
        "S100YBXA",
        "2026-03-31",
        None,
        "d20722b7f38379aa234d1a47b5bfe993028d40576f12f80f1331a16eafbc0bfc",
    ),
    (
        "8593",
        "S100YF4V",
        "2026-03-31",
        None,
        "0da120807640915da313573cef5ddc069652e6ebe606e7d7d77afd52f3652e7f",
    ),
    (
        "9533",
        "S100YGFW",
        "2026-03-31",
        4.0,
        "b80929f200ee1f960a66c68ff462fdc9ef6c5ea1cb44d07ca804a969d5334057",
    ),
]
TYPE1_SHA256 = {
    "3329": "8cb72f205c8529942445c44ee48b1563f9249097dcf3ebf9eb29b8f4093d0e0a",
    "6086": "4ccf959ca2f304b8df088e40190ce327497ac51536468cc27370682ce9537e2a",
    "6963": "84cc6e927d5d1d282c5bc845b3dbe2c1dbd9bd390291f5dde37ce0f75d4e6fe6",
    "7751": "be7dcb128cfaebdc3886a759dd2867a644a00228781e4512e706fcc4705c77d3",
    "7911": "cd74720544ba0ff0f860312e3c535cd13929dd64b133cc3c4cce2d5ee5f382bd",
    "7995": "b3bd478a4e3cd11c5e5508f7943ddf65d5c35d6cf89f4635c0a9e6e72ae8ad0b",
    "8014": "160cae1fed1392bddf45781e7e8fd63263cdd04b12ab81971f8625ef5d90f1d9",
    "8566": "7b14602846dba58c5e2a5f31f8ea36abd31795dbe93ba403e66abc96d79da96a",
    "8572": "c29853ad999eb98f0a56f1c1e65eff3d948d36dac605e491779720cf78c85cd8",
    "8593": "c8d5f6358461b4f88b57664a9daec3e9680a5634a28fb8e4ada9a82d675a8294",
    "9533": "41159039955c2829f13f7ae8c6f78fd4fea630f7ac8141aa5b2f5971593cd438",
}
_BLOCK = "jpcrp_cor:ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock"


def saved_tidy(case, file_kind="csv"):
    code, doc_id, _, _, digest = case
    path = (
        Path(__file__).resolve().parents[2]
        / "tmp/feature-audit-20261013/direct-roa-fixtures"
        / f"{code}-csv.zip"
    )
    parser = edinet_csv_zip_to_tidy
    # CIでも必ず実原本の肯定/拒否gateを実行する。残りの全原本検証は保存cache限定。
    if file_kind == "csv" and code in {"7911", "8566"}:
        path = Path(__file__).parent / "fixtures/direct-roa" / f"{code}-{doc_id}-type5.zip"
        assert path.is_file(), "同梱した実原本が欠落しています"
    if file_kind == "xbrl":
        path = (
            Path(__file__).resolve().parents[2]
            / "tmp/feature-audit-20261013/direct-roa-saved-type1-legacy-v2"
            / f"{code}-{doc_id}.zip"
        )
        digest = TYPE1_SHA256[code]
        parser = xbrl_zip_to_tidy
    if not path.exists():
        pytest.skip("保存済み同SHAの有報原本がない（取得・合成しない）")
    data = path.read_bytes()
    assert sha256(data).hexdigest() == digest
    return parser(data, code, doc_id)


@pytest.mark.parametrize("case", CASES, ids=[c[0] for c in CASES])
@pytest.mark.parametrize("file_kind", ["csv", "xbrl"])
def test_actual_direct_narrative_reaches_existing_d1_and_notion(case, file_kind):
    code, doc_id, period, expected, digest = case
    tidy = saved_tidy(case, file_kind)
    if file_kind == "xbrl":
        digest = TYPE1_SHA256[code]
    record = tidy_to_financial_record(
        tidy,
        code,
        Provenance(
            source=Source.EDINET,
            license_tag=source_license(Source.EDINET),
            data_date=date.fromisoformat(period),
            fetched_at=now_jst(),
        ),
    )
    assert record is not None
    assert record.fiscal_period_end == date.fromisoformat(period)
    assert record.disclosure_type == "本決算"
    assert record.roa_pct == expected
    row = financials.record_to_row(record, stock_id=None, doc_id=doc_id, raw_sha256=digest)
    assert row[financials.COLUMNS.index("roa_pct")] == expected
    assert row[financials.COLUMNS.index("raw_sha256")] == digest
    assert financial_summary_properties(record)[FIN_PROP_ROA] == {"number": expected}


@pytest.mark.parametrize(
    "failure",
    [
        "period",
        "interim",
        "native-scope",
        "segment-dimension",
        "segment-text",
        "prior-context",
        "other-section",
        "ordinary-profit",
        "target",
        "incomplete",
        "conflicting-value",
    ],
)
def test_actual_narrative_qualification_rejects_malformed_inputs(failure):
    # 7911保存原本の複製だけを変更する構造的拒否試験。本番値には使わない。
    tidy = saved_tidy(CASES[4]).copy()
    block = tidy.element.eq(_BLOCK)
    if failure in ("period", "interim", "native-scope"):
        local, invalid = {
            "period": ("CurrentPeriodEndDateDEI", ""),
            "interim": ("TypeOfCurrentPeriodDEI", "HY"),
            "native-scope": ("WhetherConsolidatedFinancialStatementsArePreparedDEI", "false"),
        }[failure]
        tidy.loc[tidy.element.eq(f"jpdei_cor:{local}"), "value"] = invalid
    elif failure == "segment-dimension":
        tidy.loc[block, "dimensions"] = '{"SegmentAxis":"SegmentMember"}'
    elif failure == "segment-text":
        tidy.loc[block, "value"] = tidy.loc[block, "value"].str.replace(
            "総資産当期純利益率", "セグメント別総資産当期純利益率"
        )
    elif failure == "prior-context":
        tidy.loc[block, "context_ref"] = "Prior1YearInstant"
    elif failure == "other-section":
        tidy.loc[block, "element"] = "jpcrp_cor:RemunerationForDirectorsAndOtherOfficersTextBlock"
    elif failure == "ordinary-profit":
        tidy.loc[block, "value"] = tidy.loc[block, "value"].str.replace("純利益率", "経常利益率")
    elif failure == "target":
        tidy.loc[block, "value"] = tidy.loc[block, "value"].str.replace(
            "2.6％へ", "2.6％へとする目標"
        )
    elif failure == "incomplete":
        tidy.loc[block, "value"] = tidy.loc[block, "value"].map(lambda s: s[: s.index("2.6％") + 4])
    elif failure == "conflicting-value":
        conflicting = tidy.loc[block].copy()
        conflicting["value"] = conflicting["value"].str.replace("2.6％", "3.6％")
        tidy = pd.concat([tidy, conflicting], ignore_index=True)
    assert direct_net_profit_roa(tidy, date(2026, 3, 31), "本決算", "連結") is None


@pytest.mark.parametrize("modifier", ["営業ROA", "営業 ROA"])
def test_other_roa_definition_does_not_inherit_prior_net_profit_definition(modifier):
    # 8566の純利益定義は保持し、当期実績文だけ別定義へ変更する拒否試験。
    tidy = saved_tidy(CASES[7]).copy()
    block = tidy.element.eq(_BLOCK)
    original = tidy.loc[block, "value"].map(lambda value: normalize("NFKC", value))
    changed = original.str.replace("ROAは", modifier + "は")
    assert not changed.equals(original)
    assert changed.str.contains(modifier + "は", regex=False).all()
    assert changed.str.contains("総資産当期純利益率", regex=False).all()
    tidy.loc[block, "value"] = changed
    assert direct_net_profit_roa(tidy, date(2026, 3, 31), "本決算", "連結") is None


def test_absent_source_remains_unavailable():
    assert (
        direct_net_profit_roa(pd.DataFrame(columns=TIDY_COLUMNS), date(2026, 3, 31), "本決算", None)
        is None
    )
