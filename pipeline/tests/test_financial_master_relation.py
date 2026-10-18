"""実保存7911 type5を正常converterへ通す。HTTP/R2/Notionは宣言transportだけ。"""
from copy import deepcopy
from dataclasses import replace
from datetime import date, timedelta
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from uuid import NAMESPACE_URL, uuid5

import pytest

from jp_stock_pipeline.convert.xbrl_to_csv import edinet_csv_zip_to_tidy
from jp_stock_pipeline.licensing import source_license
from jp_stock_pipeline.models import Provenance, Source, StockMasterRecord, now_jst
from jp_stock_pipeline.notion import file_upload, schema as S, upsert as mod
from jp_stock_pipeline.transform.direct_roa import _dei
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record


def _id(label):
    return str(uuid5(NAMESPACE_URL, "declared-notion-transport:" + label))


def _response(props):
    result = deepcopy(props)
    for name, prop in result.items():
        kind = next(iter(prop))
        prop.update(id=name, type=kind)
        for part in prop.get("rich_text", prop.get("title", [])):
            part["plain_text"] = part["text"]["content"]
    return result


def _page(label, db, props):
    return {"object": "page", "id": _id(label), "parent": {"type": "database_id", "database_id": db},
            "created_time": now_jst().isoformat(), "last_edited_time": now_jst().isoformat(),
            "archived": False, "in_trash": False, "properties": _response(props)}


class Bucket:
    """同keyの条件付きPUTだけを受けるtransport double。"""
    def __init__(self):
        self.objects = {}
        self.puts = []

    def get_json(self, key):
        return (deepcopy(self.objects[key]), True) if key in self.objects else (None, False)

    def put_json_conditional(self, key, value, *, etag=None):
        assert (key not in self.objects) if etag is None else etag == "claim-etag"
        self.objects[key] = deepcopy(value)
        self.puts.append(deepcopy(value))
        return "claim-etag"


@pytest.fixture
def actual(tmp_path):
    content = (Path(__file__).parent / "fixtures/direct-roa/7911-S100YIAY-type5.zip").read_bytes()
    assert sha256(content).hexdigest() == "8ac619e4b5c5658e1aa86d80658030d8a9e01e57454546d4c2dd6ada504a9772"
    settings = SimpleNamespace(db_id=lambda name: _id(name), dry_run=False, raw_data_dir=tmp_path)
    prov = Provenance(Source.EDINET, source_license(Source.EDINET), date(2026, 3, 31), now_jst(),
                      raw_page_id=_id("raw"))
    tidy = edinet_csv_zip_to_tidy(content, "7911", prov.raw_page_id)
    financial = tidy_to_financial_record(tidy, "7911", prov, disclosure_type="本決算")
    assert financial is not None
    record = StockMasterRecord("7911", _dei(tidy, "FilerNameInJapaneseDEI"), prov,
                               edinet_code=_dei(tidy, "EDINETCodeDEI"))
    pre = _page("financial", settings.db_id("financials"), {
        **mod.financial_summary_properties(financial), S.PROP_MASTER_RELATION: mod.relation_prop([]),
    })
    master = _page("master", settings.db_id("stock_master"), mod.stock_master_properties(record))
    raw = _page("raw", settings.db_id("raw_files"), {
        S.RAW_PROP_DATATYPE: mod.text_prop("csv"), S.RAW_PROP_SCOPE: mod.text_prop("7911"),
        S.RAW_PROP_FILENAME: mod.title_prop("7911-S100YIAY-type5.zip"),
        S.RAW_PROP_SHA256: mod.text_prop(sha256(content).hexdigest()),
        S.RAW_PROP_SIZE: mod.number_prop(len(content)), **mod.provenance_properties(prov, include_raw_relation=False),
        S.RAW_PROP_FILES: {"files": [{"type": "file", "name": "7911-S100YIAY-type5.zip",
                                     "file": {"url": "https://declared-notion-transport.invalid/primary"}}]},
    })
    bucket, archives, patches, filters = Bucket(), [], [], []
    pages = {p["id"]: p for p in (pre, master, raw)}

    def query(db, **kwargs):
        filters.append((db, kwargs))
        return [deepcopy(master)] if db == settings.db_id("stock_master") else []

    def patch(method, path, *, json_body):
        assert method == "PATCH" and path == f"pages/{pre['id']}"
        assert json_body == {"properties": {S.PROP_MASTER_RELATION: mod.relation_prop([master["id"]])}}
        patches.append(deepcopy(json_body))
        pre["properties"][S.PROP_MASTER_RELATION]["relation"] = [{"id": master["id"]}]
        return deepcopy(pre)

    def archive(artifact):
        assert artifact.source == Source.CALC and artifact.scope == "7911"
        assert artifact.license_tag == prov.license_tag
        assert sha256(artifact.local_path.read_bytes()).hexdigest() == artifact.sha256
        archives.append(artifact)
        return _id(artifact.sha256)

    client = SimpleNamespace(query_database=query, get_page=lambda pid: deepcopy(pages[pid]), raw_api=patch,
                             download_file=lambda url, *, max_bytes: content,
                             retrieve_database=lambda db: {"properties": {name: {"id": name}
                                                           for name in pre["properties"]}})
    return SimpleNamespace(client=client, settings=settings, record=record, pre=pre, master=master,
                           raw=raw, bucket=bucket, archive=archive, archives=archives,
                           patches=patches, filters=filters, content=content)


