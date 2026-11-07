"""INC-20261026: 取引時間中の公式件数と、25〜30分遅れるやのしん件数を等号で比べない。

#158 の形（公式 9 件、やのしん 5 件、やのしんの最新 08:30:40、公式は 08:55 に 2 件・
09:00 に 2 件）は、締切（08:30）より前の doc_id が一致すれば成功する。
修正前の件数等号では count_mismatch になる。

締切より前に 1 件でも欠ければ、修正後も count_mismatch で失敗する。
"""

from __future__ import annotations

import argparse
import logging
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest

from jp_stock_pipeline.collectors import tdnet_official_fallback as tof
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.http import FetchError
from jp_stock_pipeline.jobs import tdnet_hourly as mod
from jp_stock_pipeline.jobs.runner import JobContext
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import JST, DisclosureRecord, Provenance, Source
from jp_stock_pipeline.notion.client import NotionClient

def _ctx(tmp_path, day: date) -> JobContext:
    settings = load_settings(env={"RAW_DATA_DIR": str(tmp_path)}, dry_run=True)
    ctx = JobContext(
        settings=settings,
        client=NotionClient(None, rps=1000.0, dry_run=True),
        args=argparse.Namespace(date=day, limit=None),
    )
    ctx.upload_raw = lambda artifact, **kw: "raw-page-id"  # noqa: ARG005
    return ctx


def _page(day: date, *, total: int, start: int, end: int, pages: list[int], rows: list[str]) -> bytes:
    ymd = f"{day:%Y%m%d}"
    date_html = f'<div id="kaiji-date-1">{day:%Y}年{day.month:02d}月{day.day:02d}日</div>'
    text = '<div id="kaiji-text-1">に開示された情報</div>'
    kaiji = f'<div class="kaijiSum">{start}～{end}件&nbsp;/&nbsp;全{total}件</div>'
    pager = "".join(
        f"<div onClick=\"pagerLink('I_list_{n:03d}_{ymd}.html')\">{n}</div>" for n in pages
    )
    table_html = f'<table id="main-list-table">{"".join(rows)}</table>'
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


TARGET = date(2026, 11, 4)
NOW = datetime(2026, 11, 4, 9, 5, tzinfo=JST)
# 分へ切り捨てると 08:30。この分とそれより後は今回の集合に入れない。
NEWEST = datetime(2026, 11, 4, 8, 30, 40, tzinfo=JST)


def _doc(n: int) -> str:
    return f"140120261104{n:06d}"


def _record(n: int, at: datetime) -> DisclosureRecord:
    prov = Provenance(
        source=Source.TDNET,
        license_tag=LicenseTag.FACTUAL_CITE,
        data_date=TARGET,
        fetched_at=NOW,
    )
    return DisclosureRecord(
        doc_id=_doc(n),
        title="お知らせ",
        disclosed_at=at,
        provenance=prov,
        code="7203",
        doc_type="その他",
        has_xbrl=False,
    )


def _at(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 11, 4, hour, minute, second, tzinfo=JST)


# やのしん 5 件。最新は 08:30:40。公式の残り 4 件はそれより後。
_YANOSHIN = (
    (1, _at(8, 0)),
    (2, _at(8, 10)),
    (3, _at(8, 15)),
    (4, _at(8, 20)),
    (5, _at(8, 30, 40)),
)
# 公式 9 件。08:55 に 2 件、09:00 に 2 件。先頭 5 件はやのしんと同じ doc_id。
_OFFICIAL = (
    (1, "08:00"),
    (2, "08:10"),
    (3, "08:15"),
    (4, "08:20"),
    (5, "08:30"),
    (6, "08:55"),
    (7, "08:55"),
    (8, "09:00"),
    (9, "09:00"),
)


def _official_row(n: int, at: str) -> str:
    return (
        f'<tr><td class="kjTime">{at}</td><td class="kjCode">72030</td>'
        f'<td class="kjTitle"><a href="{_doc(n)}.pdf">お知らせ</a></td></tr>'
    )


