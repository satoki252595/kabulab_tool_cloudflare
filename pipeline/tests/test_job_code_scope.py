"""実CLI入口で未対応の対象限定を拒否し、全市場処理へ変換しない。"""

from importlib import import_module
from unittest.mock import Mock

import pytest

from jp_stock_pipeline.jobs import master_sync, runner


UNSUPPORTED = (
    "edinet_daily", "tdnet_hourly", "supply_daily", "sector33_sync", "cloud_check",
    "license_map", "core_stocks_migrate", "freshness_probe", "ops_check",
)


@pytest.mark.parametrize("job", UNSUPPORTED)
@pytest.mark.parametrize("argv", [["--codes", "3776"], ["--code", "3776"], ["--codes="]])
def test_unsupported_cli_rejects_before_settings_or_execution(monkeypatch, capsys, job, argv):
    module = import_module(f"jp_stock_pipeline.jobs.{job}")
    load = Mock(side_effect=AssertionError("settings must not load"))
    execute = Mock(side_effect=AssertionError("job must not execute"))
    monkeypatch.setattr(runner, "load_settings", load)
    if hasattr(module, "load_settings"):
        monkeypatch.setattr(module, "load_settings", load)
    monkeypatch.setattr(module, "execute", execute)
    with pytest.raises(SystemExit) as error:
        module.main(argv, env={})
    assert error.value.code == 2
    assert "unrecognized arguments" in capsys.readouterr().err
    load.assert_not_called()
    execute.assert_not_called()


def test_master_cli_accepts_scope_through_normal_runner(monkeypatch, tmp_path):
    observed = []

    def execute(ctx):
        observed.append((master_sync._code_scope(ctx.args), ctx.args.limit))
        ctx.add_success()

    monkeypatch.setattr(master_sync, "execute", execute)
    assert master_sync.main(["--dry-run", "--codes=6963,634A", "--limit=1"],
                            env={"RAW_DATA_DIR": str(tmp_path)}) == 0
    assert observed == [({"6963", "634A"}, 1)]


@pytest.mark.parametrize("codes", ["", "6963,6963"])
def test_master_cli_retains_strict_scope_before_source(monkeypatch, tmp_path, codes):
    fetch = Mock(side_effect=AssertionError("source must not start"))
    monkeypatch.setattr(master_sync.edinet_codelist, "fetch_codelist", fetch)
    assert master_sync.main(["--dry-run", f"--codes={codes}"],
                            env={"RAW_DATA_DIR": str(tmp_path)}) == 1
    fetch.assert_not_called()
