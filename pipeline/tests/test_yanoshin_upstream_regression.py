"""INC-20261026: やのしんが止まった items:[] を検証済み0件成功にしない。

修正前は tdnet_hourly が confirm_zero_work し、ops_check が欠測 0 件とログする。
修正後は upstream stopped で失敗する。
"""

from __future__ import annotations

import argparse
import json
import logging
import types
from datetime import date, datetime

import pytest

from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.jobs import ops_check, tdnet_hourly as mod
from jp_stock_pipeline.jobs.runner import JobContext
from jp_stock_pipeline.models import JST
from jp_stock_pipeline.notion.client import NotionClient

# 2026-10-24 は土曜。公式 TDnet は 10/26 に 33 件あり、やのしんの最新は 13:15 のまま。
INCIDENT_NOW = datetime(2026, 10, 26, 15, 0, tzinfo=JST)
INCIDENT_NEWEST = datetime(2026, 10, 24, 13, 15, tzinfo=JST)


def _ctx(raw_data_dir: str) -> JobContext:
    settings = load_settings(env={"RAW_DATA_DIR": raw_data_dir}, dry_run=True)
    ctx = JobContext(
        settings=settings,
        client=NotionClient(None, rps=1000.0, dry_run=True),
        args=argparse.Namespace(date=date(2026, 10, 26), limit=None),
    )
    ctx.upload_raw = lambda artifact, **kw: "raw-page-id"  # noqa: ARG005
    return ctx


def test_hourly_stale_empty_listing_is_not_verified_zero(monkeypatch, tmp_path):
    """当日 items:[] かつ最新 pubdate が 10/24 13:15 なら 0 件成功にしない。"""
    monkeypatch.setattr(mod, "now_jst", lambda: INCIDENT_NOW)
    path = tmp_path / "list.json"
    path.write_text(json.dumps({"items": []}), encoding="utf-8")
    artifact = types.SimpleNamespace(local_path=path)
    monkeypatch.setattr(mod, "_collect", lambda *a: [(artifact, [], {})])
    # 修正後の当日プローブ。修正前の execute はこれを見ない。
    monkeypatch.setattr(
        mod, "probe_yanoshin_newest", lambda *a, **k: INCIDENT_NEWEST, raising=False
    )
    ctx = _ctx(str(tmp_path))

    with pytest.raises(Exception, match="upstream stopped"):
        mod.execute(ctx)
    assert ctx.verified_zero_status is None
    assert ctx.processed == 0 and ctx.failed == 0


def test_ops_check_stale_feed_does_not_report_zero_gaps():
    """一覧の最新が止まっていて欠測行が無くても、欠測 0 件とは言わない。"""
    from _doubles import SqliteD1

    from jp_stock_pipeline.cloud_store.schema import SCHEMA_STATEMENTS

    store = SqliteD1(
        ddl=(
            *SCHEMA_STATEMENTS,
            "CREATE TABLE core_stocks (id INTEGER PRIMARY KEY, code TEXT,"
            " is_active INTEGER DEFAULT 1, instrument_type TEXT)",
            "CREATE TABLE ir_disclosures (tdnet_id TEXT, pubdate INTEGER, notion_page_id TEXT)",
        )
    )
    # 公開から 3 日未満なので欠測窓には入らない。最新 pubdate 自体は古い。
    listed = [
        ops_check.TdnetListItem(
            tdnet_id="stale-feed",
            ticker="7203",
            disclosed_at=INCIDENT_NEWEST,
        )
    ]
    problems: list[str] = []
    ops_check._check_ir_universe_gap(
        store, problems, now=INCIDENT_NOW, listings=(listed, 0)
    )
    assert problems, "stale empty-gap feed was treated as success"
    text = " ".join(problems)
    assert "upstream stopped" in text
    assert "cannot judge" in text
    assert "newest_pubdate=2026-10-24T13:15:00+09:00" in text
    assert "elapsed_watch_seconds=21600" in text
    assert "judgement=upstream_stopped" in text


def test_fetch_window_of_empty_days_logs_upstream_stopped(monkeypatch, caplog):
    """40 日ぶん items:[] でも欠測判定の材料が揃ったことにしない。"""
    monkeypatch.setattr(ops_check.time, "sleep", lambda *_a, **_k: None)
    monkeypatch.setattr(
        ops_check,
        "fetch",
        lambda url, **kw: types.SimpleNamespace(content=b'{"items":[]}'),
    )
    with caplog.at_level(logging.INFO):
        items, unreadable = ops_check.fetch_tdnet_window_listings(INCIDENT_NOW)
    assert items == [] and unreadable == 0
    assert "yanoshin_upstream" in caplog.text
    assert "judgement=upstream_stopped" in caplog.text
    assert "newest_pubdate=none" in caplog.text
