"""公式一覧が取れていないのに tdnet_hourly が fresh になる回帰。

修正前は、やのしんの経過が 14400 秒以内なら公式 HTML を見ずに
0 件成功（または非空の成功）になる。修正後は公式一覧の件数を
確定できないとき fresh にしない。14400 秒の比較自体は変えない。
"""

from __future__ import annotations

import argparse
import logging
from datetime import date, datetime
from types import SimpleNamespace

import pytest

from jp_stock_pipeline.collectors import tdnet_official_fallback as tof
from jp_stock_pipeline.collectors.yanoshin_upstream import (
    MAX_WATCH_SILENCE_SECONDS,
    elapsed_watch_seconds,
    judge_yanoshin_upstream,
)
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.http import FetchError
from jp_stock_pipeline.jobs import runner, tdnet_hourly as mod
from jp_stock_pipeline.jobs.runner import JobContext
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import JST, DisclosureRecord, Provenance, Source
from jp_stock_pipeline.notion.client import NotionClient

# 2026-10-23 金 18:00 → 2026-10-26 月 10:00 は窓内 7200 秒で fresh。
FRESH_NOW = datetime(2026, 10, 26, 10, 0, tzinfo=JST)
FRESH_NEWEST = datetime(2026, 10, 23, 18, 0, tzinfo=JST)
# 金 15:00 → 月 09:00 はちょうど 14400 秒。空一覧の共有判定では fresh。
EXACT_NOW = datetime(2026, 10, 26, 9, 0, tzinfo=JST)
EXACT_NEWEST = datetime(2026, 10, 23, 15, 0, tzinfo=JST)
# 同日 09:00 → 13:00 も 14400 秒。非空はちょうど 4 時間で停止のまま。
NONEMPTY_EXACT_NOW = datetime(2026, 10, 26, 13, 0, tzinfo=JST)
NONEMPTY_EXACT_NEWEST = datetime(2026, 10, 26, 9, 0, tzinfo=JST)
TARGET = date(2026, 10, 26)


def _ctx(tmp_path, day: date) -> JobContext:
    settings = load_settings(env={"RAW_DATA_DIR": str(tmp_path)}, dry_run=True)
    ctx = JobContext(
        settings=settings,
        client=NotionClient(None, rps=1000.0, dry_run=True),
        args=argparse.Namespace(date=day, limit=None),
    )
    ctx.upload_raw = lambda artifact, **kw: "raw-page-id"  # noqa: ARG005
    return ctx


def _row(i: int, *, skip: bool = False, at: str = "15:00") -> str:
    if skip:
        return f'<tr><td class="kjTime">{at}</td><td class="kjTitle">リンクなし</td></tr>'
    return (
        f'<tr><td class="kjTime">{at}</td><td class="kjCode">72030</td>'
        f'<td class="kjTitle"><a href="140120261026{i:06d}.pdf">お知らせ</a></td></tr>'
    )


def _page(
    day: date,
    *,
    total: int | None,
    start: int,
    end: int,
    pages: list[int],
    rows: list[str],
    closed: bool = False,
    table: bool = True,
) -> bytes:
    ymd = f"{day:%Y%m%d}"
    date_html = f'<div id="kaiji-date-1">{day:%Y}年{day.month:02d}月{day.day:02d}日</div>'
    if closed:
        text = '<div id="kaiji-text-1">に開示された情報はありません。</div>'
        html = f"<!DOCTYPE html><html><body>{date_html}{text}<div id=\"main-list\"></div></body></html>"
        return html.encode("utf-8")
    text = '<div id="kaiji-text-1">に開示された情報</div>'
    kaiji = ""
    if total is not None:
        kaiji = f'<div class="kaijiSum">{start}～{end}件&nbsp;/&nbsp;全{total}件</div>'
    pager = "".join(
        f"<div onClick=\"pagerLink('I_list_{n:03d}_{ymd}.html')\">{n}</div>" for n in pages
    )
    table_html = f'<table id="main-list-table">{"".join(rows)}</table>' if table else ""
    html = f"<!DOCTYPE html><html><body>{date_html}{text}{kaiji}{pager}{table_html}</body></html>"
    return html.encode("utf-8")


