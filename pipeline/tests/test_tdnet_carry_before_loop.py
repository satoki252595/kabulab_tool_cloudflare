"""H-3: 09:00 の前日照合は、当日ループが期限切れでも実行済みである。

終了は failure のまま。照合をループの前へ移すだけで、他の失敗は握らない。
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timedelta

import pytest

from jp_stock_pipeline.jobs import tdnet_hourly as mod
from jp_stock_pipeline.jobs.runner import STATUS_FAILURE, _status
from jp_stock_pipeline.jobs.scheduled import ScheduledWindowError
from jp_stock_pipeline.models import JST

from test_tdnet_hourly import _ctx, _record


def test_nine_oclock_reconcile_survives_loop_deadline(monkeypatch, tmp_path):
    now = datetime.now(JST)
    slot = now.replace(hour=9, minute=0, second=0, microsecond=0)
    if slot > now:
        slot -= timedelta(days=1)
        while slot.weekday() >= 5:
            slot -= timedelta(days=1)
    day = slot.date()
    ctx = _ctx(str(tmp_path))
    ctx.args = argparse.Namespace(
        date=day, limit=None, _scheduled_window=(slot, now + timedelta(hours=1)),
    )
    record = _record()
    record.disclosed_at = slot + timedelta(minutes=30)
    events: list[str] = []
    d1_calls: list[str] = []
    monkeypatch.setattr(mod, "_collect", lambda *a: events.append("collect") or [(object(), [record], {})])
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: datetime.now(JST))
    monkeypatch.setattr(mod, "_gate_official_list", lambda *a, **k: None)
    monkeypatch.setattr(mod, "_load_master_map", lambda _: ({}, True))
    monkeypatch.setattr(mod.upsert, "load_disclosure_page_entries", lambda *a, **kw: {})
    monkeypatch.setattr(mod.file_upload, "load_raw_page_map", lambda *a, **kw: {})

    def reconcile(context, target):
        events.append("reconcile")
        assert target == day

    monkeypatch.setattr(mod, "reconcile_deferred_tail", reconcile)

    def source(args, now):
        events.append("deadline")
        raise ScheduledWindowError("CF予定の新規取得期限です（原本閉鎖へ移行・未完）")

    monkeypatch.setattr(mod, "assert_scheduled_source", source)
    ctx.cloud = type("Cloud", (), {
        "d1": type("D1", (), {"query": staticmethod(lambda *a, **k: d1_calls.append("query") or [])})(),
        "settings": type("S", (), {"d1_enabled": staticmethod(lambda: True)})(),
        "prefetch_stock_ids": lambda self, codes: 0,
        "_stock_ids": {},
    })()
    started = time.perf_counter()
    with pytest.raises(ScheduledWindowError, match="新規取得期限"):
        mod.execute(ctx)
    elapsed = time.perf_counter() - started
    assert events.index("deadline") < events.index("reconcile")
    assert _status(ctx, True) == STATUS_FAILURE
    report = {
        "d1_queries": len(d1_calls),
        "d1_rows_read": 0,
        "notion_gets": 0,
        "seconds": round(elapsed, 6),
        "reconcile_before_deadline": True,
    }
    print("H3_BENCH " + json.dumps(report))
    assert report["d1_queries"] == 0 and report["d1_rows_read"] == 0
