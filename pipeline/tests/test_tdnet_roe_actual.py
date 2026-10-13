"""保存済みTDnet実ZIPのROE。原本はgitignore下だけに置き、GETしない。"""

from __future__ import annotations

from datetime import date
from hashlib import sha256
from pathlib import Path

import pytest

from jp_stock_pipeline.convert.xbrl_to_csv import xbrl_zip_to_tidy
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Provenance, Source, now_jst
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record

CASES = [
    ("7777", "140120260611567948", "2026-04-30", "連結", "1.004", 100.4,
     "44961627fac38b714e137b83c40557b9be49d477748b161c5bab2128487d4549"),
    ("2138", "140120260604562851", "2026-03-31", "連結", "-0.052", -5.2,
     "2e875d1cf11245a8c1cb23fb40823353b6c78e6bb87d930677da528689e7502f"),
    ("556A", "140120260610566856", "2026-04-30", "単体", "0.464", 46.4,
     "763bfaf4d8001e74cb902f5126e6f61686d9722a59d0cf7c7439ea426f8e7817"),
    ("6740", "140120260622575925", "2026-03-31", "連結", "", None,
     "ed5072fd8731047c85a605eb50c6b20d166305e11912e4423c9e3bde4a0bdc4b"),
]


@pytest.mark.parametrize("code,doc_id,period,scope,raw,expected,digest", CASES)
def test_direct_tdnet_roe_and_distinct_ordinary_income_return(
    code, doc_id, period, scope, raw, expected, digest,
):
    path = Path(__file__).parent / "fixtures" / "tdnet" / f"roe-{code}.zip"
    if not path.exists():
        pytest.skip("保存済みTDnet原本なし（取得・合成しない）")
    data = path.read_bytes()
    assert sha256(data).hexdigest() == digest
    tidy = xbrl_zip_to_tidy(data, code, doc_id)
    context = f"CurrentYearDuration_{'Consolidated' if scope == '連結' else 'NonConsolidated'}Member_ResultMember"
    direct = tidy[
        (tidy.element == "tse-ed-t:NetIncomeToShareholdersEquityRatio")
        & (tidy.context_ref == context)
    ]
    assert len(direct) == 1
    assert direct.iloc[0].unit == "pure"
    assert direct.iloc[0].value == raw
    assert direct.iloc[0].period_end == period
    record = tidy_to_financial_record(tidy, code, Provenance(
        source=Source.TDNET, license_tag=LicenseTag.FACTUAL_CITE,
        data_date=date.fromisoformat(period), fetched_at=now_jst(),
    ))
    assert record is not None
    assert record.fiscal_period_end == date.fromisoformat(period)
    assert record.disclosure_type == "本決算"
    assert record.consolidated == scope
    if expected is None:
        assert record.roe_pct is None  # 原典nilを前年ROEで補わない。
    else:
        assert record.roe_pct == pytest.approx(expected)
    # 別定義の総資産経常利益率が存在しても、純利益ROAへ代入しない。
    assert not tidy[
        (tidy.element == "tse-ed-t:OrdinaryIncomeToTotalAssetsRatio")
        & (tidy.context_ref == context)
    ].empty
    assert record.roa_pct is None