def _repair(a):
    return mod.repair_financial_master_relation(a.client, a.settings, a.record, a.pre,
                                              raw_bucket=a.bucket, archive=a.archive)


def test_actual_primary_relation_only_full_pre_post_and_repeat_write_zero(actual):
    a, before = actual, deepcopy(actual.pre)
    assert _repair(a) == "repaired"
    expected = deepcopy(before["properties"])
    expected[S.PROP_MASTER_RELATION]["relation"] = [{"id": a.master["id"]}]
    assert a.pre["properties"] == expected and len(a.patches) == 1
    assert len(a.archives) == 2 and [p["status"] for p in a.bucket.puts] == ["pending", "completed"]
    assert "declared-notion-transport.invalid" not in str(a.bucket.objects)
    assert _repair(a) == "already_linked" and len(a.patches) == 1 and len(a.archives) == 2


def test_actual_financial_pre_archive_has_no_source_url(actual):
    assert _repair(actual) == "repaired"
    pre = actual.archives[0]
    assert pre.source == Source.CALC and pre.datatype == "financial-master-pre"
    assert pre.url == ""
    properties = file_upload._raw_row_properties(pre, [])
    assert properties[S.RAW_PROP_URL] == {"url": None}
    assert properties[S.PROP_SOURCE] == mod.select_prop(Source.CALC.value)
    assert pre.local_path.read_bytes() == mod._financial_relation_json(actual.bucket.puts[0])


@pytest.mark.parametrize("fault", ["issuer", "period", "scope", "sha", "missing-number", "no-cloud"])
def test_unqualified_or_missing_cloud_holds_before_claim(actual, fault):
    a = actual
    if fault == "issuer":
        a.record = replace(a.record, edinet_code="E00000")
    elif fault == "period":
        a.pre["properties"][S.FIN_PROP_PERIOD_END]["date"]["start"] = "2026-03-30"
    elif fault == "scope":
        a.raw["properties"][S.RAW_PROP_SCOPE] = _response({S.RAW_PROP_SCOPE: mod.text_prop("ALL")})[S.RAW_PROP_SCOPE]
    elif fault == "sha":
        a.client.download_file = lambda *args, **kwargs: a.content[:-1]
    elif fault == "missing-number":
        del a.pre["properties"][S.FIN_PROP_ROA]
    else:
        a.bucket = None
    with pytest.raises(mod.FinancialRelationHold):
        _repair(a)
    assert a.patches == a.archives == []
    if a.bucket:
        assert a.bucket.puts == []


