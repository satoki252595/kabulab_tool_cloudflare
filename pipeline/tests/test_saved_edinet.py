"""保存type1の一意性/来歴/全SHA/元時計。外部通信を行わない。"""

import json
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path

import pytest

from jp_stock_pipeline.config import ConfigError, load_settings
from jp_stock_pipeline.notion import saved_edinet as saved

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = json.loads((Path(__file__).parent / "fixtures/direct-roa-table/provenance.json").read_text())[0]
DOC = EVIDENCE["docID"]
CODE = EVIDENCE["code"]


def text(value, kind="rich_text"):
    return {"type": kind, kind: [{"type": "text", "plain_text": value, "text": {"content": value}}]}


def canonical():
    s = saved.S
    return {"object": "page", "id": "canonical", "archived": False, "in_trash": False,
            "parent": {"type": "database_id", "database_id": "raw-db"}, "properties": {
                s.RAW_PROP_FILENAME: text(DOC + "_xbrl.zip", "title"),
                s.RAW_PROP_URL: {"type": "url", "url": EVIDENCE["url"]},
                s.RAW_PROP_DATATYPE: text("xbrl"), s.RAW_PROP_SCOPE: text(CODE),
                s.PROP_SOURCE: {"select": {"name": "EDINET"}},
                s.PROP_LICENSE_TAG: {"select": {"name": "commercial-ok"}},
                s.RAW_PROP_SHA256: text(EVIDENCE["fullZIPSHA256"]),
                s.RAW_PROP_SIZE: {"number": EVIDENCE["fullZIPBytes"]},
                s.RAW_PROP_FILES: {"files": [{"name": DOC + "_xbrl.zip", "type": "file", "file": {"url": "https://files.example/type1"}}]},
                s.PROP_FETCHED_AT: {"date": {"start": EVIDENCE["sourceFetchedAt"]}},
            }}


class Client:
    def __init__(self, rows, content=None, failure=None):
        self.rows, self.content, self.failure = rows, content, failure
        self.downloads = 0

    def query_database(self, *args, **kwargs):
        if self.failure:
            raise self.failure
        return self.rows

    def list_child_blocks(self, *args):
        raise AssertionError("canonical既存・不正時に旧保存へ代替しない")

    def download_file(self, url, *, max_bytes):
        assert max_bytes == saved.MAX_ZIP_BYTES
        self.downloads += 1
        return self.content


def settings(tmp_path):
    return load_settings(env={"RAW_DATA_DIR": str(tmp_path), "NOTION_DB_RAW_FILES": "raw-db"})


def read(client, config):
    return saved.read_saved_type1(client, config, DOC, CODE, None,
                                 edinet_code=EVIDENCE["edinetCode"], fiscal_period_end=date.fromisoformat(EVIDENCE["fiscalYearEnd"]))


@pytest.mark.parametrize("failure", ["duplicate", "wrong-scope", "wrong-sha-shape", "wrong-clock", "archived", "read-error"])
def test_saved_lookup_errors_never_download_or_change_source(tmp_path, failure):
    page = deepcopy(canonical())
    if failure == "wrong-scope":
        page["properties"][saved.S.RAW_PROP_SCOPE] = text("")
    elif failure == "wrong-sha-shape":
        page["properties"][saved.S.RAW_PROP_SHA256] = text("")
    elif failure == "wrong-clock":
        page["properties"][saved.S.PROP_FETCHED_AT]["date"]["start"] = "2026-06-19"
    elif failure == "archived":
        page["archived"] = True
    client = Client([page, page] if failure == "duplicate" else [page], failure=ValueError("read unknown") if failure == "read-error" else None)
    with pytest.raises(ValueError):
        read(client, settings(tmp_path))
    assert client.downloads == 0
    assert list(tmp_path.iterdir()) == []


def test_missing_archive_config_stops_before_official_retrieval(tmp_path):
    with pytest.raises(ConfigError, match="NOTION_ARCHIVE_PAGE_ID"):
        read(Client([]), settings(tmp_path))


def test_actual_saved_complete_zip_full_sha_and_original_clock_are_preserved(tmp_path):
    path = ROOT / "tmp/feature-audit-20261013/direct-roa-saved-type1-legacy-v2" / f"{CODE}-{DOC}.zip"
    if not path.is_file():
        pytest.skip("全保存type1 ZIP不在。機械切出しを全原本の代用にしない")
    client = Client([canonical()], path.read_bytes())
    result = read(client, settings(tmp_path))
    assert result is not None and client.downloads == 1
    assert result.sha256 == EVIDENCE["fullZIPSHA256"]
    assert result.local_path.read_bytes() == path.read_bytes()
    assert result.fetched_at == datetime.fromisoformat(EVIDENCE["sourceFetchedAt"])
    assert result.doc_id == DOC and result.datatype == "xbrl"


class LegacyClient(Client):
    def __init__(self, rows):
        super().__init__(rows)
        self.keys = []

    def list_child_blocks(self, parent):
        assert parent == "archive-parent"
        return [{"id": "legacy-db", "type": "child_database", "child_database": {"title": "一次データ｜yuho-quant"}}]

    def query_database(self, database, *, filter, **kwargs):
        if database == "raw-db":
            return []
        key = filter["title"]["equals"]
        self.keys.append(key)
        return [] if key.endswith(":type1") else self.rows


def test_only_explicit_zero_in_both_saved_key_contracts_is_a_cache_miss(tmp_path):
    config = settings(tmp_path)
    config.notion_archive_page_id = "archive-parent"
    client = LegacyClient([])
    assert read(client, config) is None
    assert client.keys == [DOC + ":type1", DOC]
    assert client.downloads == 0


@pytest.mark.parametrize("field", ["docID", "secCode", "edinetCode", "periodEnd"])
def test_legacy_metadata_identity_error_stops_before_hosted_get(tmp_path, field):
    metadata = {"docID": DOC, "secCode": CODE + "0", "edinetCode": EVIDENCE["edinetCode"], "periodEnd": EVIDENCE["fiscalYearEnd"]}
    metadata[field] = ""
    page = {"object": "page", "id": "legacy", "archived": False, "in_trash": False,
            "parent": {"type": "database_id", "database_id": "legacy-db"},
            "properties": {"Key": text(DOC, "title"), "Metadata": text(json.dumps(metadata))}}
    config = settings(tmp_path)
    config.notion_archive_page_id = "archive-parent"
    client = LegacyClient([page])
    with pytest.raises(ValueError, match="metadata"):
        read(client, config)
    assert client.downloads == 0
