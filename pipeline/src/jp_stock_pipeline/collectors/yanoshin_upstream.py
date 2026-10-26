"""やのしん TDnet の最新 pubdate が、いまの監視窓に対して生きているか。

閾値とテストケースの正は ``src/shared/yanoshin-upstream-freshness.json``。
TypeScript ``src/shared/yanoshin-upstream.ts`` と同じファイルを読む。
セッション日は ``contracts/market_calendar.py``（JPX 公式休業日。土日・祝日・
年末休業）。未収録年は推測せず停止する。

監視窓は JST 9:00 以上 19:00 未満。窓の外は経過に足さない。許容沈黙を
超えたら upstream_stopped。pubdate が 1 件も無ければ休場でも fresh にしない。
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from pathlib import Path

from ..config import Settings
from ..contracts.market_calendar import is_session_day
from ..models import JST

_SPEC_PATH = Path(__file__).resolve().parents[4] / "src/shared/yanoshin-upstream-freshness.json"
_SPEC = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))


def _required_int(key: str) -> int:
    value = _SPEC.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise RuntimeError(f"やのしん鮮度定義 {key} が整数でありません")
    return value


WATCH_OPEN_HOUR = _required_int("watchOpenHourJst")
WATCH_CLOSE_HOUR = _required_int("watchCloseHourJst")
MAX_WATCH_SILENCE_SECONDS = _required_int("maxWatchSilenceSeconds")
if not (0 <= WATCH_OPEN_HOUR < WATCH_CLOSE_HOUR <= 24):
    raise RuntimeError("やのしん鮮度定義の監視窓が不正です")
if MAX_WATCH_SILENCE_SECONDS <= 0:
    raise RuntimeError("やのしん鮮度定義の許容沈黙が不正です")


class YanoshinUpstreamStopped(RuntimeError):
    """最新 pubdate が監視窓の許容を超えている。0 件成功にはしない。"""


@dataclass(frozen=True)
class UpstreamJudgement:
    newest_pubdate: str | None
    elapsed_watch_seconds: int | None
    judgement: str


def _aware(moment: datetime) -> datetime:
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("やのしん鮮度判定にはタイムゾーン付き時刻が必要です")
    return moment.astimezone(JST)


def format_jst_iso(moment: datetime) -> str:
    return _aware(moment).replace(microsecond=0).isoformat()


def elapsed_watch_seconds(newest: datetime, now: datetime) -> int:
    """newest から now まで、JPX セッション日の [open, close) に入る秒。

    newest が now より未来なら 0。pubdate 欠落は呼び出し側が別に扱う。
    """
    newest_jst = _aware(newest)
    now_jst = _aware(now)
    if newest_jst > now_jst:
        return 0
    total = 0
    day = newest_jst.date()
    last = now_jst.date()
    while day <= last:
        if is_session_day(day, ("JPX",)):
            open_at = datetime.combine(day, time(WATCH_OPEN_HOUR, 0), tzinfo=JST)
            close_at = datetime.combine(day, time(WATCH_CLOSE_HOUR, 0), tzinfo=JST)
            start = newest_jst if newest_jst > open_at else open_at
            end = now_jst if now_jst < close_at else close_at
            if end > start:
                total += int((end - start).total_seconds())
        day += timedelta(days=1)
    return total


def judge_yanoshin_upstream(newest: datetime | None, now: datetime) -> UpstreamJudgement:
    _aware(now)
    if newest is None:
        return UpstreamJudgement(None, None, "upstream_stopped")
    elapsed = elapsed_watch_seconds(newest, now)
    judgement = "upstream_stopped" if elapsed > MAX_WATCH_SILENCE_SECONDS else "fresh"
    return UpstreamJudgement(format_jst_iso(newest), elapsed, judgement)


def format_yanoshin_upstream_log(
    judgement: UpstreamJudgement, *, judgement_name: str | None = None
) -> str:
    shown = judgement.judgement if judgement_name is None else judgement_name
    newest = judgement.newest_pubdate or "none"
    elapsed = "none" if judgement.elapsed_watch_seconds is None else str(judgement.elapsed_watch_seconds)
    return (
        f"yanoshin_upstream newest_pubdate={newest}"
        f" elapsed_watch_seconds={elapsed} judgement={shown}"
    )


def newest_pubdate_in_payload(payload: dict) -> datetime | None:
    """list JSON の pubdate 最大。無ければ None。壊れた pubdate は停止する。"""
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        raise ValueError("やのしん list の items が配列でない")
    newest: datetime | None = None
    for item in items:
        body = item.get("Tdnet") if isinstance(item, dict) and isinstance(item.get("Tdnet"), dict) else item
        if not isinstance(body, dict):
            raise ValueError("やのしん list の item が object でない")
        raw = body.get("pubdate")
        if raw is None:
            continue
        if not isinstance(raw, str):
            raise ValueError("やのしん pubdate が文字列でない")
        try:
            stamp = datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)
        except ValueError as exc:
            raise ValueError(f"やのしん pubdate の形式が不正: {raw}") from exc
        if newest is None or stamp > newest:
            newest = stamp
    return newest


def probe_yanoshin_newest(
    settings: Settings,
    *,
    before_request: Callable[[], None] | None = None,
) -> datetime | None:
    """recent 一覧の最新 pubdate。空なら None（呼び出し側が stopped にする）。"""
    from .tdnet_yanoshin import list_disclosures

    kwargs = {} if before_request is None else {"before_request": before_request}
    artifact, _records = list_disclosures(settings, "recent", limit=30, **kwargs)
    payload = json.loads(artifact.local_path.read_bytes())
    return newest_pubdate_in_payload(payload)
