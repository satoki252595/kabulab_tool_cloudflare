"""予定slot・遅配・JST境界を固定する。上流取得・保存は実行しない。"""

import argparse
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from jp_stock_pipeline.jobs import edinet_daily, supply_daily, tdnet_hourly
from jp_stock_pipeline.jobs.scheduled import ScheduledWindowError, assert_scheduled_io, scheduled_target
from jp_stock_pipeline.models import JST

POLICIES = [
    ("tdnet_hourly", "2026-10-23T00:00:00Z", datetime(2026, 10, 23, 10, tzinfo=JST), datetime(2026, 10, 23, 10, 30, tzinfo=JST)),
    ("supply_daily", "2026-10-23T03:17:00Z", datetime(2026, 10, 23, 22, tzinfo=JST), datetime(2026, 10, 23, 23, tzinfo=JST)),
    ("edinet_daily", "2026-10-23T12:00:00Z", datetime(2026, 10, 24, 19, tzinfo=JST), datetime(2026, 10, 24, 21, tzinfo=JST)),
]


@pytest.mark.parametrize(("job", "slot", "last_start", "deadline"), POLICIES)
def test_slot_start_and_io_deadline_are_separate(job, slot, last_start, deadline):
    opening = datetime.fromisoformat(slot)
    args = argparse.Namespace(scheduled_at=slot, date=date(2026, 10, 23))
    assert scheduled_target(job, args, opening) == date(2026, 10, 23)
    assert scheduled_target(job, args, last_start - timedelta(microseconds=1)) == date(2026, 10, 23)
    assert_scheduled_io(args, deadline - timedelta(microseconds=1))
    for clock in [opening - timedelta(microseconds=1), last_start]:
        with pytest.raises(ScheduledWindowError, match="開始窓外"):
            scheduled_target(job, args, clock)
    for clock in [opening - timedelta(microseconds=1), deadline]:
        with pytest.raises(ScheduledWindowError, match="締切"):
            assert_scheduled_io(args, clock)


@pytest.mark.parametrize(("job", "slot"), [
    ("tdnet_hourly", "2026-10-23T11:00:00Z"),
    ("tdnet_hourly", "2026-10-23T00:01:00Z"),
    ("supply_daily", "2026-10-23T03:16:00Z"),
    ("edinet_daily", "2026-10-23T11:00:00Z"),
    ("tdnet_hourly", "2026-10-24T00:00:00Z"),
    ("tdnet_hourly", "2026-02-30T00:00:00Z"),
    ("tdnet_hourly", "2026-10-23T00:00:01Z"),
    ("tdnet_hourly", "2026-10-23T09:00:00+09:00"),
    ("unsupported", "2026-10-23T00:00:00Z"),
])
def test_invalid_calendar_weekday_slot_or_timezone_is_rejected(job, slot):
    with pytest.raises(ScheduledWindowError):
        scheduled_target(job, argparse.Namespace(scheduled_at=slot), datetime(2026, 10, 23, 9, tzinfo=JST))


def test_explicit_date_must_match_jst_slot_and_naive_clock_is_rejected():
    args = argparse.Namespace(scheduled_at="2026-10-23T00:00:00Z", date=date(2026, 10, 22))
    with pytest.raises(ScheduledWindowError, match="--date"):
        scheduled_target("tdnet_hourly", args, datetime(2026, 10, 23, 9, tzinfo=JST))
    args.date = None
    with pytest.raises(ScheduledWindowError, match="タイムゾーン"):
        scheduled_target("tdnet_hourly", args, datetime(2026, 10, 23, 9))
    manual = argparse.Namespace(date=date(2026, 10, 16))
    assert scheduled_target("tdnet_hourly", manual, datetime(2026, 10, 23, 9, tzinfo=JST)) is None
    assert_scheduled_io(manual, datetime(2026, 10, 24, 22, tzinfo=JST))


def test_delayed_edinet_uses_planned_day_after_utc_and_jst_midnight(monkeypatch):
    ctx = SimpleNamespace(args=argparse.Namespace(date=None, scheduled_at="2026-10-22T12:00:00Z"), client=None, settings=None)
    monkeypatch.setattr(edinet_daily, "now_jst", lambda: datetime(2026, 10, 23, 0, 30, tzinfo=timezone.utc))
    monkeypatch.setattr(edinet_daily.file_upload, "load_raw_page_map", lambda *a, **kw: {})
    source = Mock(side_effect=RuntimeError("source boundary"))
    monkeypatch.setattr(edinet_daily.edinet, "list_documents", source)
    with pytest.raises(RuntimeError, match="source boundary"):
        edinet_daily.execute(ctx)
    source.assert_called_once_with(None, date(2026, 10, 22))


@pytest.mark.parametrize("module", [supply_daily, tdnet_hourly, edinet_daily])
def test_late_or_future_admission_stops_before_any_source(module, monkeypatch):
    slots = {"supply_daily": "2026-10-23T03:17:00Z", "tdnet_hourly": "2026-10-23T00:00:00Z", "edinet_daily": "2026-10-23T12:00:00Z"}
    args = argparse.Namespace(date=None, scheduled_at=slots[module.JOB_NAME])
    ctx = SimpleNamespace(args=args)
    clock = datetime(2026, 10, 25, tzinfo=JST)
    monkeypatch.setattr(module, "now_jst", lambda: clock)
    with pytest.raises(ScheduledWindowError, match="開始窓外"):
        module.execute(ctx)


def test_expired_window_blocks_following_source_operations(monkeypatch):
    args = argparse.Namespace(scheduled_at="2026-10-23T03:17:00Z")
    scheduled_target("supply_daily", args, datetime(2026, 10, 23, 13, tzinfo=JST))
    ctx = SimpleNamespace(args=args)
    source = Mock(side_effect=AssertionError("source must not start"))
    monkeypatch.setattr(supply_daily, "now_jst", lambda: datetime(2026, 10, 23, 23, tzinfo=JST))
    monkeypatch.setattr(supply_daily.jsf, "fetch_csv", source)
    with pytest.raises(ScheduledWindowError):
        supply_daily._fetch_and_store(ctx, "zandaka", "zandaka")
    source.assert_not_called()
