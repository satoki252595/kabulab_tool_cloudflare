"""INC-20261026 経路1とパターンB。合成入力。修正前の 08651d50 では落ちる。

経路1: 対象日の一覧が非空のままやのしんが止まると、鮮度判定に入らず成功する。
パターンB: items が1件以上なのに解析0件だと、runner は failed=0 の成功で終わる。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime

import pytest

from jp_stock_pipeline.collectors.tdnet_yanoshin import parse_list_payload
from jp_stock_pipeline.jobs import tdnet_hourly as mod
from jp_stock_pipeline.licensing import source_license
from jp_stock_pipeline.models import JST, Source
from jp_stock_pipeline.rawstore import save_raw

# 01 の合成。parser が形の変わった item を落とした状況を records=[] で表す。
_ITEM = {
    "Tdnet": {
        "id": "9999901",
        "pubdate": "2026-10-26 15:00:00",
        "company_code": "72030",
        "title": "合成",
        "document_url": "https://example.invalid/x.pdf",
    }
}
_PAYLOAD = {"items": [_ITEM]}
_TARGET = "2026-10-26"
_NEWEST_1500 = datetime(2026, 10, 26, 15, 0, tzinfo=JST)


def _body(pubdate: str) -> bytes:
    item = {
        "Tdnet": {
            **_ITEM["Tdnet"],
            "pubdate": pubdate,
        }
    }
    return json.dumps({"items": [item]}).encode("utf-8")


def _install_listing(monkeypatch, tmp_path, body: bytes, *, records_empty: bool):
    def fake_list(settings, target="recent", limit=300, **kwargs):
        artifact = save_raw(
            body,
            source=Source.TDNET,
            datatype="tdnet_list",
            scope=str(target),
            data_date=datetime(2026, 10, 26, tzinfo=JST).date(),
            url="fixture://tdnet/nonempty-stale",
            ext="json",
            license_tag=source_license(Source.TDNET),
            base_dir=settings.raw_data_dir,
        )
        parsed = parse_list_payload(json.loads(body), fetched_at=artifact.fetched_at)
        return artifact, [] if records_empty else parsed

    monkeypatch.setattr(mod.tdnet_yanoshin, "list_disclosures", fake_list)


def _run(monkeypatch, tmp_path, caplog, *, now: datetime, body: bytes, records_empty: bool):
    monkeypatch.setattr(mod, "now_jst", lambda: now)
    _install_listing(monkeypatch, tmp_path, body, records_empty=records_empty)
    with caplog.at_level(logging.INFO):
        code = mod.main(
            ["--dry-run", "--date", _TARGET],
            env={"RAW_DATA_DIR": str(tmp_path)},
        )
    status = [r.getMessage() for r in caplog.records if r.getMessage().startswith("tdnet_hourly:")]
    return code, status


def test_pattern_b_unparsed_items_exit_nonzero(monkeypatch, tmp_path, caplog):
    """items 1件・records=[]、対象日 10/26、起動 15:05 JST。成功にも観測時点0件にもしない。"""
    code, status = _run(
        monkeypatch,
        tmp_path,
        caplog,
        now=datetime(2026, 10, 26, 15, 5, tzinfo=JST),
        body=json.dumps(_PAYLOAD).encode("utf-8"),
        records_empty=True,
    )
    assert code != 0, f"exit={code} status={status} log={caplog.text}"
    assert "items 1件・解析0件" in caplog.text
    assert "成功（観測時点0件）" not in caplog.text
    assert any(line.startswith("tdnet_hourly: 失敗") for line in status), status


def test_nonempty_stale_listing_probes_and_fails(monkeypatch, tmp_path, caplog):
    """items・records 各1件、newest 15:00 固定、起動 19:05。修正前は probe 0回で成功。"""
    calls = {"n": 0}

    def probe(*args, **kwargs):
        calls["n"] += 1
        return _NEWEST_1500

    monkeypatch.setattr(mod, "probe_yanoshin_newest", probe)
    code, status = _run(
        monkeypatch,
        tmp_path,
        caplog,
        now=datetime(2026, 10, 26, 19, 5, tzinfo=JST),
        body=_body("2026-10-26 15:00:00"),
        records_empty=False,
    )
    assert calls["n"] >= 1 and code != 0, (
        f"probe_calls={calls['n']} exit={code} status={status}"
    )
    assert "yanoshin_upstream" in caplog.text
    assert "judgement=upstream_stopped" in caplog.text
    assert any(line.startswith("tdnet_hourly: 失敗") for line in status), status
    assert "成功（観測時点0件）" not in caplog.text


@pytest.mark.parametrize(
    ("case_id", "now", "newest"),
    [
        ("weekend", "2026-10-25T12:00:00+09:00", "2026-10-23T18:00:00+09:00"),
        ("holiday-sports-day", "2026-10-12T15:00:00+09:00", "2026-10-09T18:00:00+09:00"),
        ("closure-year-end", "2026-12-31T11:00:00+09:00", "2026-12-30T17:30:00+09:00"),
        ("night-before-open", "2026-10-08T02:30:00+09:00", "2026-10-07T18:00:00+09:00"),
        ("night-after-close", "2026-10-23T23:30:00+09:00", "2026-10-23T18:30:00+09:00"),
        # 2026-04-01〜10-23 のセッション日で観測した最大の窓内間隔・末尾沈黙はいずれも 5400 秒。
        ("weekday-lunch-gap", "2026-10-26T14:30:00+09:00", "2026-10-26T13:00:00+09:00"),
        ("weekday-close-quiet", "2026-10-26T19:05:00+09:00", "2026-10-26T17:30:00+09:00"),
        ("weekday-morning-sparse", "2026-10-26T11:30:00+09:00", "2026-10-26T10:00:00+09:00"),
    ],
)
def test_nonempty_listing_does_not_false_stop(monkeypatch, tmp_path, caplog, case_id, now, newest):
    """土日・祝日・休場日・夜間と、観測された範囲の平日の少ない間隔は失敗にしない。"""
    newest_at = datetime.fromisoformat(newest)
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: newest_at)
    code, status = _run(
        monkeypatch,
        tmp_path,
        caplog,
        now=datetime.fromisoformat(now),
        body=_body(newest_at.strftime("%Y-%m-%d %H:%M:%S")),
        records_empty=False,
    )
    assert code == 0, f"{case_id} exit={code} status={status} log={caplog.text}"
    assert "judgement=fresh" in caplog.text
    assert "judgement=upstream_stopped" not in caplog.text
    assert any(line.startswith("tdnet_hourly: 成功") for line in status), status


def test_weekend_keeps_already_exceeded_silence(monkeypatch, tmp_path, caplog):
    """土日は新しい沈黙を足さない。既に4時間を超えた金曜の止まりは失敗のまま。"""
    newest_at = datetime.fromisoformat("2026-10-23T13:15:00+09:00")
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: newest_at)
    code, status = _run(
        monkeypatch,
        tmp_path,
        caplog,
        now=datetime.fromisoformat("2026-10-25T12:00:00+09:00"),
        body=_body("2026-10-23 13:15:00"),
        records_empty=False,
    )
    assert code != 0, f"exit={code} status={status}"
    assert "judgement=upstream_stopped" in caplog.text
    assert "elapsed_watch_seconds=20700" in caplog.text