def _install_fetch(monkeypatch, pages: dict[str, bytes | FetchError]) -> list[str]:
    calls: list[str] = []

    def stub(url, **kwargs):  # noqa: ARG001
        calls.append(url)
        item = pages.get(url)
        if item is None:
            raise FetchError(f"取得失敗: {url}: HTTP 404")
        if isinstance(item, FetchError):
            raise item
        return SimpleNamespace(content=item)

    monkeypatch.setattr(tof, "fetch", stub)
    return calls


def _prepare_empty(monkeypatch, tmp_path, *, now: datetime, newest: datetime, pages):
    assert newest.astimezone(JST).date() != TARGET
    monkeypatch.setattr(mod, "now_jst", lambda: now)
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: newest)  # noqa: ARG005
    path = tmp_path / "list.json"
    path.write_text('{"items":[]}', encoding="utf-8")
    artifact = SimpleNamespace(local_path=path)
    monkeypatch.setattr(mod, "_collect", lambda *a: [(artifact, [], {})])  # noqa: ARG005
    calls = _install_fetch(monkeypatch, pages)
    return _ctx(tmp_path, TARGET), calls


def _run_expect_not_fresh(monkeypatch, tmp_path, caplog, pages, status: str):
    elapsed = elapsed_watch_seconds(FRESH_NEWEST, FRESH_NOW)
    assert 0 <= elapsed < MAX_WATCH_SILENCE_SECONDS
    assert judge_yanoshin_upstream(FRESH_NEWEST, FRESH_NOW).judgement == "fresh"
    ctx, calls = _prepare_empty(
        monkeypatch, tmp_path, now=FRESH_NOW, newest=FRESH_NEWEST, pages=pages
    )
    raised: Exception | None
    with caplog.at_level(logging.INFO):
        try:
            mod.execute(ctx)
        except Exception as exc:  # noqa: BLE001 - 修正前は例外が無いこと自体を見る
            raised = exc
        else:
            raised = None
    assert ctx.verified_zero_status is None, ctx.verified_zero_status
    assert raised is not None, "fresh のまま戻った"
    assert f"status={status}" in str(raised)
    assert "status=holiday" not in str(raised) or status == "holiday"
    assert "judgement=fresh" not in caplog.text
    assert "judgement=official_unconfirmed" in caplog.text
    return calls


def test_t1_unreadable_official_list_is_not_fresh(monkeypatch, tmp_path, caplog):
    """T1: 表はあるが kaijiSum を読めない。fresh にしない。"""
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET, total=None, start=1, end=1, pages=[1], rows=[_row(1)]
        )
    }
    calls = _run_expect_not_fresh(monkeypatch, tmp_path, caplog, pages, "unreadable")
    assert calls == [tof.page_url(TARGET, 1)]
    assert "gets=1" in caplog.text


def test_t2_missing_table_is_not_fresh(monkeypatch, tmp_path, caplog):
    """T2: HTTP 200 で表が無く、開示なしの文もない。休日ではない。"""
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET, total=None, start=1, end=1, pages=[], rows=[], table=False
        )
    }
    calls = _run_expect_not_fresh(monkeypatch, tmp_path, caplog, pages, "no_table")
    assert calls == [tof.page_url(TARGET, 1)]
    assert "gets=1" in caplog.text


def test_t3_skipped_rows_are_not_fresh(monkeypatch, tmp_path, caplog):
    """T3: 表の行を読み飛ばした。件数を確定したことにしない。"""
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET, total=1, start=1, end=1, pages=[1], rows=[_row(1, skip=True)]
        )
    }
    calls = _run_expect_not_fresh(monkeypatch, tmp_path, caplog, pages, "skipped_rows")
    assert calls == [tof.page_url(TARGET, 1)]
    assert "gets=1" in caplog.text


