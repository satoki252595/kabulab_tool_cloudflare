"""tdnet_hourly の短信 XBRL 原本保存に doc_id が渡ることの回帰テスト。

jss_raw_files.doc_id が全行 NULL だった原因の一つ: `_process_financial_xbrl`
が `save_raw` に `doc_id` を渡していなかった (fix/raw-doc-id-legacy-key)。
やのしんAPI・XBRL変換・Notion書込は実通信せず、コラボレータをすべて
monkeypatch/差し替えて `save_raw` 呼び出しの引数だけを検証する。
"""

from __future__ import annotations

import argparse
import types
from datetime import date, datetime, timezone

import pytest

from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.jobs import tdnet_hourly as mod
from jp_stock_pipeline.jobs.runner import JobContext
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import DisclosureRecord, Provenance, Source
from jp_stock_pipeline.notion.client import NotionClient

UTC = timezone.utc


@pytest.mark.parametrize("failure", [mod.FetchError("HTTP 503"), ValueError("invalid response")])
def test_unexpected_list_failure_stops_without_official_fallback(monkeypatch, tmp_path, failure):
    from unittest.mock import Mock

    listing = Mock(side_effect=failure)
    official = Mock(side_effect=AssertionError("追加源取得禁止"))
    monkeypatch.setattr(mod.tdnet_yanoshin, "list_disclosures", listing)
    monkeypatch.setattr(mod.tdnet_official_fallback, "fetch_list_pages", official)
    with pytest.raises(type(failure)):
        mod._collect(_ctx(str(tmp_path)), date(2026, 6, 10))
    assert listing.call_count == 1 and official.call_count == 0


def _ctx(raw_data_dir: str, *, dry_run: bool = True) -> JobContext:
    settings = load_settings(env={"RAW_DATA_DIR": raw_data_dir}, dry_run=dry_run)
    # client は未使用のコラボレータ (dry_run=True 固定で token 不要)。本番性の
    # 判定は settings.dry_run のみが行う (共通 strict の dry-run 分離)。
    ctx = JobContext(
        settings=settings,
        client=NotionClient(None, rps=1000.0, dry_run=True),
        args=argparse.Namespace(),
    )
    # ①③の Notion/ローカル/Cloudflare 書込は本テストの対象外。呼ばれたことだけ
    # 分かればよいので no-op に差し替える（実 SQL/API を叩かない）。
    ctx.upload_raw = lambda artifact, **kw: "raw-page-id"  # noqa: ARG005
    ctx.mirror_xbrl_facts = lambda tidy, artifact: None  # noqa: ARG005
    ctx.persist = lambda record, notion_write, *, label, include_lifecycle=True: True  # noqa: ARG005
    ctx.cloud_financial_summary = lambda fin, *, doc_id, raw_sha256: None  # noqa: ARG005
    return ctx


def _record(doc_id: str = "81234567") -> DisclosureRecord:
    prov = Provenance(
        source=Source.TDNET,
        license_tag=LicenseTag.FACTUAL_CITE,
        data_date=date(2026, 9, 11),
        fetched_at=datetime(2026, 9, 11, 9, 0, tzinfo=UTC),
    )
    return DisclosureRecord(
        doc_id=doc_id,
        title="決算短信",
        disclosed_at=datetime(2026, 9, 11, 9, 0, tzinfo=UTC),
        provenance=prov,
        code="7203",
        doc_type="短信",
        has_xbrl=True,
    )


class TestProcessFinancialXbrlSavesDocId:
    def test_save_raw_receives_the_disclosure_doc_id(self, monkeypatch, tmp_path):
        captured: dict = {}

        def fake_save_raw(content, **kwargs):
            captured.update(kwargs)
            return types.SimpleNamespace(
                local_path=types.SimpleNamespace(read_bytes=lambda: b"zip-bytes"),
                sha256="f" * 64,
            )

        monkeypatch.setattr(
            mod, "fetch", lambda url, **kw: types.SimpleNamespace(content=b"zip-bytes")  # noqa: ARG005
        )
        monkeypatch.setattr(mod, "save_raw", fake_save_raw)
        monkeypatch.setattr(
            mod.xbrl_to_csv, "xbrl_zip_to_tidy", lambda content, code, doc_id: "tidy"  # noqa: ARG005
        )
        monkeypatch.setattr(mod.xbrl_to_csv, "write_tidy", lambda tidy, artifact: None)  # noqa: ARG005
        monkeypatch.setattr(
            mod.normalize,
            "tidy_to_financial_record",
            lambda tidy, code, prov, *, disclosed_at: types.SimpleNamespace(code="7203"),  # noqa: ARG005
        )

        ctx = _ctx(str(tmp_path))
        record = _record(doc_id="81234567")
        mod._process_financial_xbrl(  # noqa: SLF001
            ctx, record, "https://example/xbrl.zip", master_id="M1", master_resolved=True
        )

        assert captured["doc_id"] == "81234567"
        assert captured["scope"] == "7203"


class TestFinancialXbrlCommonStrict:
    """本番共通 strict: XBRL 原本の Notion 未保管で開示単位を中止する。"""

    def test_production_custody_failure_stops_before_financial_record(self, monkeypatch, tmp_path):
        from jp_stock_pipeline.notion import file_upload

        monkeypatch.setattr(
            mod, "fetch", lambda url, **kw: types.SimpleNamespace(content=b"zip-bytes")  # noqa: ARG005
        )
        # save_raw は実物 (tmp へ書くのみ・通信なし)。変換だけ mock する。
        monkeypatch.setattr(
            mod.xbrl_to_csv, "xbrl_zip_to_tidy", lambda content, code, doc_id: "tidy"  # noqa: ARG005
        )
        monkeypatch.setattr(mod.xbrl_to_csv, "write_tidy", lambda tidy, artifact: None)  # noqa: ARG005
        monkeypatch.setattr(
            file_upload,
            "upload_raw_artifact",
            lambda *a, **kw: (_ for _ in ()).throw(  # noqa: ARG005
                file_upload.RawUploadError("テスト: XBRL 保管失敗")
            ),
        )
        built: list = []
        monkeypatch.setattr(
            mod.normalize,
            "tidy_to_financial_record",
            lambda tidy, code, prov, *, disclosed_at: built.append(prov),  # noqa: ARG005
        )

        ctx = _ctx(str(tmp_path), dry_run=False)
        del ctx.upload_raw  # 共通 helper 実物を使う (_ctx の固定 lambda を外す)
        persisted: list = []
        ctx.persist = lambda record, notion_write, **kw: persisted.append(record) or True  # noqa: ARG005

        with pytest.raises(file_upload.RawUploadError):
            mod._process_financial_xbrl(  # noqa: SLF001
                ctx, _record(), "https://example/xbrl.zip",
                master_id="M1", master_resolved=True,
            )
        assert built == [] and persisted == []