def _linkless_row(at: str) -> str:
    """PDF リンクが無く doc_id を導出できない公式行。"""
    return f'<tr><td class="kjTime">{at}</td><td class="kjTitle">リンクなし</td></tr>'


def _linked_rows() -> list[str]:
    return [_official_row(n, at) for n, at in _OFFICIAL]


def _official_pages(rows: tuple[tuple[int, str], ...]) -> dict:
    total = len(rows)
    return {
        tof.page_url(TARGET, 1): _page(
            TARGET,
            total=total,
            start=1,
            end=total,
            pages=[1],
            rows=[_official_row(n, at) for n, at in rows],
        )
    }


def _run(monkeypatch, tmp_path, caplog, yanoshin: tuple[tuple[int, datetime], ...], rows):
    return _run_html(
        monkeypatch,
        tmp_path,
        caplog,
        yanoshin,
        [_official_row(n, at) for n, at in rows],
    )


def _run_html(monkeypatch, tmp_path, caplog, yanoshin, html_rows: list[str]):
    records = [_record(n, at) for n, at in yanoshin]
    monkeypatch.setattr(mod, "now_jst", lambda: NOW)
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: NEWEST)
    monkeypatch.setattr(mod, "_collect", lambda *a: [(object(), records, {})])
    monkeypatch.setattr(mod, "_load_master_map", lambda _ctx: ({}, True))
    monkeypatch.setattr(mod.upsert, "load_disclosure_page_entries", lambda *a, **k: {})
    monkeypatch.setattr(mod.file_upload, "load_raw_page_map", lambda *a, **k: {})
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET,
            total=len(html_rows),
            start=1,
            end=len(html_rows),
            pages=[1],
            rows=html_rows,
        )
    }
    calls = _install_fetch(monkeypatch, pages)
    ctx = _ctx(tmp_path, TARGET)
    ctx.persist = lambda *a, **k: True  # noqa: ARG005
    with caplog.at_level(logging.INFO):
        mod.execute(ctx)
    return ctx, calls


def test_run158_official_tail_after_yanoshin_minute_is_not_mismatch(monkeypatch, tmp_path, caplog):
    """公式 9・やのしん 5。締切 08:30 より前の doc_id が一致すれば保存まで進む。"""
    ctx, calls = _run(monkeypatch, tmp_path, caplog, _YANOSHIN, _OFFICIAL)
    assert ctx.processed == 5
    assert ctx.failed == 0
    assert "status=count_mismatch" not in caplog.text
    assert calls == [tof.page_url(TARGET, 1)]


def test_missing_doc_before_cutoff_still_fails(monkeypatch, tmp_path, caplog):
    """締切より前の 08:10 がやのしんに無い。修正後も count_mismatch で止める。"""
    yanoshin = tuple(item for item in _YANOSHIN if item[0] != 2)
    with pytest.raises(mod.OfficialListNotFresh) as raised:
        _run(monkeypatch, tmp_path, caplog, yanoshin, _OFFICIAL)
    message = str(raised.value)
    assert "status=count_mismatch" in message
    assert _doc(2) in message
    assert "before_cutoff_only_official" in message


def test_linkless_row_before_cutoff_does_not_fail_when_doc_ids_match(monkeypatch, tmp_path, caplog):
    """締切より前のリンクなし行は doc_id を持たない。集合が一致すれば失敗しない。"""
    rows = [_linkless_row("08:05"), *_linked_rows()]
    ctx, _calls = _run_html(monkeypatch, tmp_path, caplog, _YANOSHIN, rows)
    assert ctx.processed == 5
    assert ctx.failed == 0
    assert "status=count_mismatch" not in caplog.text


def test_linkless_row_after_cutoff_does_not_fail(monkeypatch, tmp_path, caplog):
    """締切より後のリンクなし行でも、締切より前の doc_id が一致すれば失敗しない。"""
    rows = [*_linked_rows(), _linkless_row("09:10")]
    ctx, _calls = _run_html(monkeypatch, tmp_path, caplog, _YANOSHIN, rows)
    assert ctx.processed == 5
    assert ctx.failed == 0
    assert "status=count_mismatch" not in caplog.text


