"""実FSA ZIP + 通信境界double。合成金融値・本番通信は使わない。"""

import hashlib
import json
from copy import deepcopy
from datetime import date
from pathlib import Path

import pytest

from jp_stock_pipeline.collectors import edinet_codelist
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.notion import saved_edinet as saved

BODY = (Path(__file__).parent / "fixtures/edinet/Edinetcode.zip").read_bytes()
SHA = hashlib.sha256(BODY).hexdigest()


def text(value, kind="rich_text"):
    return {"type": kind, kind: [{"type": "text", "plain_text": value, "text": {"content": value}}]}


def canonical():
    s = saved.S
    return {
        "object": "page",
        "id": "canonical",
        "archived": False,
        "in_trash": False,
        "parent": {"type": "database_id", "database_id": "raw-db"},
        "properties": {
            s.RAW_PROP_FILENAME: text("Edinetcode.zip", "title"),
            s.RAW_PROP_URL: {"url": edinet_codelist.CODELIST_URL},
            s.PROP_SOURCE: {"select": {"name": "EDINET"}},
            s.PROP_LICENSE_TAG: {"select": {"name": "commercial-ok"}},
            s.RAW_PROP_DATATYPE: text("codelist"),
            s.RAW_PROP_SCOPE: text("ALL"),
            s.PROP_FETCHED_AT: {"date": {"start": "2026-06-10T23:30:00+09:00"}},
            s.RAW_PROP_SHA256: text(SHA),
            s.RAW_PROP_SIZE: {"number": len(BODY)},
            s.RAW_PROP_FILES: {
                "files": [
                    {
                        "name": "Edinetcode.zip",
                        "type": "file",
                        "file": {"url": "https://files.example/codelist"},
                    }
                ]
            },
        },
    }


class Client:
    def __init__(self, rows, universe=None, body=BODY):
        self.rows, self.universe, self.body = rows, universe, body
        self.downloads = 0

    def query_database(self, db, **kwargs):
        assert kwargs["page_size"] == 2 and kwargs["max_pages"] == 1 and kwargs["strict"]
        return self.rows if db == "raw-db" else self.universe

    def list_child_blocks(self, _):
        return (
            []
            if self.universe is None
            else [
                {
                    "id": "universe-db",
                    "type": "child_database",
                    "child_database": {"title": "一次データ｜universe"},
                }
            ]
        )

    def download_file(self, _, *, max_bytes):
        assert max_bytes == len(BODY)
        self.downloads += 1
        return self.body


def read(client, tmp_path, not_before=date(2026, 6, 10)):
    settings = load_settings(
        env={
            "RAW_DATA_DIR": str(tmp_path),
            "NOTION_DB_RAW_FILES": "raw-db",
            "NOTION_ARCHIVE_PAGE_ID": "archive-parent",
        }
    )
    return saved.read_saved_codelist(client, settings, not_before=not_before)


def test_saved_complete_zip_and_clock_reused_without_source_fetch(tmp_path):
    client = Client([canonical()])
    result = read(client, tmp_path)
    assert result.sha256 == SHA and result.local_path.read_bytes() == BODY
    assert result.data_date == date(2026, 6, 10) and result.notion_page_id == "canonical"
    assert result.fetched_at.isoformat() == "2026-06-10T23:30:00+09:00"
    assert client.downloads == 1


def test_missing_or_old_generation_does_not_download(tmp_path):
    for client in [Client([]), Client([canonical()])]:
        assert read(client, tmp_path, date(2026, 6, 11)) is None
        assert client.downloads == 0


@pytest.mark.parametrize("fault", ["same_clock", "wrong_order", "bad_sha", "wrong_scope", "body_mismatch"])
def test_invalid_latest_never_selects_older_or_refetches(tmp_path, fault):
    page = canonical()
    if fault == "bad_sha":
        page["properties"][saved.S.RAW_PROP_SHA256] = text("")
    if fault == "wrong_scope":
        page["properties"][saved.S.RAW_PROP_SCOPE] = text("3814")
    second = deepcopy(page)
    if fault == "wrong_order":
        second["properties"][saved.S.PROP_FETCHED_AT]["date"]["start"] = "2026-06-11T23:30:00+09:00"
    client = Client(
        [page, second] if fault in ("same_clock", "wrong_order") else [page],
        body=BODY[:-1] if fault == "body_mismatch" else BODY,
    )
    with pytest.raises(ValueError):
        read(client, tmp_path)
    assert client.downloads == (1 if fault == "body_mismatch" else 0)
    assert list(tmp_path.iterdir()) == []


def test_shared_universe_original_can_be_reused(tmp_path):
    raw = canonical()
    page = {
        **raw,
        "id": "universe",
        "parent": {"type": "database_id", "database_id": "universe-db"},
        "properties": {
            "Source": text(edinet_codelist.CODELIST_URL),
            "Service": {"select": {"name": "universe"}},
            "Status": {"select": {"name": "recorded"}},
            "Fetched At": raw["properties"][saved.S.PROP_FETCHED_AT],
            "Files": raw["properties"][saved.S.RAW_PROP_FILES],
            "Metadata": text(
                json.dumps(
                    {
                        "bytes": len(BODY),
                        "sha256": SHA,
                        "_fileManifest": {
                            "version": 1,
                            "files": [
                                {
                                    "originalFilename": "Edinetcode.zip",
                                    "uploadFilename": "Edinetcode.zip",
                                    "upload": "uploaded",
                                    "sha256": SHA,
                                    "byteLength": len(BODY),
                                }
                            ],
                        },
                    }
                )
            ),
        },
    }
    result = read(Client([], [page]), tmp_path)
    assert result.sha256 == SHA and result.notion_page_id == "universe"
