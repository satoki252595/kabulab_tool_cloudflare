"""固定実原典3件と非通信faultでraw-only入口の対象/単発境界を固定する。"""

import importlib.util
import io
import json
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest
from botocore.exceptions import ClientError

from jp_stock_pipeline.cloud_store.d1 import D1Store
from jp_stock_pipeline.cloud_store.keys import raw_key
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.convert.xbrl_to_csv import TIDY_COLUMNS, write_tidy, xbrl_zip_to_tidy
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Source
from jp_stock_pipeline.rawstore import save_raw

ROOT = Path(__file__).resolve().parents[2]
BASE = Path(__file__).parent / "fixtures/direct-roa-table"
SPEC = importlib.util.spec_from_file_location("publish_saved_roa_raw", ROOT / "pipeline/scripts/publish_saved_roa_raw.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
MANIFEST = json.loads((ROOT / "pipeline/scripts/manifests/roa-type1-saved-20261014.json").read_text())
PROVENANCE = json.loads((BASE / "provenance.json").read_text())


@pytest.mark.parametrize("target", MANIFEST["targets"], ids=lambda t: t["code"])
def test_fixed_actual_submission_and_native_identity(target):
    MODULE.validate_manifest(MANIFEST)
    evidence = next(e for e in PROVENANCE if e["code"] == target["code"])
    body = (BASE / evidence["fixture"]).read_bytes()
    assert MODULE.digest(body) == evidence["cutoutSHA256"]
    assert target["sha256"] == evidence["fullZIPSHA256"]
    assert target["size_bytes"] == evidence["fullZIPBytes"]
    assert datetime.fromisoformat(target["fetched_at"]) == datetime.fromisoformat(evidence["sourceFetchedAt"])
    tidy = pd.DataFrame(json.loads(body), columns=TIDY_COLUMNS).astype("string")
    MODULE.qualify_native(tidy, target)
    tidy.loc[tidy.element.eq("jpdei_cor:SecurityCodeDEI"), "value"] = "00000"
    with pytest.raises(ValueError, match="主体"):
        MODULE.qualify_native(tidy, target)


@pytest.mark.parametrize("change", ["fourth-document", "submission-day", "type5", "wrong-issuer", "naive-clock"])
def test_manifest_rejects_expanded_or_changed_source(change):
    value = deepcopy(MANIFEST)
    if change == "fourth-document":
        value["targets"].append(value["targets"][0])
    elif change == "submission-day":
        value["targets"][0]["data_date"] = "2026-06-18"
    elif change == "type5":
        value["targets"][0]["source_url"] = value["targets"][0]["source_url"].replace("type=1", "type=5")
    elif change == "wrong-issuer":
        value["targets"][0]["submission_metadata"]["edinetCode"] = value["targets"][1]["edinet_code"]
    else:
        value["targets"][0]["fetched_at"] = "2026-06-19T15:15:00"
    with pytest.raises(ValueError):
        MODULE.validate_manifest(value)


class NativeTransport:
    """返答内容は同梱実原典。失敗/呼出し回数だけを操作する非通信transport。"""
    def __init__(self, content, failure=None):
        self.content, self.failure, self.calls = content, failure, []

    def put_object(self, **kwargs):
        self.calls.append(("PUT", kwargs))
        if self.failure:
            raise self.failure
        return {"ETag": MODULE.digest(self.content)}

    def head_object(self, **kwargs):
        self.calls.append(("HEAD", kwargs))
        return {"ContentLength": len(self.content)}

    def get_object(self, **kwargs):
        self.calls.append(("GET", kwargs))
        return {"Body": io.BytesIO(self.content)}


def guarded(failure=None):
    target = MANIFEST["targets"][0]
    body = (BASE / PROVENANCE[0]["fixture"]).read_bytes()
    key = raw_key(source="EDINET", datatype="xbrl", scope=target["code"], data_date=date.fromisoformat(target["data_date"]),
                  sha256=target["sha256"], ext="zip", doc_id=target["doc_id"])
    native = NativeTransport(body, failure)
    return MODULE.FixedS3(native, "jp-stock-raw", "vwap-data", {key: body}, set()), native, key, body


@pytest.mark.parametrize("status,code", [(412, "PreconditionFailed"), (403, "AccessDenied")])
def test_native_conditional_put_failure_never_replays(status, code):
    failure = ClientError({"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}, "PutObject")
    guard, native, key, body = guarded(failure)
    with pytest.raises(ClientError):
        guard.put_object(Bucket="jp-stock-raw", Key=key, Body=body)
    with pytest.raises(ValueError, match="再送"):
        guard.put_object(Bucket="jp-stock-raw", Key=key, Body=body)
    assert len(native.calls) == 1 and native.calls[0][1]["IfNoneMatch"] == "*"
    assert guard.last_failure["httpStatus"] == status


def test_existing_r2_head_always_checks_full_bytes_before_reuse():
    guard, native, key, body = guarded()
    guard.head_object(Bucket="jp-stock-raw", Key=key)
    assert [c[0] for c in native.calls] == ["HEAD", "GET"]
    native.content = body[:-1]
    with pytest.raises(ValueError, match="全bytes"):
        guard.head_object(Bucket="jp-stock-raw", Key=key)
    assert all(c[0] != "PUT" for c in native.calls)


def test_fixed_r2_rejects_unrelated_body_and_key_before_send():
    guard, native, key, body = guarded()
    with pytest.raises(ValueError, match="body"):
        guard.put_object(Bucket="jp-stock-raw", Key=key, Body=body[:-1])
    with pytest.raises(ValueError, match="固定原本"):
        guard.get_object(Bucket="jp-stock-raw", Key="ops/raw-index-backfill/canonical-20261014/state.json")
    assert native.calls == []


def test_raw_index_is_insert_only_and_financial_or_repeat_send_stops(monkeypatch):
    target = MANIFEST["targets"][0]
    artifact = SimpleNamespace(sha256=target["sha256"], scope=target["code"], doc_id=target["doc_id"],
        fetched_at=datetime.fromisoformat(target["fetched_at"]), data_date=date.fromisoformat(target["data_date"]), size_bytes=target["size_bytes"])
    key = raw_key(source="EDINET", datatype="xbrl", scope=artifact.scope, data_date=artifact.data_date,
                  sha256=artifact.sha256, ext="zip", doc_id=artifact.doc_id)
    row = MODULE.expected_index(artifact, key, "jp-stock-raw")
    store = MODULE.RawOnlyD1(load_settings(env={}).cloud_store, writer=MODULE.PLAN_ID)
    store.targets, store.expected_rows, store.sent = MANIFEST["targets"], [row], set()
    sent = []
    monkeypatch.setattr(D1Store, "query", lambda self, sql, params, **kw: sent.append((sql, params, kw)) or [])
    values = [row[k] for k in MODULE._RAW_COLUMNS]
    sql = "INSERT INTO jss_raw_files (" + ", ".join(MODULE._RAW_COLUMNS) + ") VALUES (" + ", ".join("?" for _ in values) + ") ON CONFLICT (sha256) DO UPDATE SET data_date=excluded.data_date"
    store.query(sql, values)
    assert sent[0][0].endswith("ON CONFLICT (sha256) DO NOTHING")
    assert sent[0][2] == {"idempotent": False}
    for statement, params in [(sql, values), ("UPDATE jss_financials SET roa_pct=?", [target["roa_pct"]])]:
        with pytest.raises(ValueError):
            store.query(statement, params)
    assert len(sent) == 1


@pytest.mark.parametrize("target", MANIFEST["targets"], ids=lambda t: t["code"])
def test_optional_whole_saved_type1_matches_native_qualification_and_existing_conversion(tmp_path, target):
    path = ROOT / "tmp/feature-audit-20261013/direct-roa-saved-type1-legacy-v2" / f"{target['code']}-{target['doc_id']}.zip"
    if not path.is_file():
        pytest.skip("全type1原本はprivate/Notion保管。常時CIは実原典cutoutでnative資格を確認")
    content = path.read_bytes()
    assert MODULE.digest(content) == target["sha256"] and len(content) == target["size_bytes"]
    tidy = xbrl_zip_to_tidy(content, target["code"], target["doc_id"])
    MODULE.qualify_native(tidy, target)
    artifact = save_raw(content, source=Source.EDINET, datatype="xbrl", scope=target["code"],
        data_date=date.fromisoformat(target["data_date"]), url=target["source_url"], ext="zip",
        license_tag=LicenseTag.COMMERCIAL_OK, base_dir=tmp_path, doc_id=target["doc_id"])
    artifact.fetched_at = datetime.fromisoformat(target["fetched_at"])
    write_tidy(tidy, artifact)
    assert len(artifact.converted_paths) == 2
    originals = json.loads((ROOT / "tmp/feature-audit-20261013/roa3-table-recovery-v1/original-files.json").read_text())
    # The private originals remain the complete-file authority; no cutout is substituted.
    files = next(r for r in originals if r["code"] == target["code"])["files"]
    for converted in artifact.converted_paths:
        expected = next(f for f in files if Path(f["path"]).suffix == converted.suffix)
        assert MODULE.digest(converted.read_bytes()) == expected["sha256"]
        assert converted.stat().st_size == expected["bytes"]


def test_existing_attempt_stops_before_notion_or_any_put(monkeypatch, tmp_path, capsys):
    path = tmp_path / "manifest.json"
    content = (ROOT / "pipeline/scripts/manifests/roa-type1-saved-20261014.json").read_bytes()
    path.write_bytes(content)
    accepted = "d5c01a2edd0f2f0943673973c56b54819ac367a8"
    monkeypatch.setenv("GITHUB_SHA", accepted)
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    monkeypatch.setenv("GITHUB_RUN_ID", "38495471611")
    config = load_settings(env={})
    monkeypatch.setattr(config.cloud_store, "require_complete", lambda: None)
    monkeypatch.setattr(MODULE, "load_settings", lambda **kwargs: config)
    native = NativeTransport(content)
    monkeypatch.setattr(MODULE.boto3, "client", lambda *args, **kwargs: native)
    with pytest.raises(SystemExit) as stopped:
        MODULE.publish(SimpleNamespace(manifest=path, approved_manifest_sha=MODULE.digest(content), accepted_main_sha=accepted))
    assert stopped.value.code == 1
    result = json.loads(capsys.readouterr().out)
    assert result["phase"] == "attempt_read" and result["attempted"] is False
    assert result["financialWrites"] == 0 and result["sourceGETs"] == 0
    assert [c[0] for c in native.calls] == ["GET"]


def test_canonical_wrong_parent_stops_before_attachment_read(monkeypatch):
    from jp_stock_pipeline.notion.client import NotionClient

    target = MANIFEST["targets"][0]
    page = {"object": "page", "id": target["legacy_archive_page_id"], "archived": False, "in_trash": False,
        "parent": {"type": "database_id", "database_id": target["legacy_archive_page_id"]}, "properties": {}}
    monkeypatch.setattr(NotionClient, "get_page", lambda self, page_id: page)
    client = MODULE.SingleAttemptNotion(None, dry_run=True)
    client.current, client.raw_db = SimpleNamespace(), "raw-db"
    with pytest.raises(ValueError, match="metadata"):
        client.get_page(page["id"])