def test_linkless_row_with_real_gap_before_cutoff_is_count_mismatch(monkeypatch, tmp_path, caplog):
    """リンクなし行があっても、締切より前の実開示が 1 件欠けたら count_mismatch。"""
    rows = [_linkless_row("08:05"), *_linked_rows()]
    yanoshin = tuple(item for item in _YANOSHIN if item[0] != 2)
    with pytest.raises(mod.OfficialListNotFresh) as raised:
        _run_html(monkeypatch, tmp_path, caplog, yanoshin, rows)
    message = str(raised.value)
    assert "status=count_mismatch" in message
    assert _doc(2) in message
    assert "before_cutoff_only_official" in message


def test_same_count_different_doc_id_before_cutoff_fails(monkeypatch, tmp_path, caplog):
    """締切より前の件数が同じでも doc_id が違えば count_mismatch。"""
    yanoshin = ((1, _at(8, 0)), (5, _at(8, 30, 40)))
    official = ((2, "08:00"), (5, "08:30"))
    with pytest.raises(mod.OfficialListNotFresh) as raised:
        _run(monkeypatch, tmp_path, caplog, yanoshin, official)
    message = str(raised.value)
    assert "status=count_mismatch" in message
    assert "official=2" in message
    assert "expected=2" in message
    assert _doc(1) in message
    assert _doc(2) in message


def test_last_run_logs_deferred_tail_with_incident_tag(monkeypatch, tmp_path, caplog):
    """19:00 は締切以降を失敗にせず、件数と doc_id を障害タグ付きで残す。"""
    now = datetime(2026, 11, 4, 19, 5, tzinfo=JST)
    newest = datetime(2026, 11, 4, 18, 40, 10, tzinfo=JST)
    yanoshin = ((1, _at(18, 0)), (2, datetime(2026, 11, 4, 18, 40, 10, tzinfo=JST)))
    official = ((1, "18:00"), (2, "18:40"), (3, "18:55"), (4, "19:00"))
    records = [_record(n, at) for n, at in yanoshin]
    monkeypatch.setattr(mod, "now_jst", lambda: now)
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: newest)
    monkeypatch.setattr(mod, "_collect", lambda *a: [(object(), records, {})])
    monkeypatch.setattr(mod, "_load_master_map", lambda _ctx: ({}, True))
    monkeypatch.setattr(mod.upsert, "load_disclosure_page_entries", lambda *a, **k: {})
    monkeypatch.setattr(mod.file_upload, "load_raw_page_map", lambda *a, **k: {})
    _install_fetch(monkeypatch, _official_pages(official))
    ctx = _ctx(tmp_path, TARGET)
    slot = datetime(2026, 11, 4, 19, 0, tzinfo=JST)
    ctx.args._scheduled_window = (slot, slot + timedelta(minutes=90))
    ctx.persist = lambda *a, **k: True  # noqa: ARG005
    with caplog.at_level(logging.INFO):
        mod.execute(ctx)
    assert ctx.processed == 2
    assert "status=count_mismatch" not in caplog.text
    assert (
        f"{mod.INCIDENT_TAG} deferred_tail official_count=3 yanoshin_count=1"
        f" official_doc_ids={_doc(2)},{_doc(3)},{_doc(4)}"
        f" yanoshin_doc_ids={_doc(2)}"
        " cutoff=2026-11-04T18:40:00+09:00"
    ) in caplog.text


def _prev_record(doc_id: str) -> DisclosureRecord:
    prov = Provenance(
        source=Source.TDNET,
        license_tag=LicenseTag.FACTUAL_CITE,
        data_date=date(2026, 11, 4),
        fetched_at=datetime(2026, 11, 5, 9, 5, tzinfo=JST),
    )
    return DisclosureRecord(
        doc_id=doc_id,
        title="お知らせ",
        disclosed_at=datetime(2026, 11, 4, 15, 0, tzinfo=JST),
        provenance=prov,
        code="7203",
        doc_type="その他",
        has_xbrl=False,
    )


