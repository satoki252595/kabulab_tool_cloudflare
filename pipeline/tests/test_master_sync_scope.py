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
        mod.execute(SimpleNamespace(args=SimpleNamespace(codes=codes, limit=None, reconcile_financial_pre=None, reconcile_financial_pre_sha256=None)))


def _execute(monkeypatch, tmp_path, *, scope, limit=None, store=None, cloud=None):
    artifact = _source(tmp_path)
    records = edinet_codelist.parse_codelist(artifact.local_path.read_bytes())
    candidates = edinet_codelist.inspect_codelist_candidates(records).candidates
    codes = [r.code for r in candidates]
    state = {"persisted": [], "failures": [], "filters": [], "custody": 0, "global": [], "financial_scope": [], "raw_buckets": []}
    def financial_sync(_client, _settings, records, **kwargs):
        state["financial_scope"].extend(r.code for r in records)
        state["raw_buckets"].append(kwargs["raw_bucket"])
    monkeypatch.setattr(mod.upsert, "sync_financial_master_relations",
                        financial_sync)
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
        args=SimpleNamespace(codes=scope(codes) if callable(scope) else scope, limit=limit, reconcile_financial_pre=None, reconcile_financial_pre_sha256=None),
        settings=SimpleNamespace(db_id=lambda _: "declared-master-db", dry_run=False),
        client=SimpleNamespace(query_database=query), upload_raw=custody, cloud=cloud,
        persist=persist, add_success=lambda: None,
        add_failure=lambda code, reason: state["failures"].append((code, reason)),
    )
    mod.execute(ctx)
    return state, codes


def test_scope_filters_before_limit_and_uses_only_scoped_map(monkeypatch, tmp_path):
    state, codes = _execute(monkeypatch, tmp_path, scope=lambda c: f"{c[2]},{c[1]}", limit=1)
    assert state["persisted"] == [codes[1]]
    assert state["financial_scope"] == [codes[1]]
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
    assert state["financial_scope"] == codes
    assert state["filters"] == []
    assert state["global"] == ["PRE", "_hold_absent_codes", "_sync_sector33", "_sync_notion_pages"]


def test_d1_only_cloud_does_not_construct_an_unqualified_r2_client(monkeypatch, tmp_path):
    class D1OnlyCloud:
        settings = SimpleNamespace(r2_enabled=lambda: False)
        @property
        def raw_bucket(self):
            pytest.fail("R2 without explicit credentials")
    state, _ = _execute(monkeypatch, tmp_path, scope=lambda codes: codes[0], cloud=D1OnlyCloud())
    assert state["raw_buckets"] == [None]


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


@pytest.mark.parametrize("codes,path,sha,limit", [
    (None, "proof", "a" * 64, None), ("7911,7203", "proof", "a" * 64, None),
    ("7911", "proof", None, None), ("7911", None, "a" * 64, None),
    ("7911", "proof", "a" * 64, 1),
])
def test_reconcile_requires_explicit_single_scope_and_both_pins_before_source(monkeypatch, codes, path, sha, limit):
    monkeypatch.setattr(mod.edinet_codelist, "fetch_codelist", lambda _: pytest.fail("source fetch"))
    monkeypatch.setattr(mod, "_load_financial_pre_rejection", lambda *args: pytest.fail("proof before flags"))
    args = SimpleNamespace(codes=codes, limit=limit, reconcile_financial_pre=path,
                           reconcile_financial_pre_sha256=sha)
    with pytest.raises(ValueError, match="1code必須"):
        mod.execute(SimpleNamespace(args=args))