def test_t4_partial_pages_are_not_fresh(monkeypatch, tmp_path, caplog):
    """T4: 2 ページ目が取れない。1 ページ目だけで fresh にしない。"""
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET,
            total=150,
            start=1,
            end=100,
            pages=[1, 2],
            rows=[_row(i) for i in range(100)],
        ),
        tof.page_url(TARGET, 2): FetchError("取得失敗: page2: HTTP 404"),
    }
    calls = _run_expect_not_fresh(monkeypatch, tmp_path, caplog, pages, "partial")
    assert calls == [tof.page_url(TARGET, 1), tof.page_url(TARGET, 2)]
    assert "gets=2" in caplog.text


def test_t4_kaiji_sum_mismatch_is_not_fresh(monkeypatch, tmp_path, caplog):
    """合計が kaijiSum と違う。読み取れた行数を全件としない。"""
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET, total=2, start=1, end=2, pages=[1], rows=[_row(1)]
        )
    }
    calls = _run_expect_not_fresh(monkeypatch, tmp_path, caplog, pages, "count_mismatch")
    assert calls == [tof.page_url(TARGET, 1)]
    assert "gets=1" in caplog.text


def test_holiday_200_without_table_can_stay_fresh(monkeypatch, tmp_path, caplog):
    """休日: 200 で表が無く、開示なしと書いてある。取得失敗とは別で、0 件成功のまま。"""
    assert MAX_WATCH_SILENCE_SECONDS == 14400
    pages = {tof.page_url(TARGET, 1): _page(TARGET, total=None, start=1, end=1, pages=[], rows=[], closed=True)}
    ctx, calls = _prepare_empty(
        monkeypatch, tmp_path, now=FRESH_NOW, newest=FRESH_NEWEST, pages=pages
    )
    with caplog.at_level(logging.INFO):
        mod.execute(ctx)
    assert ctx.verified_zero_status == runner.STATUS_OBSERVED_EMPTY
    assert "judgement=fresh" in caplog.text
    assert "status=holiday" in caplog.text
    assert "count=0" in caplog.text
    assert "gets=1" in caplog.text
    assert "status=fetch_failed" not in caplog.text
    assert "status=no_table" not in caplog.text
    assert calls == [tof.page_url(TARGET, 1)]


def test_fetch_failure_is_not_holiday_or_fresh(monkeypatch, tmp_path, caplog):
    """取得失敗: 1 ページ目が FetchError。休日の 0 件にも fresh にもしない。"""
    pages = {tof.page_url(TARGET, 1): FetchError("取得失敗: down: HTTP 503")}
    calls = _run_expect_not_fresh(monkeypatch, tmp_path, caplog, pages, "fetch_failed")
    assert calls == [tof.page_url(TARGET, 1)]
    assert "gets=1" in caplog.text
    assert "status=holiday" not in caplog.text
    assert "status=no_table" not in caplog.text


def test_empty_elapsed_14400_stays_fresh_when_holiday_page(monkeypatch, tmp_path, caplog):
    """ちょうど 14400 秒は空一覧では fresh のまま。公式が休日 0 件なら 0 件成功。"""
    assert MAX_WATCH_SILENCE_SECONDS == 14400
    assert elapsed_watch_seconds(EXACT_NEWEST, EXACT_NOW) == 14400
    assert judge_yanoshin_upstream(EXACT_NEWEST, EXACT_NOW).judgement == "fresh"
    pages = {tof.page_url(TARGET, 1): _page(TARGET, total=None, start=1, end=1, pages=[], rows=[], closed=True)}
    ctx, calls = _prepare_empty(
        monkeypatch, tmp_path, now=EXACT_NOW, newest=EXACT_NEWEST, pages=pages
    )
    with caplog.at_level(logging.INFO):
        mod.execute(ctx)
    assert ctx.verified_zero_status == runner.STATUS_OBSERVED_EMPTY
    assert "elapsed_watch_seconds=14400" in caplog.text
    assert "judgement=fresh" in caplog.text
    assert "judgement=upstream_stopped" not in caplog.text
    assert "status=holiday" in caplog.text
    assert calls == [tof.page_url(TARGET, 1)]


