"""Macの日次実行receiptを既存R2で検査する。終了codeとデータpendingを混同しない。"""
from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from ..config import CloudStoreSettings
from ..models import JST
from .r2 import R2Store

logger = logging.getLogger(__name__)
POLICY = json.loads((Path(__file__).resolve().parents[4] / "src/shared/local-job-receipt.json").read_text())
FIELDS = {"version", "kind", "phase", "scheduledFor", "startedAt", "finishedAt", "revision", "acceptedRevision", "code", "signal", "retries"}
DATA_COUNTS = {"totalStocks", "selectedForTextCheck", "textChecked", "textUnchecked", "textMismatched", "textRepaired", "metadataRepaired", "remaining", "failures", "qualificationHeld"}
SHA = re.compile(r"^[0-9a-f]{40}$")


def _clock(value: Any) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
        raise ValueError("receipt時計の形式が不正")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def scheduled_for(kind: str, moment: datetime) -> datetime:
    """休日を除かず、JSTの直近20時/21時予定を求める。"""
    if moment.tzinfo is None:
        raise ValueError("判定時計のタイムゾーンが不明")
    scheduled = moment.astimezone(JST).replace(hour=POLICY["jobs"][kind]["localHour"], minute=0, second=0, microsecond=0)
    if scheduled > moment:
        scheduled -= timedelta(days=1)
    return scheduled.astimezone(UTC)


def judge_local_receipt(kind: str, payload: Any, expected_sha: str, now: datetime) -> str | None:
    """未完は期限までは未完のまま観測する。壊れた契約・時計は緑にしない。"""
    target = scheduled_for(kind, now)
    start_deadline = target + timedelta(minutes=POLICY["startGraceMinutes"])
    finish_deadline = target + timedelta(minutes=POLICY["completionMinutes"])
    if payload is None:
        logger.info("Mac %s: 開始receipt未取得（開始期限前なら完了未検証として待機）", kind)
        return None if now <= start_deadline else "開始receipt未取得"
    if not isinstance(payload, dict) or set(payload) not in (FIELDS, FIELDS | {"biztagData"}):
        return "receiptの必須項目/未知項目が不正"
    data = payload.get("biztagData")
    if "biztagData" in payload:
        if kind != "biztag" or payload["phase"] != "finished" or not isinstance(data, dict):
            return "補足の検査summaryのjob/phaseが不正"
        if set(data) != DATA_COUNTS | {"scope", "status", "wholeSupplementComplete"} or any(type(data[k]) is not int or data[k] < 0 for k in DATA_COUNTS):
            return "補足の検査summaryの項目/件数が不正"
        if data["scope"] not in ("explicit_codes", "daily_window") or data["status"] not in ("checked_scope_complete", "partial", "attention") or data["wholeSupplementComplete"] is not False:
            return "補足の検査summaryのscope/状態が不正"
        if (data["textChecked"] + data["textUnchecked"] != data["selectedForTextCheck"]
                or (data["scope"] == "daily_window" and data["selectedForTextCheck"] > data["totalStocks"])
                or data["textMismatched"] > data["textChecked"] or data["textRepaired"] > data["textMismatched"] or data["metadataRepaired"] > data["totalStocks"]):
            return "補足の検査summaryの件数が矛盾"
    if type(payload["version"]) is not int or payload["version"] != POLICY["version"] or payload["kind"] != kind or payload["phase"] not in ("running", "finished"):
        return "receipt版/job/phaseが不正"
    for key in ("revision", "acceptedRevision"):
        if not isinstance(payload[key], str) or SHA.fullmatch(payload[key]) is None:
            return "receiptのSHAが不正"
    if type(payload["retries"]) is not int or payload["retries"] != 0:
        return "receiptの再送回数が不正"
    code, signal = payload["code"], payload["signal"]
    if (code is not None and type(code) is not int) or (signal is not None and (not isinstance(signal, str) or re.fullmatch(r"SIG[A-Z0-9]+", signal) is None)) or (code is not None and signal is not None):
        return "receiptの終了code/signalが不正"
    try:
        scheduled, started = _clock(payload["scheduledFor"]), _clock(payload["startedAt"])
        finished = None if payload["finishedAt"] is None else _clock(payload["finishedAt"])
    except ValueError:
        return "receiptの時計が不正"
    if scheduled != scheduled_for(kind, started) or started > now or (finished is not None and (finished < started or finished > now)):
        return "receiptの予定/開始/終了時計が矛盾"
    if payload["phase"] == "running" and (finished is not None or code is not None or signal is not None):
        return "runningの終了状態が矛盾"
    if payload["phase"] == "finished" and finished is None:
        return "終了時計が無い"
    if scheduled != target:
        return None if now <= start_deadline and scheduled < target else "当該予定のreceipt未取得"
    if payload["revision"] != expected_sha or payload["acceptedRevision"] != expected_sha:
        return "実HEAD/accepted SHAが監視設定と不一致"
    if started < target or started > start_deadline:
        return "予定開始から5分の開始窓を逸脱"
    if payload["phase"] == "running":
        logger.info("Mac %s: 未完（終了期限まで観測中）", kind)
        return None if now <= finish_deadline else "30分の終了期限を超えて未完"
    if finished is None:
        return "終了時計が無い"
    if finished > finish_deadline:
        return "30分の終了窓を逸脱"
    if code != 0 or signal is not None:
        return "処理が非0/シグナル/結果不明で終了"
    if data is not None:
        logger.info("Mac biztag: 終了code0、本文検査 %d/%d（全母集団 %d）、本文修復 %d、メタ修復 %d、全補足完了は未証明",
                    data["textChecked"], data["selectedForTextCheck"], data["totalStocks"], data["textRepaired"], data["metadataRepaired"])
        if data["status"] != "checked_scope_complete" or any(data[k] > 0 for k in ("remaining", "failures", "qualificationHeld", "textUnchecked")):
            return (f"補足検査に残あり: 未処理{data['remaining']}・失敗{data['failures']}・保留{data['qualificationHeld']}・"
                    f"当夜scope未検査{data['textUnchecked']}")
    else:
        logger.info("Mac %s: 終了code0（旧receiptにはデータpending/処理件数の実測なし）", kind)
    return None


def check_local_job_receipts(settings: CloudStoreSettings, problems: list[str], *, now: datetime | None = None, store: R2Store | None = None) -> None:
    """既存ops通知に相乗りし、R2読取は通常2GETだけ。設定欠落も判定不能で報告する。"""
    expected = settings.local_job_accepted_revision
    if expected is None or SHA.fullmatch(expected) is None:
        problems.append("Mac定時処理: BIZTAG_LOCAL_ACCEPTED_REVISIONが未設定/不正でSHAを検査できない")
        return
    if store is None and not settings.r2_enabled():
        problems.append("Mac定時処理: R2設定不足でreceiptを検査できない")
        return
    reader = R2Store(settings, settings.bucket_timeseries, writer="ops_check") if store is None else store
    moment = datetime.now(UTC) if now is None else now
    for kind in POLICY["jobs"]:
        try:
            payload, found = reader.get_json(f"local-jobs/{kind}/latest.json")
            if type(found) is not bool or (found and payload is None):
                raise ValueError("R2 receiptの取得状態が不正")
            verdict = judge_local_receipt(kind, payload if found else None, expected, moment)
        except Exception as exc:  # noqa: BLE001 - 原文/資格をエラー文へ出さない
            verdict = f"receiptを読取/判定できない（{type(exc).__name__}）"
        if verdict is not None:
            problems.append(f"Mac {kind}: {verdict}")