def test_reconcile_entry_uses_only_fixed_helper_and_never_normal_master_writes(monkeypatch):
    calls = []
    proof = {"code": "7911"}  # 明示offline entry-routing double、業務原本ではない。
    monkeypatch.setattr(mod, "_load_financial_pre_rejection", lambda *args: proof)
    monkeypatch.setattr(mod.edinet_codelist, "fetch_codelist", lambda _: pytest.fail("source fetch"))
    monkeypatch.setattr(mod.upsert, "reconcile_financial_master_pre_rejection",
                        lambda *args, **kwargs: calls.append((args, kwargs)) or "repaired")
    bucket = object()
    ctx = SimpleNamespace(args=SimpleNamespace(codes="7911", limit=None, reconcile_financial_pre="proof",
                                              reconcile_financial_pre_sha256="a" * 64),
                          client=object(), settings=object(), upload_raw=object(),
                          cloud=SimpleNamespace(settings=SimpleNamespace(r2_enabled=lambda: True), raw_bucket=bucket),
                          add_success=lambda: calls.append("success"))
    mod.execute(ctx)
    assert calls[0][0][2] is proof and calls[0][1]["raw_bucket"] is bucket and calls[1] == "success"


def test_actual_known_pre_url_rejection_proof_and_unknown_log_rejected(tmp_path):
    import json
    from copy import deepcopy
    from hashlib import sha256
    from pathlib import Path

    # 原典/全ログは非公開のまま。存在時だけ実540証跡を使う（transport0）。
    candidates = [parent / "tmp/feature-audit-20261018/financial-pre-rejection-reconcile-v1/known-pre-rejection-proof-v1.json"
                  for parent in Path(__file__).resolve().parents]
    source = next((path for path in candidates if path.is_file()), None)
    if source is None:
        pytest.skip("private actual540 known PRE rejection proof is not published")
    body = source.read_bytes()
    actual = mod._load_financial_pre_rejection(str(source), sha256(body).hexdigest())
    assert actual["code"] == "624A" and actual["oldPending"]["status"] == "pending"
    assert actual["oldPendingSha256"] == "c99aaf9372e78904e73c1164e07affb73e16444c579ac9b656217c3815de8768"
    for fault in ("unknown-log", "source", "exit", "full-value", "pending", "closure"):
        proof = deepcopy(json.loads(body))
        key = {"unknown-log": "normalLog", "source": "oldSource", "exit": "normalFinished",
               "full-value": "expectedFinancial", "pending": "freshReadback", "closure": "processClosure"}[fault]
        data = Path(proof["capturedFiles"][key]["path"]).read_bytes()
        if fault == "unknown-log":
            data = data.replace(b"400 Bad Request", b"500 Internal Server Error").replace(
                b'body.properties.', b'unknown transport.properties.')
        elif fault == "source":
            data += b"\n# unknown source bytes\n"
        else:
            value = json.loads(data)
            if fault == "exit":
                value["exitCode"] = 0
            elif fault == "full-value":
                value["cases"][0]["financial"]["properties"][mod.S.FIN_PROP_ROA]["number"] = 0
            elif fault == "pending":
                value["cases"][-1]["r2Value"]["started_at"] = value["finishedAt"]
            else:
                value["absentPids"] = []
            data = json.dumps(value, ensure_ascii=False).encode()
        evidence = tmp_path / f"{fault}.evidence"
        evidence.write_bytes(data)
        proof["capturedFiles"][key] = {"path": str(evidence), "sha256": sha256(data).hexdigest()}
        if fault in ("unknown-log", "exit"):
            closure = json.loads(Path(proof["capturedFiles"]["processClosure"]["path"]).read_bytes())
            closure["normalLogSha256" if fault == "unknown-log" else "normalFinishedSha256"] = sha256(data).hexdigest()
            closure_path = tmp_path / f"{fault}.closure"
            closure_path.write_text(json.dumps(closure))
            proof["capturedFiles"]["processClosure"] = {"path": str(closure_path), "sha256": sha256(closure_path.read_bytes()).hexdigest()}
        path = tmp_path / f"{fault}.proof.json"
        path.write_text(json.dumps(proof, ensure_ascii=False))
        with pytest.raises(ValueError):
            mod._load_financial_pre_rejection(str(path), sha256(path.read_bytes()).hexdigest())
