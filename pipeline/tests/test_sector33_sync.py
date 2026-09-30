"""sector33-only cadence ジョブのテスト (offline のみ)。

実際の保存済み source (実フィクスチャ) と実際の helper
(parse/normalize/plan/build) を使い、境界 (fetch/D1/CLI) だけを差し替える。
診断 taxonomy の全種別を cover する。D1/Notion/source への実送は 0。
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date
from types import SimpleNamespace

import pytest
from _doubles import SqliteD1
from conftest import fixture_path
from test_core_stocks_migrate import APPLIED_DDL, PROD_DDL
from test_edinet_codelist import _make_zip

from jp_stock_pipeline.collectors import edinet_codelist
from jp_stock_pipeline.config import CloudStoreSettings
from jp_stock_pipeline.jobs import sector33_sync as mod
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Source
from jp_stock_pipeline.rawstore import save_raw

FIXTURE = "edinet/Edinetcode.zip"
_D1_ENV = {"CF_ACCOUNT_ID": "acct", "CF_API_TOKEN": "token", "CF_D1_DATABASE_ID": "db"}


def _zip_bytes() -> bytes:
    return fixture_path(FIXTURE).read_bytes()


def _fixture_text() -> str:
    return mod._read_codelist_csv(_zip_bytes())


def _artifact(tmp_path, data: bytes | None = None):
    return save_raw(
        data if data is not None else _zip_bytes(),
        source=Source.EDINET,
        datatype="codelist",
        scope="ALL",
        data_date=date(2026, 6, 10),
        url=edinet_codelist.CODELIST_URL,
        ext="zip",
        license_tag=LicenseTag.COMMERCIAL_OK,
        base_dir=tmp_path,
    )


def _ctx(*, dry_run: bool = False):
    cloud = CloudStoreSettings(
        cf_account_id="acct", cf_api_token="token", d1_database_id="db"
    )
    state: dict = {"processed": 0, "failed": 0, "codes": []}

    def add_failure(code: str, reason: str = "") -> None:
        state["failed"] += 1
        state["codes"].append((code, reason))

    def add_success(n: int = 1) -> None:
        state["processed"] += n

    ctx = SimpleNamespace(
        settings=SimpleNamespace(cloud_store=cloud, dry_run=dry_run),
        args=SimpleNamespace(limit=None, codes=None, date=None),
        add_failure=add_failure,
        add_success=add_success,
    )
    return ctx, state


class _SectorD1(SqliteD1):
    """本番形 core_stocks + active/種別 seed。"""

    def __init__(self, rows: list[tuple[str, str | None, int, str | None]]):
        super().__init__()
        self.con.executescript(PROD_DDL)
        for stmt in APPLIED_DDL:
            self.con.execute(stmt)
        for code, sector33, active, itype in rows:
            self.con.execute(
                "INSERT INTO core_stocks (code, name, market, sector, updated_at,"
                " sector33, is_active, instrument_type)"
                " VALUES (?, ?, 'プライム（内国株式）', NULL, 1000, ?, ?, ?)",
                [code, f"銘柄{code}", sector33, active, itype],
            )
        self.con.commit()

    def values(self) -> dict[str, tuple[str | None, int, int, str | None]]:
        return {
            code: (sector33, updated_at, is_active, itype)
            for code, sector33, updated_at, is_active, itype in self.con.execute(
                "SELECT code, sector33, updated_at, is_active, instrument_type"
                " FROM core_stocks"
            )
        }


def _cli_ok(monkeypatch, holder: dict, page_id: str = "page-1"):
    def fake(cmd: list[str], timeout_s: int = 0):
        holder["cmd"] = cmd
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"ok": True, "verified": True, "pageId": page_id}),
            stderr="",
        )

    monkeypatch.setattr(mod, "_run_archive_cli", fake)


def _cli_fail(monkeypatch, holder: dict):
    def fake(cmd: list[str], timeout_s: int = 0):
        holder["cmd"] = cmd
        return SimpleNamespace(returncode=1, stdout="", stderr="HOLD: no unique")

    monkeypatch.setattr(mod, "_run_archive_cli", fake)


def _wire(monkeypatch, tmp_path, store, *, cli: str = "ok", data: bytes | None = None):
    holder: dict = {}
    art = _artifact(tmp_path, data)
    monkeypatch.setattr(edinet_codelist, "fetch_codelist", lambda settings: art)
    monkeypatch.setattr(mod, "D1Store", lambda *a, **k: store)
    if cli == "ok":
        _cli_ok(monkeypatch, holder)
    elif cli == "fail":
        _cli_fail(monkeypatch, holder)
    elif cli == "boom":
        def no_cli(*a, **k):
            raise AssertionError("CLI must not run")

        monkeypatch.setattr(mod, "_run_archive_cli", no_cli)
    else:
        raise AssertionError(f"unknown cli mode {cli}")
    return holder


def _append_rows_csv(extra_lines: list[str]) -> bytes:
    """実フィクスチャの CSV 末尾に quoted 行を足して zip 化する。"""
    lines = _fixture_text().split("\n")
    if lines[-1] == "":
        lines[-1:] = extra_lines
    else:
        lines.extend(extra_lines)
    return _make_zip({"EdinetcodeDlInfo.csv": "\n".join(lines)})


def _quoted(cells: list[str]) -> str:
    buf = io.StringIO()
    csv.writer(buf, lineterminator="").writerow(cells)
    return buf.getvalue()


def _real_tickers(n: int) -> list[tuple[str, str | None]]:
    """実フィクスチャの先頭 listed (ticker, sector) を実 parser で取る。"""
    records = edinet_codelist.parse_codelist(_zip_bytes())
    return [(r.code, r.sector33) for r in records[:n]]


class TestConfigStop:
    @pytest.mark.parametrize(
        "env_extra,argv",
        [
            ({}, []),
            ({"LOCAL_DB_HOST": "h"}, []),
            (_D1_ENV, ["--limit", "5"]),
            (_D1_ENV, ["--codes", "7203"]),
        ],
    )
    def test_main_returns_2_without_run_job(self, monkeypatch, env_extra, argv):
        def no_run(*a, **k):
            raise AssertionError("run_job must not run")

        monkeypatch.setattr(mod, "run_job", no_run)
        assert mod.main(argv, env=env_extra) == 2

    def test_main_delegates_to_run_job(self, monkeypatch):
        seen: dict = {}

        def fake_run(job_name, fn, argv, **kwargs):
            seen["job"] = job_name
            seen["fn"] = fn
            return 0

        monkeypatch.setattr(mod, "run_job", fake_run)
        assert mod.main([], env=dict(_D1_ENV)) == 0
        assert seen["job"] == mod.JOB_NAME
        assert seen["fn"] is mod.execute


class TestArchiveGate:
    def test_archive_failure_writes_zero(self, monkeypatch, tmp_path):
        t1 = _real_tickers(1)[0][0]
        store = _SectorD1([(t1, None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store, cli="fail")
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert report.stopped == "archive-failure"
        assert store.write_sql == []
        assert state["failed"] == 1
        assert state["codes"][0][0] == "sector33-archive"
        assert report.archive_page_id is None

    def test_cli_receives_key_and_paths(self, monkeypatch, tmp_path):
        store = _SectorD1([])
        holder = _wire(monkeypatch, tmp_path, store, cli="ok")
        ctx, _ = _ctx()
        mod.execute(ctx)
        cmd = holder["cmd"]
        assert any(a.startswith("--key=edinet-codelist-2026-06-10") for a in cmd)
        assert any(a.endswith("edinet-codelist-archive.ts") for a in cmd)


class TestPrewriteStops:
    def _dup_fixture(self) -> bytes:
        lines = _fixture_text().split("\n")
        data_line = next(line for line in lines[2:] if line.strip())
        return _append_rows_csv([data_line])

    def test_duplicate_ticker_stop(self, monkeypatch, tmp_path):
        """共有検査で STOP。壊れた世代は custody しない (CLI 不呼出)。"""
        store = _SectorD1([])
        _wire(monkeypatch, tmp_path, store, cli="boom", data=self._dup_fixture())
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert report.stopped == "dup-ticker-stop"
        assert store.write_sql == []
        assert state["failed"] == 1
        assert state["codes"][0][0] == "sector33-prewrite-dup-ticker-stop"

    def test_duplicate_issuer_stop(self, monkeypatch, tmp_path):
        records = edinet_codelist.parse_codelist(_zip_bytes())
        codes = {r.code for r in records}
        assert "9999" not in codes
        src = records[0]
        cells = ["E00004_dup", "", "上場", "", "", "", "テスト", "", "", "", "化学", "99990", ""]
        assert src.edinet_code is not None
        cells[0] = src.edinet_code
        store = _SectorD1([(src.code, None, 1, "equity"), ("9999", None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store, cli="boom", data=_append_rows_csv([_quoted(cells)]))
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert report.stopped == "dup-issuer-stop"
        assert store.write_sql == []

    def test_renormalize_defense_stop(self):
        with pytest.raises(mod.SectorPrewriteStop) as ei:
            mod._verify_normalization([{"ticker": "ZZZ9", "raw": "garbage!!!", "line": 3}])
        assert ei.value.kind == "renormalize-stop"

    def test_ambiguous_sector_stop(self, monkeypatch, tmp_path):
        lines = _fixture_text().split("\n")
        header = next(csv.reader([lines[1]]))
        si = header.index("提出者業種")
        row = next(csv.reader([lines[2]]))
        row[si] = "未知業種X"
        lines[2] = _quoted(row)
        data = _make_zip({"EdinetcodeDlInfo.csv": "\n".join(lines)})
        ticker = edinet_codelist.parse_codelist(_zip_bytes())[0].code
        store = _SectorD1([(ticker, None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store, data=data)
        ctx, _ = _ctx()
        report = mod.execute(ctx)
        assert report.stopped == "ambiguous-sector-stop"
        assert store.write_sql == []

    def test_known_unmapped_active_stop(self, monkeypatch, tmp_path):
        store = _SectorD1([("7699", None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store)
        ctx, _ = _ctx()
        report = mod.execute(ctx)
        assert report.stopped == "ambiguous-sector-stop"
        assert store.write_sql == []


class TestHoldsContinue:
    def test_legal_missing_ticker_hold(self, monkeypatch, tmp_path):
        """空は scan が、`00000` は共有検査が HOLD する (計 2 件で継続)。"""
        head = next(csv.reader([_fixture_text().split("\n")[1]]))
        assert len(head) == 13
        rows = [
            _quoted(["E99991", "", "上場", "", "", "", "空コード", "", "", "", "化学", "", ""]),
            _quoted(["E99992", "", "上場", "", "", "", "ゼロコード", "", "", "", "化学", "00000", ""]),
        ]
        (t1, s1), (t2, _) = _real_tickers(2)
        store = _SectorD1([(t1, None, 1, "equity"), (t2, None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store, data=_append_rows_csv(rows))
        ctx, state = _ctx()
        report = mod.execute(ctx)
        kinds = [h.kind for h in report.holds]
        assert kinds.count("legal-missing-ticker") == 2
        assert report.stopped is None
        assert state["failed"] == 0
        assert store.values()[t1][0] == s1

    def test_invalid_ticker_info(self, monkeypatch, tmp_path):
        rows = [_quoted(["E99993", "", "上場", "", "", "", "不正", "", "", "", "化学", "ABCDE", ""])]
        t1 = _real_tickers(1)[0][0]
        store = _SectorD1([(t1, None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store, data=_append_rows_csv(rows))
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert "invalid-ticker" in [h.kind for h in report.holds]
        assert report.stopped is None
        assert state["failed"] == 0

    def test_unmapped_nontarget_hold(self, monkeypatch, tmp_path):
        store = _SectorD1([("7699", "輸送用機器", 0, "equity")])
        _wire(monkeypatch, tmp_path, store)
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert "unmapped-sector-nontarget" in [h.kind for h in report.holds]
        assert report.stopped is None
        assert state["failed"] == 0
        assert store.values()["7699"][0] == "輸送用機器"

class TestWriterSemantics:
    def test_unknown_sector_retained(self, monkeypatch, tmp_path):
        store = _SectorD1([("9999", "輸送用機器", 1, "equity"), ("9998", None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store)
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert store.values()["9999"][0] == "輸送用機器"
        assert "9998" in report.gaps
        assert state["failed"] == 1

    def test_non_equity_untouched(self, monkeypatch, tmp_path):
        (t1, s1), (t2, _), (t3, _) = _real_tickers(3)
        store = _SectorD1(
            [
                (t1, None, 1, "equity"),
                (t2, None, 1, "etf"),
                (t3, None, 0, "equity"),
            ]
        )
        _wire(monkeypatch, tmp_path, store)
        ctx, _ = _ctx()
        mod.execute(ctx)
        assert store.sql_log[0] == mod.ACTIVE_SNAPSHOT_SQL
        assert store.values()[t1][0] == s1
        assert store.values()[t2][0] is None
        assert store.values()[t3][0] is None

    def test_second_run_zero_diff(self, monkeypatch, tmp_path):
        (t1, _), (t2, _) = _real_tickers(2)
        store = _SectorD1([(t1, None, 1, "equity"), (t2, None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store)
        ctx1, state1 = _ctx()
        mod.execute(ctx1)
        assert state1["failed"] == 0
        writes1 = len(store.write_sql)
        assert writes1 > 0
        ctx2, state2 = _ctx()
        report2 = mod.execute(ctx2)
        assert len(store.write_sql) == writes1
        assert report2.written == 0
        assert state2["failed"] == 0

    def test_sector_only_and_updated_at(self, monkeypatch, tmp_path):
        (t1, _), (t2, _) = _real_tickers(2)
        store = _SectorD1([(t1, None, 1, "equity"), (t2, "化学", 1, "equity")])
        before = store.values()
        _wire(monkeypatch, tmp_path, store)
        ctx, _ = _ctx()
        mod.execute(ctx)
        for sql in store.write_sql:
            assert sql.startswith("UPDATE core_stocks SET sector33 = ? WHERE code IN (")
            assert "updated_at" not in sql
        after = store.values()
        for code in before:
            assert after[code][1] == before[code][1] == 1000
            assert after[code][2:] == before[code][2:]

    def test_blank_sector_keeps_and_gaps(self, monkeypatch, tmp_path):
        lines = _fixture_text().split("\n")
        header = next(csv.reader([lines[1]]))
        si = header.index("提出者業種")
        row = next(csv.reader([lines[2]]))
        row[si] = ""
        lines[2] = _quoted(row)
        data = _make_zip({"EdinetcodeDlInfo.csv": "\n".join(lines)})
        ticker = edinet_codelist.parse_codelist(_zip_bytes())[0].code
        store = _SectorD1([(ticker, None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store, data=data)
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert report.stopped is None
        assert report.gaps == [ticker]
        assert state["failed"] == 1

    def test_happy_path_matches_real_helpers(self, monkeypatch, tmp_path):
        recs = edinet_codelist.parse_codelist(_zip_bytes())
        (t1, s1), (t2, s2), (t3, s3) = [(r.code, r.sector33) for r in recs[:3]]
        store = _SectorD1(
            [
                (t1, None, 1, "equity"),
                (t2, "化学", 1, "equity"),
                (t3, s3, 1, "equity"),
                ("9999", "輸送用機器", 1, "equity"),
                ("9998", None, 1, "equity"),
            ]
        )
        _wire(monkeypatch, tmp_path, store)
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert state["failed"] == 1  # gap 9998 のみ
        assert report.gaps == ["9998"]
        assert store.values()[t1][0] == s1
        assert store.values()[t2][0] == s2
        assert store.values()[t3][0] == s3
        assert store.values()["9999"][0] == "輸送用機器"
        assert report.archive_page_id == "page-1"

    def test_dry_run_writes_zero(self, monkeypatch, tmp_path):
        t1 = _real_tickers(1)[0][0]
        store = _SectorD1([(t1, None, 1, "equity")])
        art = _artifact(tmp_path)
        monkeypatch.setattr(edinet_codelist, "fetch_codelist", lambda settings: art)
        monkeypatch.setattr(mod, "D1Store", lambda *a, **k: store)

        def no_cli(*a, **k):
            raise AssertionError("CLI must not run in dry-run")

        monkeypatch.setattr(mod, "_run_archive_cli", no_cli)
        ctx, state = _ctx(dry_run=True)
        report = mod.execute(ctx)
        assert store.write_sql == []
        assert state["failed"] == 0
        assert report.stopped is None


class TestAgreementAndTaxonomy:
    def test_scan_parser_agreement(self):
        records = edinet_codelist.parse_codelist(_zip_bytes())
        admitted, _ = mod._scan_listed_rows(_zip_bytes())
        phantom = {r.code for r in records} - {a["ticker"] for a in admitted}
        assert phantom <= {"0000"}
        assert {a["ticker"] for a in admitted} <= {r.code for r in records}

    def test_taxonomy_exact(self):
        assert mod.DIAG_KINDS == frozenset(
            {
                "legal-missing-ticker",
                "invalid-ticker",
                "dup-ticker-stop",
                "dup-issuer-stop",
                "renormalize-stop",
                "ambiguous-sector-stop",
                "unmapped-sector-nontarget",
                "sector33-gap",
                "archive-failure",
                "config-stop",
            }
        )
