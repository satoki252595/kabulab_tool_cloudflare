"""Normal master scope uses saved source; all external transports are explicit doubles."""
from datetime import date
from types import SimpleNamespace

import pytest
from conftest import fixture_path
from jp_stock_pipeline.collectors import edinet_codelist
from jp_stock_pipeline.jobs import master_sync as mod
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Source
from jp_stock_pipeline.rawstore import save_raw


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


def _execute(monkeypatch, tmp_path, *, scope, limit=None, default=False):
    artifact = _source(tmp_path)
    records = edinet_codelist.parse_codelist(artifact.local_path.read_bytes())
    candidates = edinet_codelist.inspect_codelist_candidates(records).candidates
    codes = [r.code for r in candidates]
    state = {"persisted": [], "failures": [], "filters": [], "custody": 0, "global": []}
    monkeypatch.setattr(mod.edinet_codelist, "fetch_codelist", lambda _: artifact)
    monkeypatch.setattr(mod.edinet_codelist, "convert_codelist", lambda a: a)
    monkeypatch.setattr(mod, "_sector33_store", lambda _: None if default else pytest.fail("scope D1"))
    monkeypatch.setattr(mod.upsert, "load_stock_master_entries", lambda *a: state["global"].append("PRE") or {})
    monkeypatch.setattr(mod.upsert, "upsert_stock_master", lambda *a, **k: "declared-page-transport")
    for name in ("_hold_absent_codes", "_sync_sector33", "_sync_notion_pages"):
        monkeypatch.setattr(mod, name, lambda *a, _name=name, **k: state["global"].append(_name))
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
        settings=SimpleNamespace(db_id=lambda _: "declared-master-db"),
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
    state, codes = _execute(monkeypatch, tmp_path, scope=None, default=True)
    assert state["persisted"] == codes
    assert state["filters"] == []
    assert state["global"] == ["PRE", "_hold_absent_codes", "_sync_sector33", "_sync_notion_pages"]
