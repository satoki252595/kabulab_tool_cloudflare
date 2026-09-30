"""EDINET sector33 のみ同期する cadence ジョブ (sector33-only)。

再利用する既存部品: collector (`fetch_codelist`) + strict parser
(`parse_codelist`) + 共有候補検査 (`inspect_codelist_candidates`) +
`run_job` + `plan_sector33_updates` / `build_sector33_updates`。
原本 custody は薄い TS CLI (`scripts/sync/edinet-codelist-archive.ts`) を
subprocess で呼ぶ 1 経路のみ。`ctx.upload_raw` / local / R2 原本 SDK は呼ばない。
順序は [完全性 gate] → [custody] → [target gate] → [write]。
壊れた世代は custody しない。

不変条件:
- D1 へ書くのは `sector33` 列の差分だけ (`updated_at` 他は不変。builder が担保)。
- pre-write STOP (書込 0): qualified 対象の code/issuer 重複・不正正規化・
  曖昧 sector。銘柄名での join はしない。
- 合法欠損 (listed 行の空/`00000` ticker) は typed HOLD 診断で継続する。
  これを全 raw invalid STOP にして run を止める矛盾は作らない。
- source/sector 未知は確証済みの既値を NULL 消去せず保持する。current active
  の sector33 不足が残れば partial (exit 1) → moneyflow は進まない。
- D1 設定は必須。想定外の local 設定は `run_job` 前の typed config STOP。
  `--limit` / `--codes` は部分 scope を作るため受けない (config STOP)。
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import logging
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..cloud_store import core_stocks
from ..cloud_store.d1 import D1Error, D1Store
from ..collectors import edinet_codelist
from ..collectors.edinet_codelist import (
    _COL_EDINET_CODE,
    _COL_LISTED,
    _COL_SECTOR,
    _COL_SEC_CODE,
    _LISTED_VALUE,
    _read_codelist_csv,
    inspect_codelist_candidates,
    is_valid_edinet_code,
)
from ..config import Settings, load_settings
from ..contracts.sector33 import normalize_sector33
from ..contracts.stock_code import source_code_to_ticker
from .runner import JobContext, build_parser, main_exit, run_job

logger = logging.getLogger(__name__)

JOB_NAME = "sector33_sync"

# instrument_type の equity リテラル。正本は TS
# `src/shared/jpx/instrument-type.ts` の INSTRUMENT_TYPE_EQUITY。
# 述語 (WHERE bind) にだけ使い、値は select しない (D-13-6)。
_INSTRUMENT_EQUITY = "equity"

# active-equity current の読み取り。select するのは code/sector33 のみ。
ACTIVE_SNAPSHOT_SQL = (
    f"SELECT code, {core_stocks.SECTOR33_COLUMN} FROM {core_stocks.TABLE} "
    "WHERE is_active = ? AND instrument_type = ? ORDER BY code"
)
ACTIVE_SNAPSHOT_PARAMS = [1, _INSTRUMENT_EQUITY]

ARCHIVE_SERVICE = "universe"
ARCHIVE_CLI = Path("scripts/sync/edinet-codelist-archive.ts")
TSX_BIN = Path("node_modules/.bin/tsx")
ARCHIVE_TIMEOUT_SECS = 600

# 合法欠損の ticker 原値 (strip 後)。空は parser に見えないため scan が拾う。
# `00000` は record (`0000`) になるため共有検査が HOLD する (二重診断を避け
# るため scan では黙って飛ばす)。実在する (2026-09-30 実測で各 1 行)。

# 既知の非 33 業種 (`contracts/sector33.py` の決定事項)。
_KNOWN_UNMAPPED_SECTOR = "外国法人・組合"

# 診断 taxonomy (全種別をテストで cover する。増減は意図的に行うこと)。
DIAG_KINDS = frozenset(
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


class SectorConfigError(Exception):
    """`run_job` 前の typed config STOP (exit 2)。"""


class SectorPrewriteStop(Exception):
    """書込前の typed STOP (書込 0。runner が exit 1 へ写す)。"""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind


@dataclass(frozen=True)
class SectorHold:
    """継続する typed HOLD/INFO 診断 (失敗計数に入れない)。"""

    kind: str
    detail: str


@dataclass
class SectorReport:
    """`execute` の機械可読な要約 (`run_job` は戻り値を使わない)。"""

    holds: list[SectorHold] = field(default_factory=list)
    written: int = 0
    planned: int = 0
    gaps: list[str] = field(default_factory=list)
    archive_page_id: str | None = None
    stopped: str | None = None


def _repo_root() -> Path:
    # jobs/sector33_sync.py -> jobs -> jp_stock_pipeline -> src -> pipeline -> root
    return Path(__file__).resolve().parents[4]


def _run_archive_cli(cmd: list[str], timeout_s: int = ARCHIVE_TIMEOUT_SECS):
    """TS CLI 呼び出しの薄い包み (テストで差し替える seam)。"""
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)


def check_sector_config(settings: Settings, args: argparse.Namespace) -> None:
    """D1 必須 + 想定外 local 拒否 + 部分 scope 拒否。NG は typed STOP。"""
    if not settings.cloud_store.d1_enabled():
        raise SectorConfigError("D1 設定が必須 (CF_ACCOUNT_ID/CF_API_TOKEN/CF_D1_DATABASE_ID)")
    local = settings.local_store
    if any([local.host, local.user, local.password, local.api_key, local.lan_host]):
        raise SectorConfigError("想定外の local 設定がある (本ジョブは D1 のみ)")
    if args.limit is not None:
        raise SectorConfigError("--limit は受けない (部分 scope では重複/欠落判定が崩れる)")
    if args.codes:
        raise SectorConfigError("--codes は受けない (部分 scope では重複/欠落判定が崩れる)")


def _scan_listed_rows(zip_bytes: bytes) -> tuple[list[dict], list[SectorHold]]:
    """実 reader で生行を読み、ticker 欠損の合法/不正を分類する。

    parser と同じ入力 (`_read_codelist_csv`)・同じ正規化
    (`source_code_to_ticker`) を使う。空原値は parser に見えないため
    ここで HOLD する。`00000` 原値は共有検査が record (`0000`) 側で
    HOLD するためここでは黙って飛ばす (二重診断を避ける)。
    戻りは (admitted 行, HOLD/INFO 診断)。admitted 行は
    `{ticker, raw, edinet, sector, line}`。
    """
    text = _read_codelist_csv(zip_bytes)
    rows = list(csv.reader(io.StringIO(text)))
    header = rows[1]
    idx = {name: header.index(name) for name in (_COL_EDINET_CODE, _COL_LISTED, _COL_SECTOR, _COL_SEC_CODE)}
    admitted: list[dict] = []
    holds: list[SectorHold] = []
    for lineno, row in enumerate(rows[2:], start=3):
        if row[idx[_COL_LISTED]].strip() != _LISTED_VALUE:
            continue
        raw = row[idx[_COL_SEC_CODE]].strip()
        if raw == "":
            holds.append(SectorHold("legal-missing-ticker", f"line {lineno}: 空"))
            continue
        if raw == "00000":
            continue  # 共有検査が `0000` record 側で HOLD する
        ticker = source_code_to_ticker(raw)
        if ticker is None:
            holds.append(SectorHold("invalid-ticker", f"line {lineno}: {raw!r}"))
            continue
        admitted.append(
            {
                "ticker": ticker,
                "raw": raw,
                "edinet": row[idx[_COL_EDINET_CODE]].strip(),
                "sector": row[idx[_COL_SECTOR]].strip(),
                "line": lineno,
            }
        )
    return admitted, holds


def _verify_normalization(admitted: list[dict]) -> None:
    """admitted 全行の正規化を再検証する。不正は STOP (絶対に通さない)。"""
    for row in admitted:
        again = source_code_to_ticker(row["raw"])
        if again is None or again != row["ticker"]:
            raise SectorPrewriteStop(
                "renormalize-stop",
                f"line {row['line']}: {row['raw']!r} の再正規化が {again!r} "
                f"(admitted {row['ticker']!r} と不一致)",
            )


def _qualify_targets(
    admitted: list[dict], active: set[str]
) -> tuple[list[tuple[str, str]], list[SectorHold]]:
    """active 対象の sector 適格化。戻りは (qualified (ticker, raw sector), 診断)。

    qualified sector 入力は literal 有効 EDINET id 必須。blank issuer は
    共有検査の HOLD 済みとして gap 候補に保持する (NULL 消去しない)。
    不正 nonempty issuer は STOP。非空白で写像不能な sector を持つ target
    も STOP。空白 sector・不在は gap 候補として保持する。name join はしない。
    """
    qualified: list[tuple[str, str]] = []
    holds: list[SectorHold] = []
    by_ticker = {row["ticker"]: row for row in admitted}
    for ticker in sorted(active):
        row = by_ticker.get(ticker)
        if row is None:
            continue  # 不在は gap 候補 (保持)。STOP しない。
        if not row["edinet"]:
            continue  # blank issuer: 共有 HOLD 済み。gap 候補として保持。
        if not is_valid_edinet_code(row["edinet"]):
            raise SectorPrewriteStop(
                "invalid-issuer-stop",
                f"{ticker}: 不正 EDINET {row['edinet']!r} (line {row['line']})",
            )
        sector = row["sector"]
        if not sector:
            continue  # 空白 sector は gap 候補 (保持)。STOP しない。
        if normalize_sector33(sector) is None:
            raise SectorPrewriteStop(
                "ambiguous-sector-stop", f"{ticker}: {sector!r} (line {row['line']})"
            )
        qualified.append((ticker, sector))
    for row in admitted:
        if row["ticker"] in active:
            continue
        if row["sector"] and normalize_sector33(row["sector"]) is None:
            holds.append(
                SectorHold(
                    "unmapped-sector-nontarget",
                    f"{row['ticker']}: {row['sector']!r} (line {row['line']})",
                )
            )
    return qualified, holds


def _archive_key(asof: str) -> str:
    return f"edinet-codelist-{asof}"


def execute(ctx: JobContext) -> SectorReport:
    """sector33-only 同期。戻りは機械可読な要約。"""
    report = SectorReport()
    if getattr(ctx.args, "date", None) is not None:
        logger.warning("--date は無視する (基準日は常に source のメタ行)")
    if not ctx.settings.cloud_store.d1_enabled():
        ctx.add_failure("sector33-config", "D1 設定が必須")
        report.stopped = "config-stop"
        return report
    try:
        requested_at = datetime.now(timezone.utc)
        artifact = edinet_codelist.fetch_codelist(ctx.settings)
        completed_at = datetime.now(timezone.utc)
    except Exception as exc:
        ctx.add_failure("sector33-fetch", f"取得失敗: {exc}")
        report.stopped = "fetch-failure"
        return report
    zip_bytes = artifact.local_path.read_bytes()
    try:
        records = edinet_codelist.parse_codelist(zip_bytes)
    except ValueError as exc:
        ctx.add_failure("sector33-parse", f"parse 失敗: {exc}")
        report.stopped = "parse-failure"
        return report
    if not records or records[0].provenance.data_date is None:
        ctx.add_failure("sector33-asof", "基準日不明 (空またはメタ行なし)")
        report.stopped = "asof-unknown"
        return report
    asof = records[0].provenance.data_date.isoformat()
    key = _archive_key(asof)
    # 完全性 gate は保管より前 (壊れた世代を custody しない)。共有検査 +
    # scan/一致/再正規化のいずれも read-only。
    try:
        inspected = inspect_codelist_candidates(records)
    except edinet_codelist.CodelistInspectError as exc:
        ctx.add_failure(f"sector33-prewrite-{exc.kind}", str(exc))
        report.stopped = exc.kind
        return report
    report.holds.extend(SectorHold(h.kind, h.detail) for h in inspected.holds)
    admitted, scan_holds = _scan_listed_rows(zip_bytes)
    report.holds.extend(scan_holds)
    # scan と parser の一致 pin。parser 側にだけ居る code は
    # 合法欠損由来の phantom (`00000`→`0000`) のみ許す。
    phantom = {r.code for r in records} - {a["ticker"] for a in admitted}
    if phantom - {"0000"}:
        ctx.add_failure("sector33-agreement", f"scan/parser 不一致: {sorted(phantom)}")
        report.stopped = "agreement-stop"
        return report
    try:
        _verify_normalization(admitted)
    except SectorPrewriteStop as exc:
        ctx.add_failure(f"sector33-prewrite-{exc.kind}", str(exc))
        report.stopped = exc.kind
        return report
    manifest = {
        "key": key,
        "asOf": asof,
        "zipSha256": hashlib.sha256(zip_bytes).hexdigest(),
        "zipBytes": len(zip_bytes),
        "requestedAt": requested_at.isoformat(),
        "completedAt": completed_at.isoformat(),
        "listedRecords": len(records),
        "sourceUrl": edinet_codelist.CODELIST_URL,
    }
    manifest_path = artifact.local_path.parent / f"{artifact.local_path.stem}-sector33-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    if not ctx.settings.dry_run:
        root = _repo_root()
        cmd = [
            str(root / TSX_BIN),
            str(root / ARCHIVE_CLI),
            f"--key={key}",
            f"--source={edinet_codelist.CODELIST_URL}",
            f"--zip={artifact.local_path}",
            f"--manifest={manifest_path}",
            f"--service={ARCHIVE_SERVICE}",
            f"--as-of={asof}",
            f"--completed-at={completed_at.isoformat()}",
        ]
        try:
            proc = _run_archive_cli(cmd)
        except Exception as exc:
            ctx.add_failure("sector33-archive", f"archive CLI 失敗: {exc}")
            report.stopped = "archive-failure"
            return report
        verified = False
        page_id: str | None = None
        if proc.returncode == 0:
            try:
                result = json.loads((proc.stdout or "").strip().splitlines()[-1])
                verified = result.get("ok") is True and result.get("verified") is True
                page_id = result.get("pageId")
            except (ValueError, IndexError, AttributeError):
                verified = False
        if not verified or not page_id:
            reason = (proc.stderr or "").strip().splitlines()[-1] if proc.stderr else "unverified"
            ctx.add_failure("sector33-archive", f"保管未検証: {reason[:200]}")
            report.stopped = "archive-failure"
            return report
        report.archive_page_id = page_id
    else:
        logger.info("dry-run: archive CLI と D1 書込を省く (fetch/parse/gate/plan のみ)")

    store = D1Store(ctx.settings.cloud_store, writer=JOB_NAME)
    try:
        current = store.query(ACTIVE_SNAPSHOT_SQL, list(ACTIVE_SNAPSHOT_PARAMS))
    except D1Error as exc:
        ctx.add_failure("sector33-read", f"現在値を読めない: {exc}")
        report.stopped = "read-failure"
        return report
    active = {str(r.get("code") or "") for r in current}
    try:
        qualified, qholds = _qualify_targets(admitted, active)
        report.holds.extend(qholds)
    except SectorPrewriteStop as exc:
        ctx.add_failure(f"sector33-prewrite-{exc.kind}", str(exc))
        report.stopped = exc.kind
        return report

    changes = core_stocks.plan_sector33_updates(current, qualified)
    statements = core_stocks.build_sector33_updates(changes)
    report.planned = len(changes)
    if ctx.settings.dry_run:
        logger.info("dry-run: %d 行の差分を書かない (%d 文)", len(changes), len(statements))
        return report
    written = 0
    for sql, params in statements:
        try:
            store.query(sql, params)
        except D1Error as exc:
            ctx.add_failure("sector33-update", f"UPDATE 失敗 ({written}/{len(changes)} 行): {exc}")
            report.stopped = "update-failure"
            return report
        written += len(params) - 1
    report.written = written
    ctx.add_success(written)
    current_null = {str(r.get("code") or "") for r in current if r.get("sector33") is None}
    gaps = sorted(c for c in current_null if c not in changes)
    # 書いた値は全て非 NULL (qualified のみ) のため、changes に居れば解消済み。
    report.gaps = gaps
    if gaps:
        sample = ",".join(gaps[:10])
        ctx.add_failure("sector33-gap", f"{len(gaps)} 件の不足が残る: {sample}")
    return report


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None) -> int:
    """D1 必須 + 想定外 local 拒否を `run_job` の前に typed STOP (exit 2)。"""
    parser = build_parser("EDINET sector33 のみ同期 (cadence)")
    args = parser.parse_args(argv)
    try:
        check_sector_config(load_settings(env=env), args)
    except SectorConfigError as exc:
        logger.error("config STOP: %s", exc)
        return 2
    return run_job(JOB_NAME, execute, argv, parser=parser, env=env)


if __name__ == "__main__":
    main_exit(main())