@pytest.mark.parametrize("page,field,fault", [
    ("pre", S.FIN_PROP_TITLE, "has_more"), ("master", S.MASTER_PROP_NAME, "has_more"),
    ("pre", S.FIN_PROP_TITLE, "fragment"), ("master", S.PROP_RAW_RELATION, "relation"),
    ("pre", S.FIN_PROP_TITLE, "null-text"),
])
def test_any_incomplete_property_holds_before_claim(actual, page, field, fault):
    a = actual
    prop = getattr(a, page)["properties"][field]
    if fault == "has_more":
        prop["has_more"] = True
    elif fault == "fragment":
        del prop["title"][0]["plain_text"]
    elif fault == "null-text":
        prop["title"][0]["text"] = None
    else:
        prop["relation"] = [{"not_id": "declared incomplete"}]
    with pytest.raises(mod.FinancialRelationHold):
        _repair(a)
    assert a.bucket.puts == a.patches == a.archives == []


def test_missing_trash_state_is_not_assumed_false(actual):
    del actual.pre["in_trash"]
    with pytest.raises(mod.FinancialRelationHold, match="trash"):
        _repair(actual)
    assert actual.bucket.puts == actual.patches == actual.archives == []


def test_missing_native_or_abbreviated_legal_name_is_not_inferred(actual):
    a = actual
    a.record = replace(a.record, name=a.record.name.replace("株式会社", "(株)"))
    a.master["properties"][S.MASTER_PROP_NAME] = _response({
        S.MASTER_PROP_NAME: mod.title_prop(a.record.name),
    })[S.MASTER_PROP_NAME]
    with pytest.raises(mod.FinancialRelationHold, match="native"):
        _repair(a)
    assert a.bucket.puts == a.patches == a.archives == []


def test_native_zero_security_code_is_not_guessed_from_master(actual, monkeypatch):
    from jp_stock_pipeline.transform import direct_roa
    original = direct_roa._dei
    monkeypatch.setattr(direct_roa, "_dei", lambda tidy, name:
                        "00000" if name == "SecurityCodeDEI" else original(tidy, name))
    with pytest.raises(mod.FinancialRelationHold, match="native"):
        _repair(actual)
    assert actual.bucket.puts == actual.patches == actual.archives == []


@pytest.mark.parametrize("failure", ["physical-pre", "cas", "unknown-patch", "full-post", "complete-unknown"])
def test_any_unknown_after_claim_is_sticky_across_next_run(actual, failure):
    a = actual
    original_archive, patch, put = a.archive, a.client.raw_api, a.bucket.put_json_conditional
    if failure == "physical-pre":
        a.archive = lambda _: (_ for _ in ()).throw(RuntimeError("declared archive unknown"))
    elif failure == "cas":
        def changed(artifact):
            result = original_archive(artifact)
            a.pre["properties"][S.FIN_PROP_ROA]["number"] = None
            return result
        a.archive = changed
    elif failure in ("unknown-patch", "full-post"):
        def failed_patch(*args, **kwargs):
            result = patch(*args, **kwargs)
            if failure == "unknown-patch":
                raise RuntimeError("declared transport unknown after server applied")
            a.pre["properties"][S.FIN_PROP_ROA]["number"] = None
            return result
        a.client.raw_api = failed_patch
    else:
        def failed_complete(key, value, *, etag=None):
            if etag is not None:
                raise RuntimeError("declared complete transport unknown")
            return put(key, value, etag=etag)
        a.bucket.put_json_conditional = failed_complete
    with pytest.raises(RuntimeError):
        _repair(a)
    count = len(a.patches)
    assert list(a.bucket.objects.values())[0]["status"] == "pending"
    with pytest.raises(RuntimeError, match="再PATCH禁止"):
        _repair(a)
    assert len(a.patches) == count


def test_relation_dry_run_has_no_claim_archive_or_patch(actual):
    actual.settings.dry_run = True
    assert _repair(actual) == "planned"
    assert actual.bucket.puts == actual.archives == actual.patches == []


