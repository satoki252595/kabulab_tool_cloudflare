"""CFが渡す予定slotを対象日へ束縛し、新規取得・次の保存単位を有界にする。"""

from __future__ import annotations

import argparse
import logging
import re
from datetime import date, datetime, time, timedelta, timezone

from ..models import JST

logger = logging.getLogger(__name__)


class ScheduledWindowError(ValueError):
    """不正な予定または実行窓外。原本・値の補完や自動再送は行わない。"""


def add_scheduled_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--scheduled-at", default=None, help="CFの予定UTC時刻 YYYY-MM-DDTHH:mm:00Z")


def _jst(now: datetime) -> datetime:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ScheduledWindowError("予定実行にはタイムゾーン付き実時刻が必要です")
    return now.astimezone(JST)


def scheduled_target(job: str, args: argparse.Namespace, now: datetime) -> date | None:
    """手動入口は維持。CF予定はslot・曜日・明示日・開始窓を取得前に検証する。"""
    value = getattr(args, "scheduled_at", None)
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z", value):
        raise ScheduledWindowError("scheduled_atのUTC予定slotが不正です")
    try:
        slot = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone(JST)
    except ValueError as exc:
        raise ScheduledWindowError("scheduled_atの暦日・時刻が不正です") from exc
    if slot.weekday() >= 5:
        raise ScheduledWindowError("予定slotは平日のみです（日本の休場日は推測しません）")
    if job == "tdnet_hourly" and slot.minute == 0 and 9 <= slot.hour <= 19:
        last_start = slot + timedelta(hours=1)
        deadline = slot + timedelta(minutes=90)
    elif job == "supply_daily" and (slot.hour, slot.minute) == (12, 17):
        last_start = datetime.combine(slot.date(), time(22), JST)
        deadline = datetime.combine(slot.date(), time(23), JST)
    elif job == "edinet_daily" and (slot.hour, slot.minute) == (21, 0):
        next_day = slot.date() + timedelta(days=1)
        last_start = datetime.combine(next_day, time(19), JST)
        deadline = datetime.combine(next_day, time(21), JST)
    else:
        raise ScheduledWindowError("jobと予定slotが一致しません")
    explicit = getattr(args, "date", None)
    if explicit is not None and explicit != slot.date():
        raise ScheduledWindowError("--dateとCF予定のJST対象日が一致しません")
    if not slot <= _jst(now) < last_start:
        raise ScheduledWindowError("予定実行の開始窓外です（未取得を成功扱いしません）")
    args._scheduled_window = (slot, deadline)
    logger.info("CF予定: job=%s slot=%s 対象日=%s 新規I/O締切=%s", job, value, slot.date(), deadline.isoformat())
    return slot.date()


def assert_scheduled_io(args: argparse.Namespace, now: datetime) -> None:
    """開始済み取得の原本保管は維持し、窓外の新取得・次の保存単位を止める。"""
    window = getattr(args, "_scheduled_window", None)
    if window is not None and not window[0] <= _jst(now) < window[1]:
        raise ScheduledWindowError("CF予定の新規I/O締切に到達したため中止します")
