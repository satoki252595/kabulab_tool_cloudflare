"""JS schedulerと同じ公式現物市場休業日。年次範囲外は推測せず停止する。"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

# pipelineはこのmono-repoのnix環境で実行する。正本を言語ごとに複製しない。
_CALENDAR = json.loads((Path(__file__).resolve().parents[4] / "src/shared/market-calendar.json").read_text())


def is_session_day(day: date, markets: tuple[str, ...] = ("JPX",)) -> bool:
    open_day = day.weekday() < 5
    for market in markets:
        source = _CALENDAR["markets"][market]
        holidays = source["years"].get(str(day.year))
        if holidays is None:
            raise ValueError(f"{market}の公式休業日が未収録: {day}")
        if day.strftime("%m-%d") in holidays:
            open_day = False
    return open_day


def latest_session_date(day: date, markets: tuple[str, ...] = ("JPX",)) -> date:
    while not is_session_day(day, markets):
        day -= timedelta(days=1)
    return day
