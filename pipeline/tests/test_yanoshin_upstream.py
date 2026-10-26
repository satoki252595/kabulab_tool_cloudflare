"""やのしん鮮度の共有ケース。期待値は src/shared/yanoshin-upstream-freshness.json。"""

from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime
from pathlib import Path

import pytest

from jp_stock_pipeline.collectors.yanoshin_upstream import (
    judge_yanoshin_upstream,
    newest_pubdate_in_payload,
    probe_yanoshin_newest,
)
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.jobs import runner, tdnet_hourly as hourly
from jp_stock_pipeline.jobs.runner import JobContext
from jp_stock_pipeline.models import JST
from jp_stock_pipeline.notion.client import NotionClient

_SPEC_PATH = Path(__file__).resolve().parents[2] / "src/shared/yanoshin-upstream-freshness.json"
_SPEC = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))


def test_thresholds_stay_at_the_documented_contract():
    assert _SPEC["watchOpenHourJst"] == 9
    assert _SPEC["watchCloseHourJst"] == 19
    assert _SPEC["maxWatchSilenceSeconds"] == 14400


@pytest.mark.parametrize("case", _SPEC["cases"], ids=[case["id"] for case in _SPEC["cases"]])
def test_shared_freshness_cases(case):
    now = datetime.fromisoformat(case["now"])
    newest = None if case["newest"] is None else datetime.fromisoformat(case["newest"])
    got = judge_yanoshin_upstream(newest, now)
    assert got.judgement == case["judgement"]
    assert got.elapsed_watch_seconds == case["elapsedWatchSeconds"]
    assert got.newest_pubdate == case["newest"]


def test_payload_pubdate_max_and_malformed_stop():
    payload = {
        "items": [
            {"pubdate": "2026-10-23 18:00:00"},
            {"Tdnet": {"pubdate": "2026-10-24 13:15:00"}},
            {"title": "pubdate なし"},
        ]
    }
    assert newest_pubdate_in_payload(payload) == datetime(2026, 10, 24, 13, 15, tzinfo=JST)
    with pytest.raises(ValueError, match="形式が不正"):
        newest_pubdate_in_payload({"items": [{"pubdate": "10/24"}]})


def test_probe_reads_recent_payload(monkeypatch, tmp_path):
    import types

    body = {"items": [{"Tdnet": {"pubdate": "2026-10-24 13:15:00"}}, {"pubdate": "2026-10-23 09:00:00"}]}
    path = tmp_path / "recent.json"
    path.write_text(json.dumps(body), encoding="utf-8")

    def fake_list(settings, target="recent", limit=300, **kwargs):
        assert target == "recent" and limit == 30
        return types.SimpleNamespace(local_path=path), []

    monkeypatch.setattr(
        "jp_stock_pipeline.collectors.tdnet_yanoshin.list_disclosures", fake_list
    )
    settings = load_settings(env={"RAW_DATA_DIR": str(tmp_path)}, dry_run=True)
    assert probe_yanoshin_newest(settings) == datetime(2026, 10, 24, 13, 15, tzinfo=JST)


def _ctx(raw: str, day) -> JobContext:
    ctx = JobContext(
        settings=load_settings(env={"RAW_DATA_DIR": raw}, dry_run=True),
        client=NotionClient(None, rps=1000.0, dry_run=True),
        args=argparse.Namespace(date=day, limit=None),
    )
    ctx.upload_raw = lambda artifact, **kw: "raw-page-id"  # noqa: ARG005
    return ctx


@pytest.mark.parametrize(
    ("case_id", "target"),
    [
        ("monday-morning-after-healthy-friday", "2026-10-26"),
        ("weekend-healthy", "2026-10-25"),
        ("holiday-sports-day", "2026-10-12"),
        ("night-before-open", "2026-10-08"),
        ("closure-year-end", "2026-12-31"),
        ("after-hours-pubdate-over-weekend", "2026-10-24"),
    ],
)
def test_fresh_upstream_empty_day_stays_verified_zero(monkeypatch, tmp_path, caplog, case_id, target):
    """上流が fresh で、その pubdate が対象日に無ければ空一覧は 0 件成功。"""
    case = next(row for row in _SPEC["cases"] if row["id"] == case_id)
    now = datetime.fromisoformat(case["now"])
    newest = datetime.fromisoformat(case["newest"])
    monkeypatch.setattr(hourly, "now_jst", lambda: now)
    monkeypatch.setattr(hourly, "probe_yanoshin_newest", lambda *a, **k: newest)
    path = tmp_path / "list.json"
    path.write_text('{"items":[]}', encoding="utf-8")
    artifact = type("A", (), {"local_path": path})()
    monkeypatch.setattr(hourly, "_collect", lambda *a: [(artifact, [], {})])
    ctx = _ctx(str(tmp_path), datetime.fromisoformat(target).date())
    with caplog.at_level(logging.INFO):
        hourly.execute(ctx)
    assert ctx.verified_zero_status == runner.STATUS_OBSERVED_EMPTY
    assert "judgement=fresh" in caplog.text
    assert f"newest_pubdate={case['newest']}" in caplog.text


def test_empty_day_whose_newest_pubdate_is_that_day_is_not_zero(monkeypatch, tmp_path):
    now = datetime(2026, 10, 26, 15, 0, tzinfo=JST)
    newest = datetime(2026, 10, 26, 14, 50, tzinfo=JST)
    monkeypatch.setattr(hourly, "now_jst", lambda: now)
    monkeypatch.setattr(hourly, "probe_yanoshin_newest", lambda *a, **k: newest)
    path = tmp_path / "list.json"
    path.write_text('{"items":[]}', encoding="utf-8")
    monkeypatch.setattr(
        hourly, "_collect", lambda *a: [(type("A", (), {"local_path": path})(), [], {})]
    )
    ctx = _ctx(str(tmp_path), now.date())
    with pytest.raises(hourly.YanoshinUpstreamStopped, match="upstream stopped"):
        hourly.execute(ctx)
    assert ctx.verified_zero_status is None
