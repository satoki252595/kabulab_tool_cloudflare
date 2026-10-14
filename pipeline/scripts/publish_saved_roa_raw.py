"""固定3通の保存EDINET type1を通常⑤/R2/原本索引へ公開。財務は変更しない。"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
from datetime import date, datetime, timezone
from pathlib import Path

import boto3
from botocore.config import Config

from jp_stock_pipeline.cloud_store.d1 import D1Store
from jp_stock_pipeline.cloud_store.keys import derived_key, raw_key
from jp_stock_pipeline.cloud_store.r2 import R2Store
from jp_stock_pipeline.cloud_store.sink import CloudSink, _RAW_COLUMNS
from jp_stock_pipeline.collectors.edinet import to_disclosure_record
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.convert.xbrl_to_csv import write_tidy, xbrl_zip_to_tidy
from jp_stock_pipeline.jobs.runner import JobContext
from jp_stock_pipeline.models import ConvertStatus
from jp_stock_pipeline.notion.client import NotionClient
from jp_stock_pipeline.notion.saved_edinet import read_saved_type1
from jp_stock_pipeline.transform.direct_roa import _dei, direct_net_profit_roa

PLAN_ID = "roa-type1-saved-20261014"
IDENTITIES = {("6963", "S100YF41", "E01953"), ("8014", "S100YBIN", "E02509"), ("8593", "S100YF4V", "E04788")}


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def validate_manifest(value: dict) -> None:
    if value.get("version") != 1 or value.get("plan_id") != PLAN_ID or value.get("max_documents") != 3:
        raise ValueError("固定ROA raw manifestの版/件数が不正")
    targets = value.get("targets")
    if not isinstance(targets, list) or len(targets) != 3 or {(t["code"], t["doc_id"], t["edinet_code"]) for t in targets} != IDENTITIES:
        raise ValueError("固定3主体/docID以外を公開しない")
    for target in targets:
        if target["fiscal_period_end"] != "2026-03-31" or target["source_url"] != f"https://api.edinet-fsa.go.jp/api/v2/documents/{target['doc_id']}?type=1":
            raise ValueError("固定FY/同文書type1原本以外を公開しない")
        if not re.fullmatch(r"[0-9a-f]{64}", target["sha256"]) or type(target["size_bytes"]) is not int or not 0 < target["size_bytes"] <= 5 * 1024**2:
            raise ValueError("保存原本のSHA/サイズが不正")
        clock = datetime.fromisoformat(target["fetched_at"])
        if clock.tzinfo is None or date.fromisoformat(target["data_date"]) > clock.date():
            raise ValueError("保存原本の取得時計/提出日が不正")
        metadata = target["submission_metadata"]
        if (metadata["docID"] != target["doc_id"] or metadata["edinetCode"] != target["edinet_code"]
                or metadata["secCode"] != target["code"] + "0" or metadata["periodEnd"] != target["fiscal_period_end"]
                or to_disclosure_record(metadata).provenance.data_date.isoformat() != target["data_date"]):
            raise ValueError("保存済み提出metadataと主体/提出日が不一致")


def qualify_native(tidy, target: dict) -> None:
    for name, expected in {
        "EDINETCodeDEI": target["edinet_code"], "SecurityCodeDEI": target["code"] + "0",
        "TypeOfCurrentPeriodDEI": "FY", "CurrentPeriodEndDateDEI": target["fiscal_period_end"],
        "CurrentFiscalYearEndDateDEI": target["fiscal_period_end"],
        "WhetherConsolidatedFinancialStatementsArePreparedDEI": "true",
    }.items():
        if _dei(tidy, name) != expected:
            raise ValueError("保存原本のnative主体/FY/連結が不一致")
    if direct_net_profit_roa(tidy, date.fromisoformat(target["fiscal_period_end"]), "本決算", "連結") != target["roa_pct"]:
        raise ValueError("保存原本の直接ROAが固定資格と不一致")


class SingleAttemptNotion(NotionClient):
    """通常reader/publisherの構築を使い、修復runの再送と曖昧な一意性を禁止。"""
    current = None
    api_calls = 0
    hosted_reads = 0
    read_target = None

    def _call(self, fn, /, *, _retry_safe=True, **kwargs):
        self.api_calls += 1
        if self.api_calls > 60:
            raise ValueError("Notion取得予算超過")
        self._throttle.wait()
        result = fn(**kwargs)
        if "database_id" in kwargs and "filter" in kwargs and (result["has_more"] or result["next_cursor"] is not None):
            raise ValueError("保存原本queryが打切り")
        return result

    def query_database(self, database_id, **kwargs):
        kwargs.update(page_size=2, max_pages=1, strict=True)
        pages = super().query_database(database_id, **kwargs)
        if len(pages) > 1:
            raise ValueError("保存原本が一意でない")
        if pages and database_id != self.raw_db:
            target = self.read_target
            page = pages[0]
            metadata = json.loads("".join(p["plain_text"] for p in page["properties"]["Metadata"]["rich_text"]))
            if (target is None or page["id"] != target["legacy_archive_page_id"]
                    or any(metadata.get(k) != v for k, v in target["submission_metadata"].items())):
                raise ValueError("旧保管のページ/提出metadataが固定資格と不一致")
        return pages

    def get_page(self, page_id):
        page = super().get_page(page_id)
        artifact = self.current
        if artifact is not None:
            props = page["properties"]
            def text(name):
                return "".join(p["plain_text"] for p in props[name]["rich_text"])
            if (page["object"] != "page" or page["id"] != page_id
                    or page["parent"]["type"] != "database_id"
                    or page["parent"]["database_id"].replace("-", "") != self.raw_db.replace("-", "")
                    or page["archived"] is not False or page["in_trash"] is not False
                    or text("SHA256") != artifact.sha256 or text("対象銘柄コード") != artifact.scope
                    or text("データ種別") != "xbrl" or props["取得URL"]["url"] != artifact.url
                    or props["データ基準日"]["date"]["start"] != artifact.data_date.isoformat()
                    or datetime.fromisoformat(props["取得日時"]["date"]["start"]) != artifact.fetched_at
                    or props["ソース"]["select"]["name"] != "EDINET"
                    or props["ライセンスタグ"]["select"]["name"] != "commercial-ok"
                    or props["変換状態"]["select"]["name"] != "完了"
                    or len(props["ファイル"]["files"]) != 3):
                raise ValueError("既存⑤全type1 metadataが固定原本と不一致")
        return page

    def download_file(self, url, **kwargs):
        self.hosted_reads += 1
        if self.hosted_reads > 12:
            raise ValueError("保存原本の物理読取予算超過")
        self._throttle.wait()
        return super().download_file(url, max_bytes=20 * 1024**2)


class RawOnlyD1(D1Store):
    expected_rows = None

    def query(self, sql, params=None, **kwargs):
        if sql == "SELECT * FROM jss_raw_files WHERE sha256=?":
            if len(params) != 1 or params[0] not in {t["sha256"] for t in self.targets}:
                raise ValueError("固定3原本以外のD1読取は禁止")
        elif sql.startswith("INSERT INTO jss_raw_files ("):
            expected = self.expected_rows
            insert = "INSERT INTO jss_raw_files (" + ", ".join(_RAW_COLUMNS) + ") VALUES (" + ", ".join("?" for _ in _RAW_COLUMNS) + ")"
            if (sql.split(" ON CONFLICT ")[0] != insert or expected is None
                    or params not in [[row[k] for k in _RAW_COLUMNS] for row in expected]):
                raise ValueError("固定原本の全17列以外のD1書込は禁止")
            if params[0] in self.sent:
                raise ValueError("D1 mutationの再送は禁止")
            self.sent.add(params[0])
            # PRE後の競合行も変更しない。通常publisherの一行INSERTを再利用する。
            sql = insert + " ON CONFLICT (sha256) DO NOTHING"
        else:
            raise ValueError("raw原本索引以外のD1 SQLは禁止")
        return super().query(sql, params, idempotent=False)


class StrictContext(JobContext):
    skip_cloud = False

    def _cloud(self, fn, label):
        if self.notion_failed:
            raise ValueError("⑤未確定のためCloudflare書込禁止")
        if self.skip_cloud:
            return True
        result = fn(self.cloud)
        if result is not True:
            raise ValueError("原本R2/索引未確定のため停止")
        return result


class FixedS3:
    """既存R2Storeを使い、固定bodyと新規限定PUTだけを許す。"""
    def __init__(self, native, raw_bucket, receipt_bucket, bodies, receipt_keys):
        self.native, self.raw_bucket, self.receipt_bucket = native, raw_bucket, receipt_bucket
        self.bodies, self.receipt_keys = bodies, receipt_keys
        self.sent = set()
        self.last_failure = None

    def __getattr__(self, name):
        if name not in ("head_object", "get_object", "put_object"):
            raise ValueError("R2の変更/列挙操作は禁止")
        def invoke(**kwargs):
            pair = (kwargs["Bucket"], kwargs["Key"])
            raw = pair[0] == self.raw_bucket and pair[1] in self.bodies
            receipt = pair[0] == self.receipt_bucket and pair[1] in self.receipt_keys
            if not raw and not receipt:
                raise ValueError("固定原本/専用receipt以外のR2アクセスは禁止")
            if name == "put_object":
                if pair in self.sent:
                    raise ValueError("R2 mutationの再送は禁止")
                if raw and kwargs["Body"] != self.bodies[pair[1]]:
                    raise ValueError("固定原本body不一致")
                self.sent.add(pair)
                kwargs["IfNoneMatch"] = "*"
            try:
                result = getattr(self.native, name)(**kwargs)
                self.last_failure = None
                if name == "head_object" and raw:
                    response = self.get_object(**kwargs)
                    body = self.bodies[pair[1]]
                    try:
                        if response["Body"].read(len(body) + 1) != body:
                            raise ValueError("既存R2の全bytes不一致。上書きせず停止")
                    finally:
                        response["Body"].close()
                return result
            except Exception as error:
                self.last_failure = {"operation": name, "errorClass": type(error).__name__, "httpStatus": getattr(error, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")}
                raise
        return invoke


def expected_index(artifact, key, bucket):
    epoch = int(artifact.fetched_at.timestamp())
    return dict(zip(_RAW_COLUMNS, [artifact.sha256, bucket, key, derived_key(key, suffix="csv"), "csv", "EDINET", "xbrl", artifact.scope,
        artifact.doc_id, artifact.scope, artifact.data_date.isoformat(), "zip", artifact.size_bytes, "commercial-ok", "完了", epoch, epoch], strict=True))


def publish(args) -> None:
    logging.disable(logging.CRITICAL)
    manifest_bytes = args.manifest.read_bytes()
    run_id = os.environ.get("GITHUB_RUN_ID")
    if (digest(manifest_bytes) != args.approved_manifest_sha or not re.fullmatch(r"[0-9a-f]{40}", args.accepted_main_sha)
            or os.environ.get("GITHUB_SHA") != args.accepted_main_sha or os.environ.get("GITHUB_REF") != "refs/heads/main"
            or not isinstance(run_id, str) or not run_id.isdigit()):
        raise ValueError("承認manifest/mainが不一致")
    manifest = json.loads(manifest_bytes)
    validate_manifest(manifest)
    settings = load_settings(dry_run=False)
    settings.cloud_store.require_complete()
    native = boto3.client("s3", endpoint_url=settings.cloud_store.r2_endpoint,
        aws_access_key_id=settings.cloud_store.r2_access_key_id, aws_secret_access_key=settings.cloud_store.r2_secret_access_key,
        region_name="auto", config=Config(retries={"total_max_attempts": 1, "mode": "standard"}, connect_timeout=10, read_timeout=60))
    receipt_bucket = settings.cloud_store.bucket_timeseries
    prefix = f"ops/{PLAN_ID}"
    receipt_keys = {f"{prefix}/{name}.json" for name in ("attempt", "complete", "STOP")}
    bodies = {}
    guarded = FixedS3(native, settings.cloud_store.bucket_raw, receipt_bucket, bodies, receipt_keys)
    def receipt(name, value):
        body = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        key = f"{prefix}/{name}.json"
        ack = guarded.put_object(Bucket=receipt_bucket, Key=key, Body=body, ContentType="application/json")
        if not ack.get("ETag"):
            raise ValueError("専用receiptのPUT ACKが未確定")
        response = guarded.get_object(Bucket=receipt_bucket, Key=key)
        actual = response["Body"].read(len(body) + 1)
        response["Body"].close()
        if actual != body:
            raise ValueError("専用receiptの全bytes readback不一致")
        return digest(body)
    phase, attempted = "attempt_read", False
    try:
        try:
            old = guarded.get_object(Bucket=receipt_bucket, Key=f"{prefix}/attempt.json")
            old["Body"].close()
            raise ValueError("既存attemptあり。成功/失敗/不明とも再送しない")
        except Exception as error:
            if getattr(error, "response", {}).get("Error", {}).get("Code") != "NoSuchKey" or getattr(error, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode") != 404:
                raise
        phase = "attempt_create"
        attempted = True
        receipt("attempt", {"planId": PLAN_ID, "manifestSHA": digest(manifest_bytes), "acceptedMainSHA": args.accepted_main_sha,
            "runId": run_id, "startedAt": datetime.now(timezone.utc).isoformat(), "noReplay": True, "sourceGETs": 0, "financialWrites": 0})
        client = SingleAttemptNotion(settings.notion_token, rps=0.5)
        client.raw_db = settings.db_id("raw_files")
        cloud = CloudSink(settings.cloud_store, writer=PLAN_ID)
        cloud._d1 = RawOnlyD1(settings.cloud_store, writer=PLAN_ID)
        cloud._d1.targets = manifest["targets"]
        cloud._d1.sent = set()
        cloud._raw_bucket = R2Store(settings.cloud_store, settings.cloud_store.bucket_raw, writer=PLAN_ID)
        cloud._raw_bucket._s3 = guarded
        ctx = StrictContext(settings=settings, client=client, args=argparse.Namespace(), cloud=cloud)
        published = []
        for target in manifest["targets"]:
            phase = "source_read"
            client.current = None
            client.read_target = target
            artifact = read_saved_type1(client, settings, target["doc_id"], target["code"], date.fromisoformat(target["data_date"]),
                edinet_code=target["edinet_code"], fiscal_period_end=date.fromisoformat(target["fiscal_period_end"]))
            if artifact is None or artifact.sha256 != target["sha256"] or artifact.size_bytes != target["size_bytes"] or artifact.fetched_at != datetime.fromisoformat(target["fetched_at"]):
                raise ValueError("固定保存type1不在/異原本。公式GETへ代替しない")
            phase = "source_identity"
            tidy = xbrl_zip_to_tidy(artifact.local_path.read_bytes(), target["code"], target["doc_id"])
            qualify_native(tidy, target)
            write_tidy(tidy, artifact)
            if artifact.convert_status != ConvertStatus.DONE:
                raise ValueError("既存変換処理の失敗")
            for doc_id in (artifact.doc_id, None):
                key = raw_key(source="EDINET", datatype="xbrl", scope=artifact.scope, data_date=artifact.data_date, sha256=artifact.sha256, ext="zip", doc_id=doc_id)
                bodies[key] = artifact.local_path.read_bytes()
                for path in artifact.converted_paths:
                    bodies[derived_key(key, suffix=path.suffix.lstrip("."))] = path.read_bytes()
            before = cloud.d1.query("SELECT * FROM jss_raw_files WHERE sha256=?", [artifact.sha256])
            if len(before) > 1:
                raise ValueError("原本索引が一意でない")
            if before and (before[0]["r2_key"] not in bodies or before[0] != expected_index(artifact, before[0]["r2_key"], settings.cloud_store.bucket_raw)):
                raise ValueError("既存索引/旧時計が固定原本と不一致。上書きしない")
            cloud.d1.expected_rows = [expected_index(artifact, raw_key(source="EDINET", datatype="xbrl", scope=artifact.scope,
                data_date=artifact.data_date, sha256=artifact.sha256, ext="zip", doc_id=doc), settings.cloud_store.bucket_raw)
                for doc in (artifact.doc_id, None)]
            ctx.skip_cloud = bool(before)
            client.current = artifact
            phase = "notion_and_cloud_publish"
            page_id = ctx.upload_raw(artifact)
            if ctx.notion_failed or ctx.cloud_failed or page_id != artifact.notion_page_id:
                raise ValueError("通常publisherの原本保存が未確定")
            unique = client.query_database(client.raw_db, filter={"property": "SHA256", "rich_text": {"equals": artifact.sha256}})
            if len(unique) != 1 or unique[0]["id"] != page_id:
                raise ValueError("⑤保存後のSHA一意性/ページIDが不一致")
            phase = "raw_index_verify"
            after = cloud.d1.query("SELECT * FROM jss_raw_files WHERE sha256=?", [artifact.sha256])
            if len(after) != 1 or after[0] != expected_index(artifact, after[0]["r2_key"], settings.cloud_store.bucket_raw) or before and before != after:
                raise ValueError("全17列原本索引readback不一致")
            phase = "raw_body_verify"
            stored = after[0]["r2_key"]
            paths = [(stored, artifact.local_path), *[(derived_key(stored, suffix=p.suffix.lstrip(".")), p) for p in artifact.converted_paths]]
            for key, path in paths:
                response = guarded.get_object(Bucket=settings.cloud_store.bucket_raw, Key=key)
                content = response["Body"].read(path.stat().st_size + 1)
                response["Body"].close()
                if content != path.read_bytes():
                    raise ValueError("原本/変換版R2全bytes不一致")
            published.append({"code": artifact.scope, "docID": artifact.doc_id, "pageId": page_id, "sha256": artifact.sha256,
                "fetchedAt": artifact.fetched_at.isoformat(), "rawIndex": after[0], "fullNotionAttachmentsVerified": True,
                "fullR2AttachmentsVerified": True, "files": [{"name": p.name, "sha256": digest(p.read_bytes()), "bytes": p.stat().st_size} for _, p in paths]})
        phase = "complete_receipt"
        proof = {"status": "ALL3_CANONICAL_TYPE1_AND_RAW_INDEX_FULLY_VERIFIED", "planId": PLAN_ID, "manifestSHA": digest(manifest_bytes),
            "acceptedMainSHA": args.accepted_main_sha, "completedAt": datetime.now(timezone.utc).isoformat(), "rows": published,
            "notionRequests": client.api_calls, "hostedReads": client.hosted_reads, "sourceGETs": 0, "modelCalls": 0, "financialWrites": 0}
        proof_sha = receipt("complete", proof)
        print(json.dumps({"status": proof["status"], "targets": 3, "receiptSHA": proof_sha, "sourceGETs": 0, "modelCalls": 0, "financialWrites": 0}))
    except Exception as error:
        failure = {"status": "STOP_NO_REPLAY", "phase": phase, "errorClass": type(error).__name__, "r2Failure": guarded.last_failure,
            "sourceGETs": 0, "modelCalls": 0, "financialWrites": 0, "attempted": attempted}
        if attempted and phase != "attempt_create":
            try:
                receipt("STOP", failure)
            except Exception:
                failure["stopReceiptUnconfirmed"] = True
        print(json.dumps(failure))
        raise SystemExit(1) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--approved-manifest-sha", required=True)
    parser.add_argument("--accepted-main-sha", required=True)
    parser.add_argument("--apply", action="store_true", required=True)
    args = parser.parse_args()
    publish(args)


if __name__ == "__main__":
    main()
