"""保存済み同文書だけで通常producerのtype1選択・全既存値保全を確認する。"""

import json
from argparse import Namespace
from dataclasses import asdict
from datetime import datetime
from hashlib import sha256
from pathlib import Path

import pytest

from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.convert import xbrl_to_csv
from jp_stock_pipeline.jobs import edinet_daily as job
from jp_stock_pipeline.jobs.runner import JobContext
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Provenance, RawArtifact, Source
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    ("6963", "S100YF41", "E01953"),
    ("8014", "S100YBIN", "E02509"),
    ("8593", "S100YF4V", "E04788"),
]


def originals(case):
    code, doc, _ = case
    base = ROOT / "tmp/feature-audit-20261013"
    csv_path = base / "direct-roa-fixtures" / f"{code}-csv.zip"
    full_path = base / "direct-roa-saved-type1-legacy-v2" / f"{code}-{doc}.zip"
    if not csv_path.exists() or not full_path.exists():
        pytest.skip("既存保存の全type5/type1不在。追加取得・原本生成しない")
    evidence = next(
        p
        for p in json.loads(
            (Path(__file__).parent / "fixtures/direct-roa-table/provenance.json").read_text()
        )
        if p["code"] == code
    )
    assert sha256(full_path.read_bytes()).hexdigest() == evidence["fullZIPSHA256"]
    clock = datetime.fromisoformat(evidence["sourceFetchedAt"])

    def artifact(path, kind, fetch_type):
        return RawArtifact(
            source=Source.EDINET,
            datatype=kind,
            scope=code,
            data_date=clock.date(),
            fetched_at=clock,
            url=f"https://api.edinet-fsa.go.jp/api/v2/documents/{doc}?type={fetch_type}",
            local_path=path,
            sha256=sha256(path.read_bytes()).hexdigest(),
            size_bytes=path.stat().st_size,
            license_tag=LicenseTag.COMMERCIAL_OK,
            doc_id=doc,
        )

    return artifact(csv_path, "csv", 5), artifact(full_path, "xbrl", 1)


@pytest.mark.parametrize("case", CASES, ids=[c[0] for c in CASES])
@pytest.mark.parametrize("available", [True, False])
def test_existing_whole_type1_is_reused_with_other_financial_fields_identical(
    monkeypatch, tmp_path, case, available
):
    csv, full = originals(case)
    code, doc_id, issuer = case
    tidy = xbrl_to_csv.edinet_csv_zip_to_tidy(csv.local_path.read_bytes(), code, doc_id)
    calls = []
    ctx = JobContext(
        settings=load_settings(dry_run=True, env={"RAW_DATA_DIR": str(tmp_path)}),
        client=None,
        args=Namespace(kabumcp_cache_dir=None),
    )
    monkeypatch.setattr(
        job.saved_edinet, "read_saved_type1", lambda *a, **kw: calls.append("saved") or (full if available else None)
    )
    def fetch(*args, **kwargs):
        assert not available, "保存原本があるのに公式GETした"
        assert args[2] == 1
        calls.append("fetch1")
        return full  # 通信なし、保存した同一実原本を依存注入。
    monkeypatch.setattr(job.edinet, "fetch_document", fetch)
    monkeypatch.setattr(job.xbrl_to_csv, "write_tidy", lambda *a: None)
    monkeypatch.setattr(ctx, "upload_raw", lambda *a, **k: calls.append("archive") or None)
    actual_artifact, actual = job._roa_table_original(
        ctx,
        {"docID": doc_id, "docTypeCode": "120", "csvFlag": "1", "edinetCode": issuer},
        csv,
        tidy,
        sha_map=None,
        target_date=None,
    )
    assert actual_artifact is full
    assert calls == (["saved", "archive"] if available else ["saved", "fetch1", "archive"])
    prov = Provenance(
        source=Source.EDINET,
        license_tag=LicenseTag.COMMERCIAL_OK,
        data_date=csv.data_date,
        fetched_at=csv.fetched_at,
    )
    before = asdict(tidy_to_financial_record(tidy, code, prov))
    after = asdict(tidy_to_financial_record(actual, code, prov))
    assert before.pop("roa_pct") is None
    assert after.pop("roa_pct") == {"6963": -11.6, "8014": 8.0, "8593": 1.3}[code]
    assert before == after


@pytest.mark.parametrize(
    "failure", ["saved-read", "native-identity", "other-financial-value", "table-value", "budget", "parse", "csv-code"]
)
def test_saved_errors_and_different_values_hold_without_official_replacement(
    monkeypatch, tmp_path, failure
):
    csv, full = originals(CASES[0])
    tidy = xbrl_to_csv.edinet_csv_zip_to_tidy(csv.local_path.read_bytes(), "6963", "S100YF41")
    native = xbrl_to_csv.xbrl_zip_to_tidy(full.local_path.read_bytes(), "6963", "S100YF41")
    if failure == "native-identity":
        native.loc[native.element.eq("jpdei_cor:EDINETCodeDEI"), "value"] = ""
    elif failure == "other-financial-value":
        native.loc[native.element.eq("jppfs_cor:NetSales"), "value"] = ""
    elif failure == "table-value":
        native.loc[native.element.str.contains("TextBlock", regex=False), "value"] = ""
    elif failure == "budget":
        full.size_bytes = job.saved_edinet.MAX_ZIP_BYTES + 1
    elif failure == "csv-code":
        tidy.loc[tidy.element.eq("jpdei_cor:SecurityCodeDEI"), "value"] = ""
    ctx = JobContext(
        settings=load_settings(dry_run=True, env={"RAW_DATA_DIR": str(tmp_path)}),
        client=None,
        args=Namespace(kabumcp_cache_dir=None),
    )

    def saved(*args, **kwargs):
        if failure == "saved-read":
            raise ValueError("保存read結果不明")
        return full

    archived = []
    monkeypatch.setattr(job.saved_edinet, "read_saved_type1", saved)
    monkeypatch.setattr(
        job.edinet, "fetch_document", lambda *a, **k: pytest.fail("失敗を公式GETへ代替した")
    )
    def parse(*args):
        if failure == "parse":
            raise ValueError("parse stopped")
        return native
    monkeypatch.setattr(job.xbrl_to_csv, "xbrl_zip_to_tidy", parse)
    monkeypatch.setattr(job.xbrl_to_csv, "write_tidy", lambda *a: None)
    monkeypatch.setattr(ctx, "upload_raw", lambda *a, **k: archived.append(a[0]) or None)
    with pytest.raises(ValueError):
        job._roa_table_original(
            ctx,
            {"docID": "S100YF41", "docTypeCode": "120", "csvFlag": "1", "edinetCode": "E01953"},
            csv,
            tidy,
            sha_map=None,
            target_date=None,
        )
    assert archived == ([] if failure in ("saved-read", "csv-code") else [full])
