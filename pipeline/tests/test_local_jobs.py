"""合成実行receiptで監視を検証する。処理件数や実モデル出力は生成しない。"""
from datetime import UTC, datetime, timedelta

import pytest

from jp_stock_pipeline.cloud_store.local_jobs import (
    POLICY, check_local_job_receipts, judge_local_receipt, scheduled_for,
)
from jp_stock_pipeline.config import CloudStoreSettings, load_settings

SHA = "a" * 40
NOW = datetime(2026, 10, 14, 14, 35, tzinfo=UTC)


def iso(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def receipt(kind="biztag"):
    scheduled = scheduled_for(kind, NOW)
    return {"version": 1, "kind": kind, "phase": "finished", "scheduledFor": iso(scheduled),
            "startedAt": iso(scheduled + timedelta(seconds=1)),
            "finishedAt": iso(scheduled + timedelta(minutes=20)),
            "revision": SHA, "acceptedRevision": SHA, "code": 0, "signal": None, "retries": 0}


@pytest.mark.parametrize("kind", ["biztag", "yutai-summary"])
def test_両jobの定時終了code0はpending件数の成功に置き換えない(kind, caplog):
    with caplog.at_level("INFO"):
        assert judge_local_receipt(kind, receipt(kind), SHA, NOW) is None
    assert "pending" in caplog.text
    assert "processed" not in receipt(kind)


def test_補足の実測残件はexit0でも検知し当夜検査完了を全補足完了にしない(caplog):
    data = {"scope": "daily_window", "status": "attention", "totalStocks": 100, "selectedForTextCheck": 2,
            "textChecked": 1, "textUnchecked": 1, "textMismatched": 1, "textRepaired": 0, "metadataRepaired": 1,
            "remaining": 1, "failures": 0, "qualificationHeld": 1, "wholeSupplementComplete": False}
    assert "補足検査に残あり" in judge_local_receipt("biztag", {**receipt(), "biztagData": data}, SHA, NOW)
    checked = {**data, "status": "checked_scope_complete", "textChecked": 2, "textUnchecked": 0,
               "textRepaired": 1, "remaining": 0, "qualificationHeld": 0}
    with caplog.at_level("INFO"):
        assert judge_local_receipt("biztag", {**receipt(), "biztagData": checked}, SHA, NOW) is None
    assert "全補足完了は未証明" in caplog.text
    outside_active = {**data, "scope": "explicit_codes", "totalStocks": 1}
    assert "補足検査に残あり" in judge_local_receipt("biztag", {**receipt(), "biztagData": outside_active}, SHA, NOW)
    assert "件数が矛盾" in judge_local_receipt("biztag", {**receipt(), "biztagData": {**outside_active, "scope": "daily_window"}}, SHA, NOW)
    for bad in ({**checked, "wholeSupplementComplete": True}, {**checked, "textChecked": True}, {**checked, "textUnchecked": 1}):
        assert "不正" in judge_local_receipt("biztag", {**receipt(), "biztagData": bad}, SHA, NOW) or "矛盾" in judge_local_receipt("biztag", {**receipt(), "biztagData": bad}, SHA, NOW)


@pytest.mark.parametrize("changes,reason", [
    ({"acceptedRevision": "b" * 40}, "SHA"),
    ({"revision": "b" * 40}, "SHA"),
    ({"startedAt": "2026-10-14T11:06:00.000Z"}, "開始窓"),
    ({"finishedAt": "2026-10-14T11:31:00.000Z"}, "終了窓"),
    ({"code": 1}, "非0"),
    ({"code": None, "signal": "SIGTERM"}, "シグナル"),
    ({"code": None}, "結果不明"),
    ({"phase": "running", "finishedAt": None, "code": None}, "未完"),
    ({"finishedAt": None}, "終了時計"),
    ({"finishedAt": "2026-10-14T11:00:00.000Z"}, "矛盾"),
    ({"finishedAt": "2026-10-14T16:00:00.000Z"}, "矛盾"),
    ({"startedAt": "2026-02-30T11:00:00.000Z"}, "時計"),
    ({"processed": 0}, "未知項目"),
    ({"description": "原文の番兵"}, "未知項目"),
    ({"retries": 1}, "再送"),
])
def test_未完や未確認を緑にしない(changes, reason):
    assert reason in judge_local_receipt("biztag", {**receipt(), **changes}, SHA, NOW)


def test_期限前の未完と過去receiptを区別し期限後は報告する():
    started = {**receipt(), "phase": "running", "finishedAt": None, "code": None}
    assert judge_local_receipt("biztag", started, SHA, datetime(2026, 10, 14, 11, 20, tzinfo=UTC)) is None
    assert "未完" in judge_local_receipt("biztag", started, SHA, NOW)
    assert judge_local_receipt("biztag", None, SHA, datetime(2026, 10, 14, 11, 2, tzinfo=UTC)) is None
    assert "未取得" in judge_local_receipt("biztag", None, SHA, NOW)
    previous = {key: iso(datetime.fromisoformat(value.replace("Z", "+00:00")) - timedelta(days=1))
                if key in ("scheduledFor", "startedAt", "finishedAt") else value for key, value in receipt().items()}
    assert "当該予定" in judge_local_receipt("biztag", previous, SHA, NOW)


def test_JSTの休日早朝も毎日予定を保持する():
    moment = datetime(2026, 10, 18, 0, 0, tzinfo=UTC)
    assert scheduled_for("biztag", moment) == datetime(2026, 10, 17, 11, 0, tzinfo=UTC)
    assert scheduled_for("yutai-summary", moment) == datetime(2026, 10, 17, 12, 0, tzinfo=UTC)
    assert POLICY["startGraceMinutes"] == 5 and POLICY["completionMinutes"] == 30


class Store:
    def __init__(self, payloads):
        self.payloads, self.calls = payloads, []

    def get_json(self, key):
        self.calls.append(key)
        return self.payloads[key], True


def test_既存設定を読んで両job2GETで判定する():
    settings = load_settings(env={"BIZTAG_LOCAL_ACCEPTED_REVISION": SHA}).cloud_store
    store = Store({f"local-jobs/{kind}/latest.json": receipt(kind) for kind in POLICY["jobs"]})
    problems = []
    check_local_job_receipts(settings, problems, now=NOW, store=store)
    assert problems == [] and len(store.calls) == 2


def test_設定不足とR2読取不明は失敗として通知へ渡す():
    problems = []
    check_local_job_receipts(CloudStoreSettings(), problems, now=NOW)
    assert "BIZTAG_LOCAL_ACCEPTED_REVISION" in problems[0]
    problems.clear()
    check_local_job_receipts(CloudStoreSettings(local_job_accepted_revision=SHA), problems, now=NOW)
    assert "R2設定不足" in problems[0]
    problems.clear()
    store = Store({})
    check_local_job_receipts(CloudStoreSettings(local_job_accepted_revision=SHA), problems, now=NOW, store=store)
    assert len(problems) == 2 and all("読取/判定できない" in p for p in problems)