@pytest.mark.parametrize("phase", ["cas", "post"])
def test_incomplete_cas_or_post_after_claim_stops_whole_run_not_next_candidate(actual, phase):
    a = actual
    query, patch, archive = a.client.query_database, a.client.raw_api, a.archive
    next_page = deepcopy(a.pre)
    next_page["id"] = _id("next-unstarted-financial")
    a.client.query_database = lambda db, **kwargs: (
        [deepcopy(a.pre), next_page] if db == a.settings.db_id("financials") else query(db, **kwargs)
    )
    if phase == "cas":
        def incomplete_pre(artifact):
            result = archive(artifact)
            a.pre["properties"][S.FIN_PROP_TITLE]["has_more"] = True
            return result
        a.archive = incomplete_pre
    else:
        def incomplete_post(*args, **kwargs):
            result = patch(*args, **kwargs)
            a.pre["properties"][S.FIN_PROP_TITLE]["has_more"] = True
            return result
        a.client.raw_api = incomplete_post
    with pytest.raises(RuntimeError, match="claim後"):
        mod.sync_financial_master_relations(a.client, a.settings, [a.record], raw_bucket=a.bucket,
                                           archive=a.archive, on_hold=lambda *args: pytest.fail("claimed unknown swallowed"))
    assert len(a.bucket.objects) == 1 and list(a.bucket.objects.values())[0]["status"] == "pending"
    assert len(a.patches) == (0 if phase == "cas" else 1)


@pytest.mark.parametrize("code,edinet", [("79110", "E00692"), (" 7911", "E00692"),
                                         ("0000", "E00692"), ("7911", None)])
def test_unqualified_scope_stops_before_http(actual, code, edinet):
    a = actual
    a.record = replace(a.record, code=code, edinet_code=edinet)
    a.client.get_page = lambda _: pytest.fail("HTTP before identity validation")
    with pytest.raises(mod.FinancialRelationHold, match="未資格"):
        _repair(a)
    if code != "7911":
        a.client.retrieve_database = lambda _: pytest.fail("HTTP before scope validation")
        with pytest.raises(ValueError, match="非正準"):
            mod.sync_financial_master_relations(a.client, a.settings, [a.record],
                                               raw_bucket=a.bucket, archive=a.archive,
                                               on_hold=lambda *args: None)


def test_separate_valid_source_clocks_are_retained_without_order_inference(actual):
    a = actual
    a.raw["properties"][S.PROP_FETCHED_AT]["date"]["start"] = (now_jst() - timedelta(days=1)).isoformat()
    before = deepcopy(a.pre["properties"][S.PROP_FETCHED_AT])
    raw_before = deepcopy(a.raw["properties"][S.PROP_FETCHED_AT])
    assert _repair(a) == "repaired"
    assert a.pre["properties"][S.PROP_FETCHED_AT] == before
    assert a.raw["properties"][S.PROP_FETCHED_AT] == raw_before


@pytest.mark.parametrize("clock", ["2026-03-31T00:00:00", "2999-03-31T00:00:00Z"])
def test_missing_timezone_or_future_clock_holds_before_claim(actual, clock):
    a = actual
    a.raw["properties"][S.PROP_FETCHED_AT]["date"]["start"] = clock
    with pytest.raises(mod.FinancialRelationHold, match="時計"):
        _repair(a)
    assert a.bucket.puts == a.patches == a.archives == []


def test_selected_empty_projection_chunks_and_offscope_stop_before_repair(actual, monkeypatch):
    a = actual
    # コード一覧だけのtransportテスト。実行値として財務/主体を創作しない。
    records = [replace(a.record, code=f"{number:04d}") for number in range(1000, 1051)]
    calls = []
    a.client.query_database = lambda db, **kwargs: calls.append(kwargs) or []
    counts = mod.sync_financial_master_relations(a.client, a.settings, records,
                                                raw_bucket=a.bucket, archive=a.archive,
                                                on_hold=lambda *args: pytest.fail("unexpected HOLD"))
    assert counts["examined"] == 0 and [len(c["filter"]["and"][0]["or"]) for c in calls] == [50, 1]
    assert all(c["strict"] and len(c["filter_properties"]) == 7 for c in calls)
    assert all(c["filter"]["and"][1] == {"property": S.PROP_MASTER_RELATION, "relation": {"is_empty": True}}
               for c in calls)
    a.client.query_database = lambda *args, **kwargs: [deepcopy(a.pre)]
    with pytest.raises(ValueError, match="範囲"):
        mod.sync_financial_master_relations(a.client, a.settings, records,
                                           raw_bucket=a.bucket, archive=a.archive, on_hold=lambda *args: None)
    assert a.patches == []


