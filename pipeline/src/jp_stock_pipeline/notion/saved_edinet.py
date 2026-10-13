"""同一docIDの保存type1を再利用する。保存検索失敗を公式GETへ置き換えない。"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import date, datetime

from ..config import ConfigError, Settings
from ..licensing import LicenseTag
from ..models import RawArtifact, Source
from ..rawstore import save_raw
from . import schema as S
from .client import NotionClient

logger = logging.getLogger(__name__)
MAX_ZIP_BYTES = 5 * 1024 * 1024


def _text(prop: dict, kind: str) -> str:
    if prop.get("type") != kind or not isinstance(prop.get(kind), list):
        raise ValueError("保存type1の文字プロパティが不正")
    parts = prop[kind]
    if any(
        p.get("type") != "text" or p.get("plain_text") != p.get("text", {}).get("content")
        for p in parts
    ):
        raise ValueError("保存type1の文字fragmentが不正")
    return "".join(p["plain_text"] for p in parts)


def _one(pages: list[dict]) -> dict | None:
    if len(pages) > 1:
        raise ValueError("保存type1が複数あり一意に確定できない")
    return pages[0] if pages else None


def _active(page: dict, database_id: str) -> dict:
    if (
        page.get("object") != "page"
        or page.get("archived") is not False
        or page.get("in_trash") is True
        or page.get("parent", {}).get("type") != "database_id"
        or page["parent"]["database_id"].replace("-", "") != database_id.replace("-", "")
    ):
        raise ValueError("保存type1のページ状態・親DBが不正")
    return page["properties"]


def _clock(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("保存type1の取得時計がない")
    clock = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if clock.tzinfo is None:
        raise ValueError("保存type1の取得時計にtimezoneがない")
    return clock


def read_saved_type1(
    client: NotionClient,
    settings: Settings,
    doc_id: str,
    code: str,
    data_date: date | None,
    *,
    edinet_code: str,
    fiscal_period_end: date,
) -> RawArtifact | None:
    """⑤ URL一意 → 既存yuho typed/legacy key。全探索の明示0件だけNone。

    SHAを持つ原本は全bytes照合。旧manifest不在は今回計測と明示区別し、
    呼出側がCSV/native DEIを照合してから⑤へ物理保管し直す。
    """
    if (not re.fullmatch(r"S[0-9A-Z]{7}", doc_id)
            or not re.fullmatch(r"[0-9]{3}[0-9A-Z]", code)
            or not re.fullmatch(r"E[0-9]{5}", edinet_code)):
        raise ValueError("保存type1のdocID・銘柄コードが不正")
    url = f"https://api.edinet-fsa.go.jp/api/v2/documents/{doc_id}?type=1"
    db = settings.db_id("raw_files")
    page = _one(
        client.query_database(
            db,
            filter={
                "and": [
                    {"property": S.RAW_PROP_URL, "url": {"equals": url}},
                    {"property": S.PROP_SOURCE, "select": {"equals": "EDINET"}},
                    {"property": S.RAW_PROP_DATATYPE, "rich_text": {"equals": "xbrl"}},
                ]
            },
            page_size=2,
            strict=True,
        )
    )
    expected_sha = None
    expected_size = None
    metadata = None
    if page is not None:
        props = _active(page, db)
        filename = _text(props[S.RAW_PROP_FILENAME], "title")
        if (
            props[S.RAW_PROP_URL].get("url") != url
            or _text(props[S.RAW_PROP_DATATYPE], "rich_text") != "xbrl"
            or _text(props[S.RAW_PROP_SCOPE], "rich_text") != code
            or props[S.PROP_SOURCE].get("select", {}).get("name") != "EDINET"
            or props[S.PROP_LICENSE_TAG].get("select", {}).get("name") != "commercial-ok"
        ):
            raise ValueError("⑤保存type1の来歴が不一致")
        expected_sha = _text(props[S.RAW_PROP_SHA256], "rich_text")
        expected_size = props[S.RAW_PROP_SIZE].get("number")
        if (
            not re.fullmatch(r"[0-9a-f]{64}", expected_sha)
            or type(expected_size) is not int
            or not 0 < expected_size <= MAX_ZIP_BYTES
        ):
            raise ValueError("⑤保存type1のSHA・サイズが不正")
        files = props[S.RAW_PROP_FILES]["files"]
        fetched_at = _clock(props[S.PROP_FETCHED_AT].get("date", {}).get("start"))
    else:
        if not settings.notion_archive_page_id:
            raise ConfigError("候補ROA表の保存type1検索にNOTION_ARCHIVE_PAGE_IDが必要")
        children = client.list_child_blocks(settings.notion_archive_page_id)
        matches = [
            b
            for b in children
            if b.get("type") == "child_database"
            and b.get("child_database", {}).get("title") == "一次データ｜yuho-quant"
            and b.get("archived") is not True and b.get("in_trash") is not True
        ]
        if len(matches) != 1:
            raise ValueError("既存yuho一次DBを一意に確認できない（新規作成・代替取得しない）")
        db = matches[0]["id"]
        key = doc_id + ":type1"
        page = _one(
            client.query_database(
                db, filter={"property": "Key", "title": {"equals": key}}, page_size=2, strict=True
            )
        )
        if page is None:
            key = doc_id
            page = _one(
                client.query_database(
                    db,
                    filter={"property": "Key", "title": {"equals": key}},
                    page_size=2,
                    strict=True,
                )
            )
        if page is None:
            return None
        props = _active(page, db)
        if _text(props["Key"], "title") != key:
            raise ValueError("保存type1のdocID keyが不一致")
        metadata = json.loads(_text(props["Metadata"], "rich_text"))
        if (
            metadata.get("docID") != doc_id
            or metadata.get("secCode") != code + "0"
            or metadata.get("edinetCode") != edinet_code
            or metadata.get("periodEnd") != fiscal_period_end.isoformat()
            or (key.endswith(":type1") and metadata.get("edinetDocType") != 1)
        ):
            raise ValueError("保存type1のmetadata/docID/銘柄が不一致")
        filename = f"{doc_id}_xbrl.zip"
        files = props["Files"]["files"]
        if key.endswith(":type1") and len(files) != 1:
            raise ValueError("typed保存type1に別添付が混在している")
        expected_sha = metadata.get("sourceZIPSHA")
        expected_size = metadata.get("sourceZIPBytes")
        fetched_at = _clock(props["Fetched At"].get("date", {}).get("start"))
    selected = [f for f in files if f.get("name") == filename]
    if len(selected) != 1 or selected[0].get("type") != "file":
        raise ValueError("保存type1のNotion物理添付が一意でない")
    content = client.download_file(selected[0]["file"]["url"], max_bytes=MAX_ZIP_BYTES)
    digest = hashlib.sha256(content).hexdigest()
    if (
        not 0 < len(content) <= MAX_ZIP_BYTES
        or (expected_sha is not None and expected_sha != digest)
        or (expected_size is not None and expected_size != len(content))
    ):
        raise ValueError("保存type1の全bytes/SHA/サイズが不一致")
    if metadata is not None and "_fileManifest" in metadata:
        if key.endswith(":type1") and len(metadata["_fileManifest"]["files"]) != 1:
            raise ValueError("typed保存type1のmanifestに別原本が混在している")
        entries = [
            m for m in metadata["_fileManifest"]["files"] if m.get("originalFilename") == filename
        ]
        if (
            len(entries) != 1
            or entries[0].get("sha256") != digest
            or entries[0].get("byteLength") != len(content)
        ):
            raise ValueError("保存type1の原manifestが不一致")
    artifact = save_raw(
        content,
        source=Source.EDINET,
        datatype="xbrl",
        scope=code,
        data_date=data_date,
        url=url,
        ext="zip",
        license_tag=LicenseTag.COMMERCIAL_OK,
        base_dir=settings.raw_data_dir,
        doc_id=doc_id,
    )
    artifact.fetched_at = fetched_at
    logger.info(
        "保存type1再利用: docID=%s priorSHAAvailable=%s bytes=%d",
        doc_id,
        expected_sha is not None,
        len(content),
    )
    return artifact
