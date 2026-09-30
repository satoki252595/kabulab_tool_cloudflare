"""保存済みFSA/owner実投影で両callerとUPDATE競合を検証。外部送信0。"""
import csv
import io
import json
from datetime import date
from pathlib import Path

import pytest
from conftest import fixture_path
from test_edinet_codelist import _make_zip
from test_sector33_sync import _SectorD1

from jp_stock_pipeline.collectors import codelist_identity as ci, edinet_codelist as ec
from jp_stock_pipeline.jobs import sector33_sync as sector

FIXTURE = Path(__file__).parent / "fixtures/edinet/issuer-binding"


def actual(current_changes=None, *, column=None, value=None, source_date=None, duplicate=False):
    rows = list(csv.reader(io.StringIO(fixture_path("edinet/issuer-binding/fsa-three-rows.csv").read_text())))
    if source_date:
        rows[0] = [c.replace("2026年09月30日", source_date) for c in rows[0]]
    target = next(r for r in rows[2:] if r[0] == "E38412")
    if column:
        target[rows[1].index(column)] = value
    if duplicate:
        rows.append(target.copy())
    text = io.StringIO()
    csv.writer(text).writerows(rows)
    data = _make_zip({"EdinetcodeDlInfo.csv": text.getvalue()})
    current = json.loads((FIXTURE / "current-627.json").read_text())
    if current_changes:
        current.update(current_changes)
    return data, [current]


def test_actual_both_callers_and_missing_raw_preserved():
    data, current = actual()
    master = ec.parse_codelist(data, current=current)
    admitted, holds = sector._scan_listed_rows(data, current=current)
    assert [(r.code, r.edinet_code, r.sector33) for r in master] == [
        ("627A", "E38412", "情報・通信業"), ("0000", "E42126", "化学")]
    row = next(a for a in admitted if a["ticker"] == "627A")
    assert row["raw"] == "" and row["identity_origin"] == "certified"
    sector._verify_normalization(admitted)
    assert not holds
    assert ec.inspect_codelist_candidates(master).sector[0].code == "627A"


def test_historical_csv_before_binding_is_not_retroactively_certified():
    data, current = actual(source_date="2026年09月29日")
    assert not ci.resolve_blank_tickers(data, current)
    assert not any(r.code == "627A" for r in ec.parse_codelist(data, current=current))


def test_future_csv_current_sector_and_literal_priority():
    data, current = actual({"owner_as_of": "2026-10-01"}, source_date="2026年10月01日",
                           column="提出者業種", value="サービス業")
    assert next(r for r in ec.parse_codelist(data, current=current) if r.code == "627A").sector33 == "サービス業"
    literal, _ = actual(column="証券コード", value="627A0")
    assert next(r for r in ec.parse_codelist(literal) if r.code == "627A").edinet_code == "E38412"
    admitted, _ = sector._scan_listed_rows(literal)
    assert admitted[0]["identity_origin"] == "literal"


@pytest.mark.parametrize("change", [
    {"id": 18161}, {"is_active": 0}, {"instrument_type": "etf"},
    {"owner_as_of": "2026-09-29"}, {"latest_listing_date": "2026-10-01"},
    {"effective_delist_date": "2026-09-30"},
])
def test_current_identity_change_is_hold_both_callers(change):
    data, current = actual(change)
    assert not any(r.code == "627A" for r in ec.parse_codelist(data, current=current))
    assert not sector._scan_listed_rows(data, current=current)[0]


@pytest.mark.parametrize("kwargs", [
    {"column": "証券コード", "value": "622A0"},
    {"column": "証券コード", "value": "00000"}, {"duplicate": True},
])
def test_conflict_stops_both_callers(kwargs):
    data, current = actual(**kwargs)
    for run in (ec.parse_codelist, sector._scan_listed_rows):
        with pytest.raises(ValueError, match="identity"):
            run(data, current=current)


def test_corporate_change_holds_blank_and_stops_literal():
    data, current = actual(column="提出者法人番号", value="")
    assert not ci.resolve_blank_tickers(data, current)
    rows = ec._read_codelist_rows(data)[2]
    assert next(r for _, r in rows if r[0] == "E38412")[11] == ""
    text_rows = list(csv.reader(io.StringIO(ec._read_codelist_csv(data))))
    target = next(r for r in text_rows[2:] if r[0] == "E38412")
    target[text_rows[1].index("証券コード")] = "627A0"
    text = io.StringIO()
    csv.writer(text).writerows(text_rows)
    literal = _make_zip({"EdinetcodeDlInfo.csv": text.getvalue()})
    for run in (ec.parse_codelist, sector._scan_listed_rows):
        with pytest.raises(ValueError, match="current FSA conflict"):
            run(literal, current=current)


def test_update_rechecks_episode_and_protects_other_columns():
    data, current = actual()
    store = _SectorD1([("627A", None, 1, "equity")])
    store.con.execute("UPDATE core_stocks SET id = 18160 WHERE code = '627A'")
    # Existing actual table shape; current owner/listing values from saved POST.
    store.con.execute("INSERT INTO universe_overlay_state (id, eligibility_as_of) VALUES (1, ?)",
                      [current[0]["owner_as_of"]])
    store.con.execute("INSERT INTO universe_official_events (code,kind,effective_date,source_url,fetched_at,raw_sha,archive_key) VALUES (?,?,?,?,?,?,?)",
                      ["627A", "listing", "2026-09-18", "https://www.jpx.co.jp/listing/stocks/new/index.html", "2026-09-30T01:02:51.641Z", "70c27b36577fd591310b72f1ceea459c5e467016ba0f612c5855a632df638fc8", "universe-official-events-2026-08-31-2026-09-29-sha-4bb26906b9aa"])
    sql, params = ci.certified_update("627A", "情報・通信業", date(2026, 9, 30))
    assert store.query(sql, params) == [{"code": "627A"}]
    assert store.values()["627A"] == ("情報・通信業", 1000, 1, "equity")
    mutations = [
        ("UPDATE core_stocks SET id=18161", "UPDATE core_stocks SET id=18160"),
        ("UPDATE core_stocks SET is_active=0", "UPDATE core_stocks SET is_active=1"),
        ("UPDATE universe_overlay_state SET eligibility_as_of='2026-09-29'",
         "UPDATE universe_overlay_state SET eligibility_as_of='2026-09-30'"),
        ("UPDATE universe_official_events SET effective_date='2026-10-01'",
         "UPDATE universe_official_events SET effective_date='2026-09-18'"),
    ]
    for mutate, restore in mutations:
        store.con.execute(mutate)
        assert store.query(sql, params) == []
        store.con.execute(restore)
    store.con.execute("INSERT INTO universe_official_events (code,kind,effective_date,source_url,fetched_at,raw_sha,archive_key) SELECT code,'delist','2026-10-01',source_url,fetched_at,raw_sha,archive_key FROM universe_official_events")
    assert store.query(sql, params) == [{"code": "627A"}]  # future delistは早期排除しない
    assert ci.resolve_blank_tickers(data, store.query(ci.SNAPSHOT_SQL))
    store.con.execute("UPDATE universe_official_events SET effective_date='2026-09-30' WHERE kind='delist'")
    assert not ci.resolve_blank_tickers(data, store.query(ci.SNAPSHOT_SQL))
    assert store.query(sql, params) == []
    assert store.values()["627A"][0] == "情報・通信業"