def _known_pre_rejection(actual):
    a = actual
    archive = a.archive
    a.archive = lambda _: (_ for _ in ()).throw(RuntimeError("declared known PRE page rejection"))
    with pytest.raises(RuntimeError, match="known PRE"):
        _repair(a)
    a.archive = archive
    pending = deepcopy(next(iter(a.bucket.objects.values())))
    proof = {"code": a.record.code, "financialPageId": a.pre["id"],
             "controlKey": f"financial-master-relations/{a.pre['id']}.json",
             "oldPendingSha256": sha256(mod._financial_relation_json(pending)).hexdigest(),
             "oldPending": pending, "proofSha256": sha256(b"declared offline proof authorization").hexdigest()}
    a.bucket.etag = "old-claim"
    a.bucket.get_json_with_etag = lambda key, **kwargs: (
        deepcopy(a.bucket.objects[key]), mod._financial_relation_json(a.bucket.objects[key]), a.bucket.etag,
    )
    def put(key, value, *, etag=None):
        assert etag == a.bucket.etag
        a.bucket.etag = "consumed-marker" if value["status"] == "pending" else "complete"
        a.bucket.objects[key] = deepcopy(value)
        a.bucket.puts.append(deepcopy(value))
        return a.bucket.etag
    a.bucket.put_json_conditional = put
    return proof


def _reconcile(a, proof):
    return mod.reconcile_financial_master_pre_rejection(a.client, a.settings, proof,
                                                      raw_bucket=a.bucket, archive=a.archive)


def test_known_pre_rejection_consumes_once_and_preserves_original_pre(actual):
    a, proof = actual, _known_pre_rejection(actual)
    original = mod._financial_relation_json(proof["oldPending"])
    assert _reconcile(a, proof) == "repaired"
    assert a.archives[0].local_path.read_bytes() == original
    completed = a.bucket.objects[proof["controlKey"]]
    assert completed["started_at"] == proof["oldPending"]["started_at"]
    assert completed["pre"] == proof["oldPending"]["pre"]
    assert completed["reconcile"]["old_pending_sha256"] == sha256(original).hexdigest()
    assert completed["reconcile"]["proof_sha256"] == proof["proofSha256"]
    assert len(a.patches) == 1 and len(a.archives) == 2
    with pytest.raises(RuntimeError, match="再入禁止"):
        _reconcile(a, proof)
    assert len(a.patches) == 1


@pytest.mark.parametrize("fault", ["body", "pre", "native", "cas-unknown", "cas-applied-unknown", "patch-unknown"])
def test_reconcile_mismatch_or_unknown_never_blindly_repatches(actual, fault):
    a, proof = actual, _known_pre_rejection(actual)
    if fault == "body":
        a.bucket.objects[proof["controlKey"]]["started_at"] = now_jst().isoformat()
    elif fault == "pre":
        a.pre["properties"][S.FIN_PROP_ROA]["number"] = None
    elif fault == "native":
        a.master["properties"][S.MASTER_PROP_EDINET_CODE] = _response({
            S.MASTER_PROP_EDINET_CODE: mod.text_prop("E00000")})[S.MASTER_PROP_EDINET_CODE]
    elif fault in ("cas-unknown", "cas-applied-unknown"):
        put = a.bucket.put_json_conditional
        def unknown_cas(*args, **kwargs):
            if fault == "cas-applied-unknown":
                put(*args, **kwargs)
            raise RuntimeError("CAS unknown")
        a.bucket.put_json_conditional = unknown_cas
    else:
        patch = a.client.raw_api
        def unknown(*args, **kwargs):
            patch(*args, **kwargs)
            raise RuntimeError("PATCH unknown after application")
        a.client.raw_api = unknown
    with pytest.raises((RuntimeError, mod.FinancialRelationHold)):
        _reconcile(a, proof)
    assert len(a.patches) == (1 if fault == "patch-unknown" else 0)
    if fault in ("patch-unknown", "cas-applied-unknown"):
        assert "reconcile" in a.bucket.objects[proof["controlKey"]]
        with pytest.raises(RuntimeError, match="再入禁止"):
            _reconcile(a, proof)
        assert len(a.patches) == (1 if fault == "patch-unknown" else 0)
