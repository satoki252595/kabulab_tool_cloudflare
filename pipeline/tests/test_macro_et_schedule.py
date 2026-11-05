"""INC-20261008 定時マクロの期限を America/New_York から計算する。

L = 16:15 ET + 45分 = 17:00 ET。保存期限と日付切替は L+60。
夏は 22:00 UTC、冬は 23:00 UTC。早期終了（regular.end 13:00 ET）でも
L は 13:45 に進めない。TS の scheduledMacroWindow と同じ瞬間を固定する。
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from jp_stock_pipeline.jobs import ops_check

ET = ZoneInfo("America/New_York")


def _window(day: date):
    schedule = getattr(ops_check, "macro_schedule", None)
    assert callable(schedule), "macro_schedule が未実装"
    return schedule(day)


def _assert_window(day: date, start: datetime) -> None:
    window = _window(day)
    assert window["start"] == start
    assert window["latest_start"] - window["start"] == timedelta(minutes=30)
    assert window["source_deadline"] - window["start"] == timedelta(minutes=50)
    assert window["deadline"] - window["start"] == timedelta(minutes=60)
    assert window["readcheck"] - window["start"] == timedelta(minutes=65)
    assert window["date_switch"] == window["deadline"]
    local = window["start"].astimezone(ET)
    assert local.date() == day
    assert (local.hour, local.minute) == (17, 0)


class TestSummerWeekday:
    def test_17et_is_21utc_and_date_switches_at_22utc(self) -> None:
        _assert_window(date(2026, 7, 15), datetime(2026, 7, 15, 21, 0, tzinfo=UTC))
        assert ops_check.expected_macro_date(datetime(2026, 7, 15, 21, 59, tzinfo=UTC)) == date(2026, 7, 14)
        assert ops_check.expected_macro_date(datetime(2026, 7, 15, 22, 0, tzinfo=UTC)) == date(2026, 7, 15)


class TestWinterWeekday:
    def test_before_18et_is_previous_joint_session(self) -> None:
        # 22:30 UTC = 17:30 EST。旧 hour>=22 は 11/4 を要求する。11/3 は JPX 休場。
        assert ops_check.expected_macro_date(datetime(2026, 11, 4, 22, 30, tzinfo=UTC)) == date(2026, 11, 2)

    def test_at_18et_requires_that_session(self) -> None:
        assert ops_check.expected_macro_date(datetime(2026, 11, 4, 23, 0, tzinfo=UTC)) == date(2026, 11, 4)

    def test_window_is_22utc(self) -> None:
        _assert_window(date(2026, 11, 4), datetime(2026, 11, 4, 22, 0, tzinfo=UTC))


class TestDstAdjacentDays:
    @pytest.mark.parametrize(
        ("moment", "expected"),
        [
            (datetime(2026, 10, 30, 21, 59, tzinfo=UTC), date(2026, 10, 29)),
            (datetime(2026, 10, 30, 22, 0, tzinfo=UTC), date(2026, 10, 30)),
            (datetime(2026, 11, 2, 22, 30, tzinfo=UTC), date(2026, 10, 30)),
            (datetime(2026, 11, 2, 23, 0, tzinfo=UTC), date(2026, 11, 2)),
            (datetime(2026, 3, 6, 22, 30, tzinfo=UTC), date(2026, 3, 5)),
            (datetime(2026, 3, 6, 23, 0, tzinfo=UTC), date(2026, 3, 6)),
            (datetime(2026, 3, 9, 21, 59, tzinfo=UTC), date(2026, 3, 6)),
            (datetime(2026, 3, 9, 22, 0, tzinfo=UTC), date(2026, 3, 9)),
        ],
    )
    def test_date_switch_follows_et(self, moment: datetime, expected: date) -> None:
        assert ops_check.expected_macro_date(moment) == expected

    def test_transition_sundays_use_the_offset_in_effect_at_17et(self) -> None:
        _assert_window(date(2026, 11, 1), datetime(2026, 11, 1, 22, 0, tzinfo=UTC))
        _assert_window(date(2026, 3, 8), datetime(2026, 3, 8, 21, 0, tzinfo=UTC))
        _assert_window(date(2026, 10, 30), datetime(2026, 10, 30, 21, 0, tzinfo=UTC))
        _assert_window(date(2026, 11, 2), datetime(2026, 11, 2, 22, 0, tzinfo=UTC))
        _assert_window(date(2026, 3, 6), datetime(2026, 3, 6, 22, 0, tzinfo=UTC))
        _assert_window(date(2026, 3, 9), datetime(2026, 3, 9, 21, 0, tzinfo=UTC))


class TestEarlyClose:
    """2026-11-27 は NYSE 早期終了（Yahoo regular.end 13:00 ET = 18:00 UTC）。"""

    def test_2230utc_is_before_the_1800et_deadline(self) -> None:
        # 17:30 EST。13:45+60分（19:45 UTC）では当日に切り替わるが、L は 17:00 のまま。
        # 11/26 は感謝祭で NYSE 休場なので直前の共通営業日は 11/25。
        assert ops_check.expected_macro_date(datetime(2026, 11, 27, 22, 30, tzinfo=UTC)) == date(2026, 11, 25)

    def test_2300utc_requires_the_early_close_session(self) -> None:
        assert ops_check.expected_macro_date(datetime(2026, 11, 27, 23, 0, tzinfo=UTC)) == date(2026, 11, 27)

    def test_window_stays_at_1700et_not_1345et(self) -> None:
        _assert_window(date(2026, 11, 27), datetime(2026, 11, 27, 22, 0, tzinfo=UTC))
        assert _window(date(2026, 11, 27))["start"] != datetime(2026, 11, 27, 18, 45, tzinfo=UTC)
