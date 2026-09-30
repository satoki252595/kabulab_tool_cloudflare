"""sector33-only cadence ジョブのテスト (offline のみ)。

実際の保存済み source (実フィクスチャ) と実際の helper
(parse/normalize/plan/build) を使い、境界 (fetch/D1/CLI) だけを差し替える。
診断 taxonomy の全種別を cover する。D1/Notion/source への実送は 0。
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from datetime import date
from pathlib import Path
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


class StrictArchiveDouble:
    """厳格原本契約の offline replay (TS CLI + shared verifier の契約)。

    - record は key ごとに論理 1 回・force=false。未見 key → 記録。
      同一 key + 同一 2 件 bytes → skipped_existing。同一 key + 異 bytes →
      conflict 失敗。失敗後に別 key を発明しない。
    - unique: key→page 1:1 (dict で機械保証。重複生成の経路なし)。
    - verify: hosted 層から読んだ 2 件の名前集合・バイト長・SHA256 全比較
      (shared verifyArchivedAttachments の契約。record 層と hosted 層は
      分離し、hosted 改竄は照合で落ちる)。
    - producer 検査: CLI の --key と manifest 本文 key の一致、
      manifest の zipSha256/zipBytes と zip 実体の一致を要求する。
    """

    def __init__(self):
        self.pages: dict[str, dict] = {}
        self.hosted: dict[str, dict[str, bytes]] = {}
        self.record_calls = 0
        self.cmds: list[list[str]] = []

    def _fail(self, reason: str):
        return SimpleNamespace(returncode=1, stdout="", stderr=f"FAIL: {reason}")

    def _verify(self, key: str, want: dict[str, bytes]) -> str | None:
        got = self.hosted.get(key)
        if got is None:
            return "hosted 層なし"
        if set(got) != set(want):
            return f"ファイル名集合不一致 (期待 {sorted(want)} 実際 {sorted(got)})"
        for name, body in want.items():
            actual = got[name]
            if len(actual) != len(body):
                return f"{name}: バイト長不一致 (期待 {len(body)} 実際 {len(actual)})"
            if hashlib.sha256(actual).hexdigest() != hashlib.sha256(body).hexdigest():
                return f"{name}: SHA256 不一致"
        return None

    def cli(self, cmd: list[str], timeout_s: int = 0):
        self.cmds.append(cmd)
        args = {}
        for a in cmd:
            if a.startswith("--") and "=" in a:
                k, v = a[2:].split("=", 1)
                args[k] = v
        key = args["key"]
        zip_path = Path(args["zip"])
        man_path = Path(args["manifest"])
        zip_bytes = zip_path.read_bytes()
        manifest_raw = man_path.read_bytes()
        try:
            manifest = json.loads(manifest_raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._fail("manifest が JSON でない")
        if manifest.get("key") != key:
            return self._fail("--key と manifest 本文 key の不一致")
        if manifest.get("zipSha256") != hashlib.sha256(zip_bytes).hexdigest():
            return self._fail("manifest zipSha256 と zip 実体の不一致")
        if manifest.get("zipBytes") != len(zip_bytes):
            return self._fail("manifest zipBytes と zip 実体の不一致")
        self.record_calls += 1
        files = {zip_path.name: zip_bytes, man_path.name: manifest_raw}
        page = self.pages.get(key)
        if page is None:
            page_id = f"page-{len(self.pages) + 1}"
            self.pages[key] = {"pageId": page_id, "files": dict(files)}
            self.hosted[key] = {n: bytes(b) for n, b in files.items()}
        else:
            same = set(page["files"]) == set(files) and all(
                hashlib.sha256(page["files"][n]).hexdigest() == hashlib.sha256(b).hexdigest()
                for n, b in files.items()
            )
            if not same:
                return self._fail(f"{key}: 同一 key に異 bytes (force=false のため失敗)")
        problem = self._verify(key, files)
        if problem is not None:
            return self._fail(f"照合失敗: {problem}")
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {"ok": True, "verified": True, "pageId": self.pages[key]["pageId"]}
            ),
            stderr="",
        )


def _wire_strict(monkeypatch, tmp_path, store, data: bytes | None = None):
    """fetch/D1 実形 + 厳格原本 replay。戻りは double。"""
    art = _artifact(tmp_path, data)
    monkeypatch.setattr(edinet_codelist, "fetch_codelist", lambda settings: art)
    monkeypatch.setattr(mod, "D1Store", lambda *a, **k: store)
    dbl = StrictArchiveDouble()
    monkeypatch.setattr(mod, "_run_archive_cli", dbl.cli)
    return dbl


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
        keys = [a for a in cmd if a.startswith("--key=")]
        assert len(keys) == 1
        assert re.fullmatch(r"--key=edinet-codelist-2026-06-10-[0-9a-f]{12}", keys[0])
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

    def test_invalid_issuer_stop(self, monkeypatch, tmp_path):
        """不正 nonempty issuer は prewrite STOP。壊れた世代は custody しない。"""
        lines = _fixture_text().split("\n")
        header = next(csv.reader([lines[1]]))
        ei = header.index("ＥＤＩＮＥＴコード")
        row = next(csv.reader([lines[2]]))
        row[ei] = "XYZ"
        lines[2] = _quoted(row)
        data = _make_zip({"EdinetcodeDlInfo.csv": "\n".join(lines)})
        store = _SectorD1([])
        _wire(monkeypatch, tmp_path, store, cli="boom", data=data)
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert report.stopped == "invalid-issuer-stop"
        assert store.write_sql == []
        assert state["failed"] == 1

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

    def test_blank_issuer_retain_and_gap(self, monkeypatch, tmp_path):
        """blank issuer は既 sector 保持。NULL 残存は gap (partial の種)。"""
        lines = _fixture_text().split("\n")
        header = next(csv.reader([lines[1]]))
        ei = header.index("ＥＤＩＮＥＴコード")
        row = next(csv.reader([lines[2]]))
        row[ei] = ""
        lines[2] = _quoted(row)
        data = _make_zip({"EdinetcodeDlInfo.csv": "\n".join(lines)})
        ticker = edinet_codelist.parse_codelist(_zip_bytes())[0].code
        store = _SectorD1([(ticker, "輸送用機器", 1, "equity")])
        _wire(monkeypatch, tmp_path, store, data=data)
        ctx, state = _ctx()
        report = mod.execute(ctx)
        assert "blank-issuer-hold" in [h.kind for h in report.holds]
        assert report.stopped is None
        assert store.values()[ticker][0] == "輸送用機器"
        assert state["failed"] == 0
        store2 = _SectorD1([(ticker, None, 1, "equity")])
        _wire(monkeypatch, tmp_path, store2, data=data)
        ctx2, state2 = _ctx()
        report2 = mod.execute(ctx2)
        assert report2.gaps == [ticker]
        assert state2["failed"] == 1

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
        """同日 source の正常な繰り返し producer を厳格契約で対照する。

        両 run とも archive 成功 (record 各 1 回・新世代 key・照合一致)。
        1 回目は N 行書込、2 回目は D1 差分 0。先行 pin の bytes は不変。
        """
        (t1, _), (t2, _) = _real_tickers(2)
        store = _SectorD1([(t1, None, 1, "equity"), (t2, None, 1, "equity")])
        dbl = _wire_strict(monkeypatch, tmp_path, store)
        ctx1, state1 = _ctx()
        report1 = mod.execute(ctx1)
        assert state1["failed"] == 0
        writes1 = len(store.write_sql)
        assert writes1 > 0
        assert report1.written > 0
        assert report1.archive_page_id == "page-1"
        ctx2, state2 = _ctx()
        report2 = mod.execute(ctx2)
        assert len(store.write_sql) == writes1
        assert report2.planned == 0
        assert report2.written == 0
        assert state2["failed"] == 0
        assert report2.archive_page_id == "page-2"
        # 厳格契約の機械的事実: 単発 record × 2、新世代 key × 2、先行 pin 不変。
        assert dbl.record_calls == 2
        assert len(dbl.cmds) == 2
        key1 = next(a for a in dbl.cmds[0] if a.startswith("--key="))[6:]
        key2 = next(a for a in dbl.cmds[1] if a.startswith("--key="))[6:]
        assert key1 != key2
        assert set(dbl.pages) == {key1, key2}
        for key in (key1, key2):
            assert re.fullmatch(r"edinet-codelist-2026-06-10-[0-9a-f]{12}", key)
        zip_name = Path(next(a for a in dbl.cmds[0] if a.startswith("--zip="))[6:]).name
        assert dbl.pages[key1]["files"][zip_name] == _zip_bytes()
        assert (
            hashlib.sha256(dbl.pages[key1]["files"][zip_name]).hexdigest()
            == hashlib.sha256(_zip_bytes()).hexdigest()
        )

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


class TestGenerationKey:
    def _capture(self) -> dict:
        return {
            "asOf": "2026-06-10",
            "zipSha256": hashlib.sha256(_zip_bytes()).hexdigest(),
            "zipBytes": len(_zip_bytes()),
            "requestedAt": "2026-06-10T00:00:00+00:00",
            "completedAt": "2026-06-10T00:00:01+00:00",
            "listedRecords": len(edinet_codelist.parse_codelist(_zip_bytes())),
            "sourceUrl": edinet_codelist.CODELIST_URL,
        }

    def test_derives_from_capture_only(self):
        """同一 capture は同一 key。`key` 自記は digest 対象外。now() 不使用。"""
        cap = self._capture()
        k1 = mod._generation_key("2026-06-10", cap)
        k2 = mod._generation_key("2026-06-10", dict(cap))
        assert k1 == k2
        assert re.fullmatch(r"edinet-codelist-2026-06-10-[0-9a-f]{12}", k1)
        cap["key"] = k1
        assert mod._generation_key("2026-06-10", cap) == k1

    def test_changes_with_capture(self):
        """1 要素でも違えば別世代 (正直な新 key)。"""
        cap = self._capture()
        base = mod._generation_key("2026-06-10", cap)
        other = dict(cap, zipSha256="0" * 64)
        assert mod._generation_key("2026-06-10", other) != base
        other = dict(cap, completedAt="2026-06-10T00:00:02+00:00")
        assert mod._generation_key("2026-06-10", other) != base
        assert mod._generation_key("2026-06-11", cap).startswith("edinet-codelist-2026-06-11-")

    def test_never_bare_asof(self):
        """旧 `edinet-codelist-{asof}` 形と衝突しない (既存 pin 保全)。"""
        cap = self._capture()
        for asof in ("2026-06-10", "2026-09-30"):
            assert mod._generation_key(asof, cap) != f"edinet-codelist-{asof}"


class TestStrictReplay:
    def test_conflict_same_key_different_bytes_no_escape(self, monkeypatch, tmp_path):
        """同一 key + 異 bytes は失敗し、別 key を発明しない。既存 pin 不変。"""
        t1 = _real_tickers(1)[0][0]
        store = _SectorD1([(t1, None, 1, "equity")])
        dbl = _wire_strict(monkeypatch, tmp_path, store)
        ctx, _ = _ctx()
        assert mod.execute(ctx).stopped is None
        assert len(dbl.pages) == 1
        key1 = next(iter(dbl.pages))
        cmd1 = dbl.cmds[0]
        zip_arg = next(a for a in cmd1 if a.startswith("--zip="))[6:]
        man_arg = next(a for a in cmd1 if a.startswith("--manifest="))[11:]
        # 異 bytes + 自己無撞着な manifest (key は key1 のまま) で再送する。
        evil_zip = tmp_path / "evil.zip"
        evil_zip.write_bytes(_zip_bytes() + b"x")
        manifest = json.loads(Path(man_arg).read_text(encoding="utf-8"))
        manifest["zipSha256"] = hashlib.sha256(evil_zip.read_bytes()).hexdigest()
        manifest["zipBytes"] = len(evil_zip.read_bytes())
        evil_man = tmp_path / "evil-manifest.json"
        evil_man.write_text(json.dumps(manifest), encoding="utf-8")
        cmd2 = [a for a in cmd1 if not a.startswith("--zip=") and not a.startswith("--manifest=")]
        cmd2 += [f"--zip={evil_zip}", f"--manifest={evil_man}"]
        res = dbl.cli(cmd2)
        assert res.returncode == 1
        assert "force=false" in res.stderr
        # 逃げ key なし・既存 pin 不変。
        assert set(dbl.pages) == {key1}
        assert dbl.pages[key1]["files"][Path(zip_arg).name] == _zip_bytes()

    def test_hosted_tamper_fails_verify(self, monkeypatch, tmp_path):
        """hosted 層の同長改竄は SHA 照合で落ちる (record skipped でも検証)。"""
        t1 = _real_tickers(1)[0][0]
        store = _SectorD1([(t1, None, 1, "equity")])
        dbl = _wire_strict(monkeypatch, tmp_path, store)
        ctx, _ = _ctx()
        assert mod.execute(ctx).stopped is None
        key1 = next(iter(dbl.pages))
        zip_name = Path(next(a for a in dbl.cmds[0] if a.startswith("--zip="))[6:]).name
        tampered = bytearray(dbl.hosted[key1][zip_name])
        tampered[0] ^= 0xFF
        dbl.hosted[key1][zip_name] = bytes(tampered)
        res = dbl.cli(dbl.cmds[0])
        assert res.returncode == 1
        assert "SHA256 不一致" in res.stderr

    def test_manifest_pin_mismatch_fails(self, monkeypatch, tmp_path):
        """manifest pin と実体の不一致は producer 検査で落ちる。"""
        t1 = _real_tickers(1)[0][0]
        store = _SectorD1([(t1, None, 1, "equity")])
        dbl = _wire_strict(monkeypatch, tmp_path, store)
        ctx, _ = _ctx()
        assert mod.execute(ctx).stopped is None
        man_arg = next(a for a in dbl.cmds[0] if a.startswith("--manifest="))[11:]
        manifest = json.loads(Path(man_arg).read_text(encoding="utf-8"))
        manifest["zipBytes"] = manifest["zipBytes"] + 1
        evil_man = tmp_path / "evil-manifest.json"
        evil_man.write_text(json.dumps(manifest), encoding="utf-8")
        cmd = [a for a in dbl.cmds[0] if not a.startswith("--manifest=")]
        cmd += [f"--manifest={evil_man}"]
        res = dbl.cli(cmd)
        assert res.returncode == 1
        assert "zipBytes" in res.stderr
        assert dbl.record_calls == 1


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
                "invalid-issuer-stop",
                "renormalize-stop",
                "ambiguous-sector-stop",
                "unmapped-sector-nontarget",
                "blank-issuer-hold",
                "sector33-gap",
                "archive-failure",
                "config-stop",
            }
        )
