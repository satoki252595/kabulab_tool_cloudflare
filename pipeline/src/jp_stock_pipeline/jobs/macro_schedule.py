"""定時マクロの時刻窓。TS の scheduledMacroWindow と同じ式。

L = 16:15 America/New_York + 45分 = 17:00 ET。
受付は L から 30 分、新規取得は L+50、保存と日付切替は L+60、readcheck は L+65。
夏は 21:00 UTC、冬は 22:00 UTC。DST の当日も zoneinfo のオフセットで決める。
早期終了（Yahoo regular.end が 13:00 ET）でも L は 13:45 に進めない。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import TypedDict
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
_VIX_REGULAR_END = (16, 15)
_LAG = timedelta(minutes=45)
_ADMISSION = timedelta(minutes=30)
_FETCH = timedelta(minutes=50)
_SAVE = timedelta(minutes=60)
_READCHECK = timedelta(minutes=65)


class MacroSchedule(TypedDict):
    start: datetime
    latest_start: datetime
    source_deadline: datetime
    deadline: datetime
    readcheck: datetime
    date_switch: datetime


def macro_schedule(day: date) -> MacroSchedule:
    """L = 16:15 ET + 45分。相対オフセットは固定。合わない壁時計は投げて埋めない。"""
    if isinstance(day, datetime) or not isinstance(day, date):
        raise ValueError(f"マクロ予定日が不正です: {day!r}")
    start = datetime(day.year, day.month, day.day, _VIX_REGULAR_END[0], _VIX_REGULAR_END[1], tzinfo=ET) + _LAG
    local = start.astimezone(ET)
    if local.date() != day or (local.hour, local.minute, local.second) != (17, 0, 0) or local.fold != 0:
        raise ValueError(
            f"America/New_York の {day.isoformat()} 17:00 を一意に変換できません: {local.isoformat()}"
        )
    return {
        "start": start,
        "latest_start": start + _ADMISSION,
        "source_deadline": start + _FETCH,
        "deadline": start + _SAVE,
        "readcheck": start + _READCHECK,
        "date_switch": start + _SAVE,
    }
