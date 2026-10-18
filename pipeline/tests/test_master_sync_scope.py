"""Normal master scope uses saved source; all external transports are explicit doubles."""
from datetime import date
from types import SimpleNamespace

import pytest
from conftest import fixture_path
from jp_stock_pipeline.cloud_store.d1 import D1Error
from jp_stock_pipeline.collectors import edinet_codelist
from jp_stock_pipeline.contracts.sector33 import normalize_sector33
from jp_stock_pipeline.jobs import master_sync as mod
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Source
from jp_stock_pipeline.rawstore import save_raw
from test_core_stocks_sector33 import _FakeD1


def _source(tmp_path):
    return save_raw(
        fixture_path("edinet/Edinetcode.zip").read_bytes(), source=Source.EDINET,
        datatype="codelist", scope="ALL", data_date=date(2026, 6, 10),
        url=edinet_codelist.CODELIST_URL, ext="zip",
        license_tag=LicenseTag.COMMERCIAL_OK, base_dir=tmp_path,
    )


@pytest.mark.parametrize("codes", ["", ",", "7203,", "72030", "7203,7203", "622a,622A"])
def test_bad_scope_stops_before_source(monkeypatch, codes):
    monkeypatch.setattr(mod.edinet_codelist, "fetch_codelist", lambda _: pytest.fail("source fetch"))
    with pytest.raises(ValueError):
        mod.execute(SimpleNamespace(args=SimpleNamespace(codes=codes, limit=None)))


def _execute(monkeypatch, tmp_path, *, scope, limit=None, store=None):
    artifact = _source(tmp_path)
    records = edinet_codelist.parse_codelist(artifact.local_path.read_bytes())
    candidates = edinet_codelist.inspect_codelist_candidates(records).candidates
    codes = [r.code for r in candidates]
    state = {"persisted": [], "failures": [], "filters": [], "custody": 0, "global": []}
    monkeypatch.setattr(mod.edinet_codelist, "fetch_codelist", lambda _: artifact)
    monkeypatch.setattr(mod.edinet_codelist, "convert_codelist", lambda a: a)
    monkeypatch.setattr(mod, "_sector33_store", lambda _: store)
    monkeypatch.setattr(mod.upsert, "load_stock_master_entries", lambda *a: state["global"].append("PRE") or {})
    monkeypatch.setattr(mod.upsert, "upsert_stock_master", lambda *a, **k: "declared-page-transport")
    for name in ("_hold_absent_codes", "_sync_notion_pages"):
        monkeypatch.setattr(mod, name, lambda *a, _name=name, **k: state["global"].append(_name))
    if store is None:
        monkeypatch.setattr(mod, "_sync_sector33", lambda *a, **k: state["global"].append("_sync_sector33"))
    def custody(_):
        state["custody"] += 1
        return "declared-physical-source-page"
    def query(db, *, filter):
        state["filters"].append(filter)
        return []
    def persist(record, writer, **kwargs):
        assert state["custody"] == 1
        assert kwargs["include_lifecycle"] is False
        writer()
        state["persisted"].append(record.code)
        return True
    ctx = SimpleNamespace(
        args=SimpleNamespace(codes=scope(codes) if callable(scope) else scope, limit=limit),
        settings=SimpleNamespace(db_id=lambda _: "declared-master-db", dry_run=False),
        client=SimpleNamespace(query_database=query), upload_raw=custody,
        persist=persist, add_success=lambda: None,
        add_failure=lambda code, reason: state["failures"].append((code, reason)),
    )
    mod.execute(ctx)
    return state, codes


def test_scope_filters_before_limit_and_uses_only_scoped_map(monkeypatch, tmp_path):
    state, codes = _execute(monkeypatch, tmp_path, scope=lambda c: f"{c[2]},{c[1]}", limit=1)
    assert state["persisted"] == [codes[1]]
    assert state["filters"] == [{"or": [mod.upsert.stock_master_filter(codes[1])]}]
    assert state["global"] == []
    assert state["failures"] == []


def test_missing_scope_has_custody_but_no_map_or_write(monkeypatch, tmp_path):
    state, _ = _execute(monkeypatch, tmp_path, scope="999A")
    assert state["custody"] == 1
    assert state["persisted"] == state["filters"] == state["global"] == []
    assert [x[0] for x in state["failures"]] == ["999A"]


def test_omitted_scope_retains_normal_global_path(monkeypatch, tmp_path):
    state, codes = _execute(monkeypatch, tmp_path, scope=None)
    assert state["persisted"] == codes
    assert state["filters"] == []
    assert state["global"] == ["PRE", "_hold_absent_codes", "_sync_sector33", "_sync_notion_pages"]


@pytest.mark.parametrize("limit", [None, 1])
def test_scope_sector_uses_only_selected_after_limit_and_keeps_parse_unqualified(monkeypatch, tmp_path, limit):
    data = fixture_path("edinet/Edinetcode.zip").read_bytes()
    records = edinet_codelist.inspect_codelist_candidates(edinet_codelist.parse_codelist(data)).candidates
    store = _FakeD1([(record.code, None) for record in records[:3]])
    reads, parse_current = [], []
    query, parse = store.query, mod.edinet_codelist.parse_codelist
    def scoped_query(sql, params=None):
        if sql.startswith("SELECT"):
            assert "WHERE c.code IN (" in sql and len(params) <= 100
            reads.append(params)
        return query(sql, params)
    def observed_parse(*args, **kwargs):
        parse_current.append(kwargs.get("current"))
        return parse(*args, **kwargs)
    monkeypatch.setattr(store, "query", scoped_query)
    monkeypatch.setattr(mod.edinet_codelist, "parse_codelist", observed_parse)
    state, codes = _execute(monkeypatch, tmp_path, scope=lambda c: f"{c[2]},{c[1]}", limit=limit, store=store)
    selected = records[1:3] if limit is None else records[1:2]
    assert reads == [[record.code for record in selected]]
    assert state["persisted"] == reads[0] and state["global"] == state["failures"] == []
    assert all(current is None for current in parse_current)
    expected = {record.code: (None, 1000) for record in records[:3]}
    expected.update({record.code: (normalize_sector33(record.sector33), 1000) for record in selected})
    assert store.values() == expected and store.write_sql
    assert codes[0] not in reads[0]


def test_scope_sector_read_failure_stops_without_update(monkeypatch, tmp_path):
    store = _FakeD1([])
    def failed_read(*args):
        raise D1Error("declared READ failure")
    monkeypatch.setattr(store, "query", failed_read)
    state, codes = _execute(monkeypatch, tmp_path, scope=lambda c: c[1], store=store)
    assert state["persisted"] == [codes[1]] and state["global"] == store.write_sql == []
    assert [code for code, _ in state["failures"]] == ["core_stocks.sector33"]