def _prepare_first_run(monkeypatch, tmp_path, caplog, *, previous_rows: list[str], previous_records):
    """翌平日 09:00。当日は締切ちょうどの 1 件で一致させ、前日の照合まで進める。"""
    target = date(2026, 11, 5)
    now = datetime(2026, 11, 5, 9, 5, tzinfo=JST)
    today_id = "140120261105000001"
    today = DisclosureRecord(
        doc_id=today_id,
        title="お知らせ",
        disclosed_at=datetime(2026, 11, 5, 9, 0, tzinfo=JST),
        provenance=Provenance(
            source=Source.TDNET,
            license_tag=LicenseTag.FACTUAL_CITE,
            data_date=target,
            fetched_at=now,
        ),
        code="7203",
        doc_type="その他",
        has_xbrl=False,
    )
    today_row = (
        '<tr><td class="kjTime">09:00</td><td class="kjCode">72030</td>'
        f'<td class="kjTitle"><a href="{today_id}.pdf">お知らせ</a></td></tr>'
    )
    pages = {
        tof.page_url(target, 1): _page(target, total=1, start=1, end=1, pages=[1], rows=[today_row]),
        tof.page_url(date(2026, 11, 4), 1): _page(
            date(2026, 11, 4),
            total=len(previous_rows),
            start=1,
            end=len(previous_rows),
            pages=[1],
            rows=previous_rows,
        ),
    }
    monkeypatch.setattr(mod, "now_jst", lambda: now)
    monkeypatch.setattr(mod, "probe_yanoshin_newest", lambda *a, **k: now.replace(minute=0))
    monkeypatch.setattr(mod, "_collect", lambda *a: [(object(), [today], {})])
    monkeypatch.setattr(mod, "_load_master_map", lambda _ctx: ({}, True))
    monkeypatch.setattr(mod.upsert, "load_disclosure_page_entries", lambda *a, **k: {})
    monkeypatch.setattr(mod.file_upload, "load_raw_page_map", lambda *a, **k: {})

    def fake_list(settings, target="recent", limit=300, **kwargs):  # noqa: ARG001
        assert target == "20261104"
        assert limit == mod.YANOSHIN_LIMIT
        return SimpleNamespace(), list(previous_records)

    monkeypatch.setattr(mod.tdnet_yanoshin, "list_disclosures", fake_list)
    _install_fetch(monkeypatch, pages)
    ctx = _ctx(tmp_path, target)
    slot = datetime(2026, 11, 5, 9, 0, tzinfo=JST)
    ctx.args._scheduled_window = (slot, slot + timedelta(minutes=90))
    ctx.persist = lambda *a, **k: True  # noqa: ARG005
    return ctx


def _previous_row(doc_id: str) -> str:
    return (
        '<tr><td class="kjTime">15:00</td><td class="kjCode">72030</td>'
        f'<td class="kjTitle"><a href="{doc_id}.pdf">お知らせ</a></td></tr>'
    )


def test_first_run_fails_when_previous_weekday_doc_ids_differ(monkeypatch, tmp_path, caplog):
    """09:00 は前日全体の doc_id が 1 件でも違えば、当日を保存したあと失敗する。"""
    kept = "140120261104000011"
    missing = "140120261104000012"
    ctx = _prepare_first_run(
        monkeypatch,
        tmp_path,
        caplog,
        previous_rows=[_previous_row(kept), _previous_row(missing)],
        previous_records=[_prev_record(kept)],
    )
    with caplog.at_level(logging.INFO), pytest.raises(mod.OfficialListNotFresh) as raised:
        mod.execute(ctx)
    assert ctx.processed == 1
    message = str(raised.value)
    assert "status=count_mismatch" in message
    assert "previous_weekday=2026-11-04" in message
    assert missing in message
    assert mod.INCIDENT_TAG in message