def test_nonempty_elapsed_14400_stays_stopped_without_official_get(monkeypatch, tmp_path, caplog):
    """非空のちょうど 14400 秒は停止のまま。公式一覧の追加 GET はしない。"""
    assert elapsed_watch_seconds(NONEMPTY_EXACT_NEWEST, NONEMPTY_EXACT_NOW) == 14400
    calls = _install_fetch(monkeypatch, {})
    record = _record()
    monkeypatch.setattr(mod, "now_jst", lambda: NONEMPTY_EXACT_NOW)
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: NONEMPTY_EXACT_NEWEST)
    monkeypatch.setattr(mod, "_collect", lambda *a: [(object(), [record], {})])
    ctx = _ctx(tmp_path, TARGET)
    with caplog.at_level(logging.INFO):
        with pytest.raises(Exception, match="upstream stopped"):
            mod.execute(ctx)
    assert calls == []
    assert "elapsed_watch_seconds=14400" in caplog.text
    assert "judgement=upstream_stopped" in caplog.text
    assert "judgement=fresh" not in caplog.text
    assert ctx.verified_zero_status is None


def test_nonempty_official_count_mismatch_is_not_fresh(monkeypatch, tmp_path, caplog):
    """やのしん 1 件・公式 kaijiSum 2 件は fresh の成功にしない。

    余分な 1 件は締切（やのしんの 15:00）より前。同じ分以降の遅れは対象外。
    """
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET,
            total=2,
            start=1,
            end=2,
            pages=[1],
            rows=[_row(2, at="14:00"), _row(1, at="15:00")],
        )
    }
    calls = _install_fetch(monkeypatch, pages)
    record = _record()
    monkeypatch.setattr(mod, "now_jst", lambda: FRESH_NOW)
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: FRESH_NEWEST)
    monkeypatch.setattr(mod, "_collect", lambda *a: [(object(), [record], {})])
    monkeypatch.setattr(mod, "_load_master_map", lambda _ctx: ({}, True))
    monkeypatch.setattr(mod.upsert, "load_disclosure_page_entries", lambda *a, **k: {})
    monkeypatch.setattr(mod.file_upload, "load_raw_page_map", lambda *a, **k: {})
    ctx = _ctx(tmp_path, TARGET)
    ctx.persist = lambda *a, **k: True  # noqa: ARG005
    raised: Exception | None
    with caplog.at_level(logging.INFO):
        try:
            mod.execute(ctx)
        except Exception as exc:  # noqa: BLE001
            raised = exc
        else:
            raised = None
    assert raised is not None, ctx.processed
    assert "status=count_mismatch" in str(raised)
    assert "official=2" in str(raised)
    assert "expected=1" in str(raised)
    assert ctx.processed == 0
    assert ctx.verified_zero_status is None
    assert "judgement=fresh" not in caplog.text
    assert calls == [tof.page_url(TARGET, 1)]


def test_official_get_cap_is_40(monkeypatch, tmp_path, caplog):
    """kaijiSum が 41 ページでも追加 GET は 1 ページ目で止め、40 を超えない。"""
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET,
            total=4001,
            start=1,
            end=100,
            pages=list(range(1, 42)),
            rows=[_row(i) for i in range(100)],
        )
    }
    calls = _run_expect_not_fresh(monkeypatch, tmp_path, caplog, pages, "partial")
    assert tof.OFFICIAL_FRESHNESS_MAX_GETS == 40
    assert calls == [tof.page_url(TARGET, 1)]
    assert len(calls) <= 40
    assert "GET 上限 40" in caplog.text


def _record() -> DisclosureRecord:
    prov = Provenance(
        source=Source.TDNET,
        license_tag=LicenseTag.FACTUAL_CITE,
        data_date=TARGET,
        fetched_at=FRESH_NOW,
    )
    return DisclosureRecord(
        doc_id="140120261026000001",
        title="お知らせ",
        disclosed_at=datetime(2026, 10, 26, 15, 0, tzinfo=JST),
        provenance=prov,
        code="7203",
        doc_type="その他",
        has_xbrl=False,
    )
