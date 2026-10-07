"""ops_check: 鮮度とジョブ結果を読んで SLO 違反だけを報告する。

**何も書かない。** 読んで判定し、違反があれば非ゼロで終了する。
記録は `jobs/freshness_probe.py`（別ジョブ）が行い、Issue は GitHub Actions 側が
立てる（記録・判定・通知を分ける）。

これまで「壊れても音が鳴らない」状態だった:
- 14 workflow に `if: failure()` も webhook も 0 行
- `jss_job_runs` / `jss_dataset_freshness` は器だけで 0 行
- stockStock は一部失敗を exit 0 にするので毎日 failed>0 でも緑
- kabulab-cf は failed>0 で exit 1 なので 35% が赤（どちらも情報量ゼロ）

判定は「異常だけを出す」。正常時に何も言わないのは、通知が多いと
見なくなるため（設計書 §7.6）。**この原則は自分自身にも適用する**: 毎日必ず
鳴る判定を作ったら、それは通知を殺すのと同じである。だから既知の赤は
`slo.ACCEPTED_RED` で宣言して警告に落とし、空振り検知からは診断ジョブを除く。
更新しないと決めたデータセット（`slo.NOT_REFRESHED`）は加齢を判定せず、
「判定対象外」と理由をログに出す（0 行・測れないは引き続き違反にする）。
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from ..cloud_store import slo
from ..cloud_store.d1 import D1Error, D1Store
from ..collectors.tdnet_yanoshin import BASE_URL
from ..contracts.stock_code import source_code_to_ticker
from ..http import FetchError, fetch
from ..models import JST
from .freshness_probe import CAPACITY_DATASET
from .runner import STATUS_SUCCESS, JobContext, build_parser, main_exit, run_job

logger = logging.getLogger(__name__)

JOB_NAME = "ops_check"

# 観測ジョブ（鮮度を記録する側）。生存確認の対象。
PROBE_JOB_NAME = "freshness_probe"

# 判定に必要な4列。row_or_object_count を読まないと「0 件なのに緑」が起きる。
FRESHNESS_SQL = (
    "SELECT dataset, latest_data_date, row_or_object_count, updated_at"
    " FROM jss_dataset_freshness"
)

# 空振り検知から外すジョブ。収集を1件もしないのが正常な診断・観測ジョブたち。
#
# allowlist（収集ジョブだけを検知対象にする）にはしない。新しい収集ジョブを
# 足した人が登録を忘れると「黙って検知しない穴」が空くが、denylist の書き忘れは
# 「うるさいが安全な誤警報」で済む。安全側に倒す。
DIAGNOSTIC_JOBS: tuple[str, ...] = ("ops_check", "cloud_check", PROBE_JOB_NAME)

# 直近の実行で「処理ゼロの成功」が続いていないか。EDINET の 11 営業日は
# これで拾える。D1 の compound SELECT 上限を避けて 1 文にする。
#
# `AND status = ?` が無いと**失敗した実行まで「処理ゼロで成功している」と報告する**。
# 実測で `jss_job_runs` の 2 行はどちらも ops_check 自身の
# `status='失敗' processed=0` で、このまま 3 日続けば発火する状態だった。
#
# `finished_at >= ... -30 days` (L-17): 全行の ROW_NUMBER は表が育つと
# 全走査になる。`idx_jss_job (job_name, finished_at)` を効かせるため
# 直近 30 日に窓を切る。`record_job_run` の 90 日剪定と対で範囲を保つ。
IDLE_RUNS_SQL = (
    "SELECT job_name, COUNT(*) AS n FROM ("
    "  SELECT job_name, processed, status, ROW_NUMBER() OVER"
    "   (PARTITION BY job_name ORDER BY finished_at DESC) AS rn"
    "  FROM jss_job_runs WHERE job_name NOT IN ({placeholders})"
    "  AND finished_at >= strftime('%s','now','-30 days')"
    ") WHERE rn <= ? AND processed = 0 AND status = ? GROUP BY job_name"
    " HAVING COUNT(*) >= ?"
).format(placeholders=", ".join("?" for _ in DIAGNOSTIC_JOBS))

# 観測ジョブの生存確認。**status を絞らないと「毎日失敗していても生きている」を
# 返す**（runner は status に関わらず 1 行書く）。
PROBE_ALIVE_SQL = (
    "SELECT MAX(finished_at) AS last_ok FROM jss_job_runs"
    " WHERE job_name = ? AND status = ?"
)

# 連続で処理ゼロが続いたら異常とみなす本数。
IDLE_RUN_WINDOW = 5
IDLE_RUN_THRESHOLD = 3

# 観測ジョブが日次なので、2 日黙ったら止まっていると見る（祝日でも cron は動く）。
PROBE_MAX_SILENCE_HOURS = 48.0

# D1 容量の赤の閾値。D1 の 10GB 上限は**引き上げ不可**なので、残り 2GB の
# 8GB で落とす (DB 分割か R2 退避の対応を取る猶予を残す)。Cloudflare の
# GB 表記に合わせて 10 進 (1GB = 1,000,000,000 bytes) で割る。
D1_CAPACITY_RED_BYTES = 8_000_000_000

CAPACITY_SQL = "SELECT bytes FROM jss_dataset_freshness WHERE dataset = ?"

# INC-20261008-kabulab_tool_cloudflare-ir-pdf-502
# 適時開示 PDF を Notion に残す前に TDnet 原本が消えると、ファイルプロキシは 502 になる。
# 2026-10-08 02:38 JST の実測: 公開後 37 日は 206、41 日は 404。
# 拾い直し上限 IR_PDF_RETAIN_DAYS=40 は src/cron/ir-catalog-tdnet.ts の
# TDNET_PDF_RETAIN_DAYS と同じ値（確定 purge の 41 日の手前）。
# SLO は「公開から 8 日（catchup 窓 7 日 + 起動が翌早朝へずれる分）を超え、
# 40 日以内なのに notion_page_id が空」。40 日より古い NULL は purge 済みで
# 戻せない（終端列は今回作らない）。そこまで数えると毎日赤になり、
# このファイル冒頭が避ける「必ず鳴る判定」になる。
IR_PDF_SLO_MIN_AGE_DAYS = 8
IR_PDF_RETAIN_DAYS = 40
_DAY_SECONDS = 86_400
_IR_PDF_INCIDENT = "[INC-20261008-kabulab_tool_cloudflare-ir-pdf-502]"
_IR_PDF_GAP_WHERE = (
    " WHERE (notion_page_id IS NULL OR notion_page_id = '')"
    " AND pubdate >= ? AND pubdate <= ?"
)
IR_PDF_GAP_COUNT_SQL = "SELECT COUNT(*) AS n FROM ir_disclosures" + _IR_PDF_GAP_WHERE
IR_PDF_GAP_SAMPLE_SQL = (
    "SELECT tdnet_id FROM ir_disclosures"
    + _IR_PDF_GAP_WHERE
    + " ORDER BY pubdate ASC, tdnet_id ASC LIMIT 30"
)

# INC-20261008-kabulab_tool_cloudflare-ir-universe-gap
# TDnet 一覧にあり、取込母集団（disclosureIngestCondition と同じ述語）に入り、
# ir_disclosures に行が無い開示。行が無いので PDF の SLO には出ない。
# catchup は公開 40 日以内の欠測を挿入する。この判定は、その catchup が
# 走る前の当日分で毎日赤にしない。
# catchup は平日 20:00 JST 予定で、実際の開始はしばしば翌日 02:00-04:30 JST。
# 金曜予定は土曜朝、次は月曜予定の火曜朝。土曜の開示は月曜 23:30 の時点では
# まだ catchup を通っていない。公開から 3 日を超えた欠けだけを失敗にする。
# 40 日は src/cron/ir-catalog-tdnet.ts の TDNET_PDF_RETAIN_DAYS と同じ値。
IR_UNIVERSE_GAP_MIN_AGE_DAYS = 3
IR_UNIVERSE_GAP_RETAIN_DAYS = 40
_IR_UNIVERSE_GAP_INCIDENT = "[INC-20261008-kabulab_tool_cloudflare-ir-universe-gap]"
_TDNET_LIST_DAY_LIMIT = 8000
_TDNET_LIST_INTERVAL_S = 0.75
# instrument_type は WHERE だけ。値は SELECT しない。ETF/REIT は入れない。
# 正本は src/shared/db/active-equity.ts の disclosureIngestCondition。
_INGEST_CODE_SQL = (
    "SELECT code FROM core_stocks"
    " WHERE instrument_type = ? OR (is_active = ? AND instrument_type IS NULL)"
)
_EXISTING_TDNET_SQL = "SELECT tdnet_id FROM ir_disclosures WHERE pubdate >= ?"


@dataclass(frozen=True)
class TdnetListItem:
    """一覧の1開示。tdnet_id は yanoshin の id（ir_disclosures.tdnet_id）。"""

    tdnet_id: str
    ticker: str | None
    disclosed_at: datetime


def ir_pdf_gap_bounds(now_epoch: int) -> list[int]:
    """pubdate の閉区間 [now-40日, now-8日] を返す。"""
    return [
        now_epoch - IR_PDF_RETAIN_DAYS * _DAY_SECONDS,
        now_epoch - IR_PDF_SLO_MIN_AGE_DAYS * _DAY_SECONDS,
    ]


def _check_freshness(ctx: JobContext, store: D1Store, problems: list[str]) -> None:
    """鮮度表を判定する。宣言済みの赤は警告に落とす。"""
    try:
        rows = store.query(FRESHNESS_SQL)
    except D1Error as exc:
        ctx.add_failure("freshness", f"鮮度表を読めない: {exc}")
        return

    if not rows:
        # 空を「問題なし」と読ませない。器はあるのに writer が動いていない状態。
        ctx.add_failure(
            "freshness",
            "jss_dataset_freshness が空。freshness_probe を先に走らせること"
            f"（`python -m jp_stock_pipeline.jobs.{PROBE_JOB_NAME}`）。"
            "それでも空なら記録する writer が動いていない",
        )
        return

    for row in rows:
        dataset = str(row.get("dataset") or "")
        if dataset == CAPACITY_DATASET:
            # 容量行は加齢判定の対象外。測った瞬間が as_of なので「古い」に
            # 意味が無く、素直に判定すると未知データセット = unknown で毎日鳴る。
            # 容量の判定は _check_capacity が bytes_ で行う。
            logger.info("%s: 容量行のため鮮度判定をスキップ", dataset)
            continue
        latest_data_date = row.get("latest_data_date")
        source_epoch = row.get("updated_at")
        row_count = row.get("row_or_object_count")
        verdict = slo.judge_observation(
            dataset,
            latest_data_date=latest_data_date,
            source_epoch=source_epoch,
            row_count=row_count,
        )
        age = slo.observation_age_hours(
            dataset, latest_data_date=latest_data_date, source_epoch=source_epoch
        )
        age_txt = f"{age / 24:.1f}日" if age is not None else "不明"
        basis = f"基準日 {latest_data_date}" if latest_data_date else "取得時刻"
        line = f"{dataset}: {verdict} ({basis}から {age_txt} / {row_count} 行)"

        exempt_reason = slo.NOT_REFRESHED.get(dataset)
        if verdict == slo.VERDICT_NOT_REFRESHED:
            # 更新しないデータセット。件数と止まっている日数は出すが判定しない。
            # info にするのは、毎日必ず出る warning は読まれなくなるから
            # （`ACCEPTED_RED` の赤は「いつか直す」ので warning のまま）。
            logger.info(
                "%s: 判定対象外 (%sから %s / %s 行) ← 理由: %s",
                dataset, basis, age_txt, row_count, exempt_reason,
            )
            continue
        if exempt_reason is not None:
            # 判定対象外でも 0 行（red）と測れない（unknown）は通す。
            # 更新しないことと、再取得不能な資産が消えてよいことは違う。
            line = f"{line} ← 判定対象外のデータセットだが加齢と無関係な異常"
            problems.append(line)
            logger.warning("%s（判定対象外の理由: %s）", line, exempt_reason)
            continue

        reason = slo.ACCEPTED_RED.get(dataset)
        if reason is not None and verdict == "red":
            # 宣言済みの赤。ログには出すが終了コードは落とさない。
            logger.warning("%s ← 受容済み: %s", line, reason)
            continue
        if reason is not None and verdict in ("green", "yellow"):
            # 直った。宣言を外せることを報告する（失敗にはしない）。
            logger.warning(
                "%s ← slo.ACCEPTED_RED から %s の宣言を外せる（受容理由: %s）",
                line, dataset, reason,
            )
            continue
        if verdict in ("red", "yellow", "unknown"):
            # unknown は宣言済みでも通す。「直った」ではなく「測れていない」ため。
            problems.append(line)
            logger.warning("%s", line)
            continue
        logger.info("%s", line)

    # SLO を定義している、または判定対象外として観測を続けると宣言しているのに
    # 鮮度表に載っていないデータセット。判定対象外を外すと、観測が止まって
    # 「0 行になった」を検知する手段が消えても静かなままになる。
    expected = set(slo.SLO_BY_DATASET) | set(slo.NOT_REFRESHED)
    missing = sorted(expected - {str(r.get("dataset") or "") for r in rows})
    if missing:
        problems.append(f"鮮度が記録されていないデータセット: {missing}")


def _check_probe_alive(store: D1Store, problems: list[str]) -> None:
    """観測ジョブが実際に成功しているかを見る。"""
    try:
        rows = store.query(PROBE_ALIVE_SQL, [PROBE_JOB_NAME, STATUS_SUCCESS])
    except D1Error as exc:
        logger.warning("観測ジョブの生存を確認できない: %s", exc)
        return
    last_ok = rows[0].get("last_ok") if rows else None
    if not last_ok:
        problems.append(
            f"{PROBE_JOB_NAME} が一度も成功していない（鮮度表の値が凍結している疑い）"
        )
        return
    age = slo.age_hours(int(last_ok))
    if age is not None and age > PROBE_MAX_SILENCE_HOURS:
        problems.append(
            f"{PROBE_JOB_NAME} の最後の成功から {age / 24:.1f}日"
            f"（上限 {PROBE_MAX_SILENCE_HOURS / 24:.0f}日）。観測が止まっている"
        )


def _check_idle_runs(store: D1Store, problems: list[str]) -> None:
    """処理ゼロの「成功」が続いているジョブを拾う。"""
    params = [*DIAGNOSTIC_JOBS, IDLE_RUN_WINDOW, STATUS_SUCCESS, IDLE_RUN_THRESHOLD]
    try:
        idle = store.query(IDLE_RUNS_SQL, params)
    except D1Error as exc:
        logger.warning("ジョブ履歴を読めない: %s", exc)
        return
    for row in idle:
        problems.append(
            f"{row['job_name']}: 直近 {IDLE_RUN_WINDOW} 回中 {row['n']} 回が"
            " 処理ゼロで成功している（空振りの疑い）"
        )


def _check_capacity(store: D1Store, problems: list[str]) -> None:
    """D1 全体の容量を判定する。読み取りのみ。"""
    try:
        rows = store.query(CAPACITY_SQL, [CAPACITY_DATASET])
    except D1Error as exc:
        logger.warning("容量行を読めない: %s", exc)
        return
    size = rows[0].get("bytes") if rows else None
    if not isinstance(size, int) or isinstance(size, bool):
        # 行が無い・bytes が NULL・型が変のいずれも警告に留める。観測ジョブが
        # 同じ workflow で直前に走っており、測れなければ観測側が既に赤なので、
        # ここで落とすと同一原因で二重に鳴る (単独実行時のみ警告が出る)。
        logger.warning("D1 容量が記録されていない (bytes=%r)", size)
        return
    gb = size / 1_000_000_000
    if size >= D1_CAPACITY_RED_BYTES:
        problems.append(
            f"D1 容量 {gb:.1f}GB/10GB (上限・引き上げ不可)。"
            "DB 分割か R2 退避の対応が必要"
        )
        return
    logger.info("D1 容量 %.1fGB/10GB", gb)


def _check_ir_pdf_archive(
    store: D1Store, problems: list[str], *, now_epoch: int | None = None
) -> None:
    """公開から一定日数たっても Notion 未保管の適時開示を数える。読み取りのみ。"""
    now = int(datetime.now(UTC).timestamp()) if now_epoch is None else now_epoch
    bounds = ir_pdf_gap_bounds(now)
    try:
        counted = store.query(IR_PDF_GAP_COUNT_SQL, bounds)
    except D1Error as exc:
        problems.append(
            f"{_IR_PDF_INCIDENT} ir_disclosures の notion_page_id 充足を読めない: {exc}"
        )
        return
    raw_n = counted[0].get("n") if counted else None
    if not isinstance(raw_n, int) or isinstance(raw_n, bool):
        problems.append(
            f"{_IR_PDF_INCIDENT} notion_page_id の欠測件数を読めない (n={raw_n!r})"
        )
        return
    if raw_n == 0:
        logger.info(
            "適時開示 PDF の Notion 保管: 公開から %d〜%d 日の未保管は 0 件",
            IR_PDF_SLO_MIN_AGE_DAYS,
            IR_PDF_RETAIN_DAYS,
        )
        return
    try:
        sample = store.query(IR_PDF_GAP_SAMPLE_SQL, bounds)
    except D1Error as exc:
        problems.append(
            f"{_IR_PDF_INCIDENT} 未保管 {raw_n} 件の tdnetId を読めない: {exc}"
        )
        return
    ids: list[str] = []
    for row in sample:
        tdnet_id = row.get("tdnet_id")
        if not isinstance(tdnet_id, str) or tdnet_id == "":
            problems.append(
                f"{_IR_PDF_INCIDENT} 未保管 {raw_n} 件のうち tdnet_id が空の行がある"
            )
            return
        ids.append(tdnet_id)
    rest = raw_n - len(ids)
    suffix = f" 他{rest}件" if rest > 0 else ""
    problems.append(
        f"{_IR_PDF_INCIDENT} 公開から{IR_PDF_SLO_MIN_AGE_DAYS}日を超え"
        f"{IR_PDF_RETAIN_DAYS}日以内で notion_page_id が NULL の適時開示が"
        f" {raw_n} 件 (tdnetId={','.join(ids)}{suffix})"
    )


def _unwrap_tdnet_item(item: object) -> dict | None:
    if not isinstance(item, dict):
        return None
    inner = item.get("Tdnet")
    if isinstance(inner, dict):
        return inner
    return item


def parse_tdnet_list_item(raw: object) -> TdnetListItem | None:
    """必須項目が読めなければ None。コード不正は ticker=None（欠測には数えない）。"""
    body = _unwrap_tdnet_item(raw)
    if body is None:
        return None
    tdnet_id = body.get("id")
    pubdate = body.get("pubdate")
    company_code = body.get("company_code")
    if not isinstance(tdnet_id, str) or tdnet_id == "":
        return None
    if not isinstance(pubdate, str) or not isinstance(company_code, str) or company_code == "":
        return None
    try:
        disclosed_at = datetime.strptime(pubdate, "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)
    except ValueError:
        return None
    return TdnetListItem(
        tdnet_id=tdnet_id,
        ticker=source_code_to_ticker(company_code),
        disclosed_at=disclosed_at,
    )


def universe_listing_gaps(
    items: list[TdnetListItem],
    universe_codes: set[str],
    existing_tdnet_ids: set[str],
    *,
    now: datetime,
    min_age_days: int = IR_UNIVERSE_GAP_MIN_AGE_DAYS,
    retain_days: int = IR_UNIVERSE_GAP_RETAIN_DAYS,
) -> list[str]:
    """母集団内・保持窓内・D1 に無い tdnet id。公開が古い順。"""
    if now.tzinfo is None:
        raise ValueError("TDnet欠測判定の現在時刻にタイムゾーンがありません")
    newest = now - timedelta(days=min_age_days)
    oldest = now - timedelta(days=retain_days)
    chosen: dict[str, datetime] = {}
    for item in items:
        if item.ticker is None or item.ticker not in universe_codes:
            continue
        if item.disclosed_at < oldest or item.disclosed_at > newest:
            continue
        if item.tdnet_id in existing_tdnet_ids:
            continue
        prev = chosen.get(item.tdnet_id)
        if prev is None or item.disclosed_at < prev:
            chosen[item.tdnet_id] = item.disclosed_at
    return [tdnet_id for tdnet_id, _pub in sorted(chosen.items(), key=lambda pair: (pair[1], pair[0]))]


def fetch_tdnet_window_listings(now: datetime) -> tuple[list[TdnetListItem], int]:
    """公開40日の一覧を読む。原本は保存しない（ops_check は何も書かない）。

    1日でも上限到達・JSON 不正なら、欠測0とはせず FetchError。
    必須項目が読めない行は件数だけ返し、0件成功にしない。
    """
    if now.tzinfo is None:
        raise ValueError("TDnet一覧の現在時刻にタイムゾーンがありません")
    now_jst = now.astimezone(JST)
    start = (now_jst - timedelta(days=IR_UNIVERSE_GAP_RETAIN_DAYS)).date()
    end = now_jst.date()
    items: list[TdnetListItem] = []
    unreadable = 0
    day = start
    first = True
    while day <= end:
        if not first:
            time.sleep(_TDNET_LIST_INTERVAL_S)
        first = False
        ymd = day.strftime("%Y%m%d")
        url = f"{BASE_URL}/{ymd}.json"
        resp = fetch(url, params={"limit": _TDNET_LIST_DAY_LIMIT}, timeout=30)
        try:
            payload = json.loads(resp.content)
        except ValueError as exc:
            raise FetchError(f"TDnet一覧が JSON でない: {ymd}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            raise FetchError(f"TDnet一覧の items が配列でない: {ymd}")
        raw_items = payload["items"]
        if len(raw_items) >= _TDNET_LIST_DAY_LIMIT:
            raise FetchError(
                f"TDnet一覧が上限({_TDNET_LIST_DAY_LIMIT})に到達: {ymd} count={len(raw_items)}"
            )
        for raw in raw_items:
            parsed = parse_tdnet_list_item(raw)
            if parsed is None:
                unreadable += 1
                continue
            items.append(parsed)
        day += timedelta(days=1)
    return items, unreadable


def load_ingest_universe_codes(store: D1Store) -> set[str]:
    """disclosureIngestCondition と同じ母集団の証券コード。定義は広げない。"""
    rows = store.query(_INGEST_CODE_SQL, ["equity", 0])
    codes: set[str] = set()
    for row in rows:
        code = row.get("code")
        if not isinstance(code, str) or code == "":
            raise D1Error("core_stocks.code が空の行があるため母集団を確定できない")
        codes.add(code)
    return codes


def load_existing_tdnet_ids(store: D1Store, since_epoch: int) -> set[str]:
    rows = store.query(_EXISTING_TDNET_SQL, [since_epoch])
    ids: set[str] = set()
    for row in rows:
        tdnet_id = row.get("tdnet_id")
        if not isinstance(tdnet_id, str) or tdnet_id == "":
            raise D1Error("ir_disclosures.tdnet_id が空の行があるため欠測を確定できない")
        ids.add(tdnet_id)
    return ids


def _check_ir_universe_gap(
    store: D1Store,
    problems: list[str],
    *,
    now: datetime | None = None,
    listings: tuple[list[TdnetListItem], int] | None = None,
) -> None:
    """一覧にあって D1 に行が無い母集団内の開示を数える。読み取りのみ。"""
    moment = datetime.now(UTC) if now is None else now
    if moment.tzinfo is None:
        problems.append(f"{_IR_UNIVERSE_GAP_INCIDENT} 判定時刻にタイムゾーンが無い")
        return
    try:
        listed, unreadable = (
            listings if listings is not None else fetch_tdnet_window_listings(moment)
        )
    except FetchError as exc:
        problems.append(f"{_IR_UNIVERSE_GAP_INCIDENT} TDnet一覧を読めない: {exc}")
        return
    if unreadable > 0:
        problems.append(
            f"{_IR_UNIVERSE_GAP_INCIDENT} TDnet一覧の必須項目が読めない開示が"
            f" {unreadable} 件（欠測件数を0とは扱わない）"
        )
    try:
        universe = load_ingest_universe_codes(store)
        since = int((moment - timedelta(days=IR_UNIVERSE_GAP_RETAIN_DAYS)).timestamp())
        existing = load_existing_tdnet_ids(store, since)
    except D1Error as exc:
        problems.append(
            f"{_IR_UNIVERSE_GAP_INCIDENT} 母集団または ir_disclosures を読めない: {exc}"
        )
        return
    gaps = universe_listing_gaps(listed, universe, existing, now=moment)
    if not gaps:
        if unreadable == 0:
            logger.info(
                "適時開示の D1 行: 公開から %d〜%d 日で一覧にあり母集団内の欠測は 0 件",
                IR_UNIVERSE_GAP_MIN_AGE_DAYS,
                IR_UNIVERSE_GAP_RETAIN_DAYS,
            )
        return
    sample = gaps[:30]
    rest = len(gaps) - len(sample)
    suffix = f" 他{rest}件" if rest > 0 else ""
    problems.append(
        f"{_IR_UNIVERSE_GAP_INCIDENT} 公開から{IR_UNIVERSE_GAP_MIN_AGE_DAYS}日を超え"
        f"{IR_UNIVERSE_GAP_RETAIN_DAYS}日以内で、TDnet一覧にあり母集団内だが"
        f" ir_disclosures に行が無い適時開示が {len(gaps)} 件"
        f" (tdnetId={','.join(sample)}{suffix})"
    )


def execute(ctx: JobContext) -> None:
    # `ctx.cloud` は runner が `if not settings.dry_run:` の中でしか作らないため
    # 参照すると --dry-run が必ず即失敗する。設定から直接 D1Store を組む
    # （cloud_check.py と同じ形）。読み取りしかしないので dry-run でも安全。
    settings = ctx.settings.cloud_store
    if not settings.d1_enabled():
        ctx.add_failure("d1", "D1 が未設定。鮮度を判定できない")
        return
    store = D1Store(settings, writer=JOB_NAME)

    problems: list[str] = []
    _check_freshness(ctx, store, problems)
    if ctx.failed:
        # 鮮度表そのものが読めない/空 → それ以上の判定は意味がない
        return
    _check_probe_alive(store, problems)
    _check_idle_runs(store, problems)
    _check_capacity(store, problems)
    _check_ir_pdf_archive(store, problems)
    _check_ir_universe_gap(store, problems)

    if problems:
        for p in problems:
            ctx.add_failure("slo", p)
        return
    logger.info(
        "SLO 違反なし（宣言済みの赤 %d 件は警告のみ・判定対象外 %d 件: %s）",
        len(slo.ACCEPTED_RED), len(slo.NOT_REFRESHED), sorted(slo.NOT_REFRESHED),
    )
    ctx.add_success()


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None) -> int:
    parser = build_parser("鮮度とジョブ結果の SLO 判定（読み取りのみ）")
    return run_job(JOB_NAME, execute, argv, parser=parser, env=env)


if __name__ == "__main__":
    main_exit(main())