def test_first_run_matches_previous_weekday_doc_ids(monkeypatch, tmp_path, caplog):
    """前日の doc_id 集合が一致すれば、09:00 は失敗にしない。"""
    kept = "140120261104000011"
    ctx = _prepare_first_run(
        monkeypatch,
        tmp_path,
        caplog,
        previous_rows=[_previous_row(kept)],
        previous_records=[_prev_record(kept)],
    )
    with caplog.at_level(logging.INFO):
        mod.execute(ctx)
    assert ctx.processed == 1
    assert "status=count_mismatch" not in caplog.text
    assert (
        f"{mod.INCIDENT_TAG} previous_weekday=2026-11-04 status=matched count=1"
    ) in caplog.text


def test_previous_weekday_linkless_row_matches(monkeypatch, tmp_path, caplog):
    """前日照合は、リンクなし行があっても doc_id 集合が一致すれば失敗しない。"""
    kept = "140120261104000011"
    ctx = _prepare_first_run(
        monkeypatch,
        tmp_path,
        caplog,
        previous_rows=[_previous_row(kept), _linkless_row("16:00")],
        previous_records=[_prev_record(kept)],
    )
    with caplog.at_level(logging.INFO):
        mod.execute(ctx)
    assert ctx.processed == 1
    assert "status=count_mismatch" not in caplog.text
    assert (
        f"{mod.INCIDENT_TAG} previous_weekday=2026-11-04 status=matched count=1"
    ) in caplog.text


def test_previous_weekday_linkless_row_with_gap_is_count_mismatch(monkeypatch, tmp_path, caplog):
    """前日照合は、リンクなし行があっても実 doc_id が欠けたら count_mismatch。"""
    kept = "140120261104000011"
    missing = "140120261104000012"
    ctx = _prepare_first_run(
        monkeypatch,
        tmp_path,
        caplog,
        previous_rows=[_previous_row(kept), _linkless_row("16:00"), _previous_row(missing)],
        previous_records=[_prev_record(kept)],
    )
    with caplog.at_level(logging.INFO), pytest.raises(mod.OfficialListNotFresh) as raised:
        mod.execute(ctx)
    assert ctx.processed == 1
    message = str(raised.value)
    assert "status=count_mismatch" in message
    assert "previous_weekday=2026-11-04" in message
    assert missing in message


def test_previous_weekday_at_yanoshin_limit_is_not_matched(monkeypatch, tmp_path, caplog):
    """上限ちょうどは集合を確定できない。一致したことにしない。"""
    kept = "140120261104000011"
    ctx = _prepare_first_run(
        monkeypatch,
        tmp_path,
        caplog,
        previous_rows=[_previous_row(kept)],
        previous_records=[_prev_record(kept)] * mod.YANOSHIN_LIMIT,
    )
    with pytest.raises(mod.OfficialListNotFresh) as raised:
        mod.execute(ctx)
    assert ctx.processed == 1
    assert "status=partial" in str(raised.value)
    assert str(mod.YANOSHIN_LIMIT) in str(raised.value)


def test_census_returns_doc_ids_from_every_page(monkeypatch, tmp_path):
    """複数ページでも確定時の doc_id は全ページ分残る。"""
    rows1 = [_official_row(i, "08:00") for i in range(1, 101)]
    rows2 = [_official_row(101, "08:01")]
    pages = {
        tof.page_url(TARGET, 1): _page(
            TARGET, total=101, start=1, end=100, pages=[1, 2], rows=rows1
        ),
        tof.page_url(TARGET, 2): _page(
            TARGET, total=101, start=101, end=101, pages=[1, 2], rows=rows2
        ),
    }
    _install_fetch(monkeypatch, pages)
    settings = load_settings(env={"RAW_DATA_DIR": str(tmp_path)}, dry_run=True)
    census = tof.census_official_list(settings, TARGET)
    assert census.status == "confirmed"
    assert census.count == 101
    assert len(census.records) == 101
    assert {record.doc_id for record in census.records} == {_doc(i) for i in range(1, 102)}
