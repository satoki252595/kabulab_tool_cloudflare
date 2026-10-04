"""Cloud diagnostics follow the current schema and cannot count unrelated tables."""

from argparse import Namespace
from types import SimpleNamespace

import pytest
from _doubles import FakeR2, SqliteD1

from jp_stock_pipeline.cloud_store.schema import SCHEMA_STATEMENTS
from jp_stock_pipeline.config import CloudStoreSettings
from jp_stock_pipeline.jobs import cloud_check
from jp_stock_pipeline.jobs.runner import JobContext


@pytest.mark.parametrize("missing_financials", [False, True])
def test_required_tables_are_checked_by_name(monkeypatch, caplog, missing_financials):
    store = SqliteD1(ddl=SCHEMA_STATEMENTS)
    if missing_financials:
        store.con.execute("DROP TABLE jss_financials")
        for name in ("jss_extra_one", "jss_extra_two"):
            store.con.execute(f"CREATE TABLE {name} (id INTEGER)")
    r2 = FakeR2()
    monkeypatch.setattr(CloudStoreSettings, "r2_enabled", lambda self: True)
    monkeypatch.setattr(CloudStoreSettings, "d1_enabled", lambda self: True)
    monkeypatch.setattr(cloud_check, "D1Store", lambda *a, **kw: store)
    monkeypatch.setattr(cloud_check, "R2Store", lambda *a, **kw: r2)
    ctx = JobContext(
        settings=SimpleNamespace(cloud_store=CloudStoreSettings()),
        client=None,
        args=Namespace(),
    )

    cloud_check.execute(ctx)

    assert ctx.failed == int(missing_financials)
    assert ctx.processed == (2 if missing_financials else 3)
    if missing_financials:
        assert "jss_financials" in caplog.text
    assert store.write_sql == []
    assert r2.puts == []
    assert r2.heads == [cloud_check.PROBE_KEY, cloud_check.PROBE_KEY]
    store.con.close()
