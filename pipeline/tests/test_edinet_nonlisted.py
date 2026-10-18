"""実保存一覧1件のadmission。分類結果のdoubleは配線検査のみ、金融値を生成しない。"""

import json
import hashlib
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

from jp_stock_pipeline.collectors import edinet_codelist
from jp_stock_pipeline.jobs import edinet_daily as job
from jp_stock_pipeline.notion import file_upload

DOC = json.loads((Path(__file__).parent / "fixtures/edinet/nonlisted-issuer.json").read_text())[
    "doc"
]


def catalog(tmp_path):
    path = Path(__file__).parent / "fixtures/edinet/Edinetcode.zip"
    return SimpleNamespace(
        local_path=path, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        size_bytes=path.stat().st_size, notion_page_id="saved-codelist"
    )


def test_excluded_is_not_a_financial_success_and_never_fetches_body(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        job.edinet, "fetch_document", lambda *a, **kw: pytest.fail("対象外body取得")
    )
    monkeypatch.setattr(
        job.edinet_codelist,
        "classify_issuer_listing",
        lambda *a, **kw: edinet_codelist.IssuerListingClassification(
            "excluded_nonlisted", "official_nonlisted_issuer", date(2026, 10, 16), 1
        ),
    )
    outcome = job._process_document(
        SimpleNamespace(),
        DOC,
        "saved-list",
        edinet_map={},
        codelist_loader=lambda day: (calls.append(day), catalog(tmp_path))[1],
    )
    assert outcome == "excluded_nonlisted" and calls == [date(2026, 10, 16)]


def test_real_old_catalog_and_missing_jcn_remain_unresolved_before_body(tmp_path, monkeypatch):
    monkeypatch.setattr(
        job.edinet, "fetch_document", lambda *a, **kw: pytest.fail("未資格body取得")
    )
    for doc in [DOC, {**DOC, "JCN": None}, {**DOC, "secCode": "00000"}]:
        with pytest.raises(ValueError, match="未解決"):
            job._process_document(
                SimpleNamespace(),
                doc,
                "saved-list",
                edinet_map={},
                codelist_loader=lambda _: catalog(tmp_path),
            )


def test_replaced_local_catalog_is_held_before_classification(tmp_path, monkeypatch):
    original = catalog(tmp_path)
    path = tmp_path / "changed.zip"
    path.write_bytes(original.local_path.read_bytes()[:-1])
    original.local_path = path
    monkeypatch.setattr(job.edinet_codelist, "classify_issuer_listing", lambda *a, **kw: pytest.fail("異なる原本を分類しない"))
    with pytest.raises(ValueError, match="分類前bytes/SHA"):
        job._process_document(SimpleNamespace(), DOC, "saved-list", edinet_map={},
            codelist_loader=lambda _:original)


def test_lazy_codelist_unknown_archive_aborts_once_before_document_body(tmp_path, monkeypatch):
    calls = []
    ctx = SimpleNamespace(
        settings=SimpleNamespace(),
        client=object(),
        args=SimpleNamespace(date=date(2026, 10, 16), limit=None),
        upload_raw=lambda artifact, **kw: (
            "saved-list"
            if artifact == "list"
            else (_ for _ in ()).throw(file_upload.RawUploadError("archive unknown"))
        ),
        add_success=lambda: pytest.fail("対象外を成功にしない"),
        add_failure=lambda *a: pytest.fail("unknown保管後に次書類へ続行しない"),
    )
    monkeypatch.setattr(job.file_upload, "load_raw_page_map", lambda *a, **kw: {})
    # 同一通知の重複配送というprotocol fault。実金融文書の追加や捏造ではない。
    monkeypatch.setattr(job.edinet, "list_documents", lambda *a: ("list", [DOC, DOC]))
    monkeypatch.setattr(job.json_to_parquet, "convert_artifact", lambda *a: None)
    monkeypatch.setattr(job, "_load_master_maps", lambda _: ({}, {}, True))
    monkeypatch.setattr(job.upsert, "load_disclosure_page_entries", lambda *a, **kw: {})
    monkeypatch.setattr(job.saved_edinet, "read_saved_codelist", lambda *a, **kw: None)

    def fetch(*_):
        calls.append("source")
        return catalog(tmp_path)

    monkeypatch.setattr(job.edinet_codelist, "fetch_codelist", fetch)
    monkeypatch.setattr(
        job.edinet, "fetch_document", lambda *a, **kw: pytest.fail("unknown後body取得")
    )
    with pytest.raises(file_upload.RawUploadError, match="unknown"):
        job.execute(ctx)
    assert calls == ["source"]
