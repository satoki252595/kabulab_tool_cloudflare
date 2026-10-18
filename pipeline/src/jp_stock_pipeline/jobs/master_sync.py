"""master_sync: EDINETコードリスト → ① 銘柄マスタ同期 (DESIGN.md §8.2, P1)。

フロー (§8.1): fetch → save raw → convert → ⑤UL(必須) → parse → ① upsert → D1 実行記録。
本番共通 strict: 原本⑤の Notion 未保管で取得単位を中止する (dry-run のみ旧来の
双方向フェールセーフ §3-3)。① upsert 自体は Notion/ローカル独立 (§7.1)。

## D1 `core_stocks.sector33` の充填（updated_at を進めない）

`parse_codelist` が返す `StockMasterRecord.sector33` は EDINET コードリストの
「提出者業種」（commercial-ok）。Notion ① とローカル ① へは原文のまま書き、
**D1 `core_stocks.sector33` へは東証33業種の名称へ正規化してから**書く
（`contracts/sector33.py`。公開面が33業種で表示するため）。

以前はここで充填しなかった。汎用の列充填（旧 `build_column_update`。D-14-1 で
削除）が `updated_at = (unixepoch())` を進めるので、月次に充填すると
`cloud_store/datasets.py` が `core_stocks` の鮮度に使う `MAX(updated_at)` が
**毎月必ず進み**、kabulab-cf の月次 universe sync が死んでいても SLO が発火
しなくなるからである（JPX の 404 で銘柄マスタが 33 日止まったのに誰も気づか
なかった事象を、自分の書き込みで隠す）。

**`sector33` だけを SET する専用の UPDATE**
（`core_stocks.build_sector33_updates`）で解いた。`updated_at` を
進めるのは kabulab-cf だけのままなので、鮮度の意味は変わらない。詳細は
`cloud_store/core_stocks.py` の「sector33 の充填で updated_at を進めない理由」。

- **差分だけ書く。** `SELECT code, sector33 FROM core_stocks` を 1 文読み、
  現在owner/identityも同じ1文で読み、値が変わる行だけ UPDATE する。
- **コードリストに現れない銘柄は触らない**（一時的な欠落で既存値を NULL に潰さない）
- `--dry-run` は読むだけで書かない。`--limit` のみは読みもしない。
  `--codes` は limit 後の選択銘柄だけを読み、同じ差分writerで更新する
- D1 の失敗は `ctx.add_failure` に記録し、Notion / ローカルの同期は止めない
- `ctx.cloud` を経由しない。runner は dry-run で `ctx.cloud` を張らないので、
  依存すると dry-run で件数を出せない（`freshness_probe` と同じ）
"""

from __future__ import annotations

import logging
import json
import hashlib
import re
from datetime import datetime
from pathlib import Path
from uuid import UUID
import time
from functools import partial

from ..cloud_store import core_stocks, notion_pages
from ..cloud_store.d1 import MAX_BOUND_PARAMS, D1Error, D1Store
from ..collectors import codelist_identity, edinet_codelist
from ..contracts.stock_code import parse_stock_code
from ..notion import schema as S, upsert
from ..rawstore import save_raw
from .runner import JobContext, apply_limit, build_parser, main_exit, parse_codes_arg, run_job

logger = logging.getLogger(__name__)

JOB_NAME = "master_sync"

# 欠損診断の安全弁: 既存①に対しコードリストが極端に縮んだ取得は異常とみなし、
# 異常な欠損診断を防ぐ (§ Phase3 blast-radius)。取得コード数が既存の50%未満なら中止。
MIN_CODELIST_COVERAGE = 0.5


def _code_scope(args) -> set[str] | None:
    if args.codes is None:
        return None
    tokens = parse_codes_arg(args)
    if not tokens or any(not part.strip() for part in args.codes.split(",")):
        raise ValueError("--codes は空の対象を含められません")
    codes = [parse_stock_code(token) for token in tokens]
    if any(code is None for code in codes) or len(set(codes)) != len(codes):
        raise ValueError("--codes は有効で一意な銘柄コードを指定してください")
    return set(codes)



def _load_financial_pre_rejection(path: str, digest: str) -> dict:
    """認可SHAに束縛した540の既知PRE URL400だけ。一般400/unknownは受けない。"""
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("reconcile proof SHA256が不正")
    with Path(path).open("rb") as handle:
        body = handle.read(64 * 1024 + 1)
    if len(body) > 64 * 1024 or hashlib.sha256(body).hexdigest() != digest:
        raise ValueError("reconcile proof bytes/SHA256が不一致")
    proof = json.loads(body)
    required = {"version", "kind", "code", "financialPageId", "masterPageId", "controlKey",
                "oldPendingSha256", "preSha256", "oldRevision", "capturedFiles"}
    if (set(proof) != required or proof["version"] != 1
            or proof["kind"] != "financial-pre-empty-url-400"
            or proof["oldRevision"] != "4e40ab90c1abe67639f68b1835c1ed753a2f3a25"
            or parse_stock_code(proof["code"]) != proof["code"] or proof["code"] == "0000"
            or str(UUID(proof["financialPageId"])) != proof["financialPageId"]
            or str(UUID(proof["masterPageId"])) != proof["masterPageId"]
            or proof["controlKey"] != f"financial-master-relations/{proof['financialPageId']}.json"):
        raise ValueError("reconcile proofの対象/旧revisionが不正")
    files = proof["capturedFiles"]
    source_hashes = {
        "oldSource": "c5e4beca7a055b48c34d0f39bde08d699a35ec765bd4fc19315d4132b3faf48a",
        "oldUploadSource": "9efde803aba2a3fcc23ef74a3b536fe92ab126a389f82a80b5cb4b240e841739",
        "oldRunnerSource": "c99d9f05031896f7192245f0d9c880056df01ac9ee0aafcd21c87e120c80fe0f",
    }
    if set(files) != {"normalStarted", "normalFinished", "normalLog", "freshReadback",
                      "expectedFinancial", "processClosure", *source_hashes}:
        raise ValueError("reconcile原証跡が不完全")
    evidence = {}
    for name, pin in files.items():
        if set(pin) != {"path", "sha256"}:
            raise ValueError("reconcile原証跡pin形状が不正")
        with Path(pin["path"]).open("rb") as handle:
            data = handle.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024 or hashlib.sha256(data).hexdigest() != pin["sha256"]:
            raise ValueError("reconcile原証跡bytes/SHA256が不一致")
        if name in source_hashes and pin["sha256"] != source_hashes[name]:
            raise ValueError("未知の旧sourceはreconcile不可")
        evidence[name] = data.decode("utf-8")
    started, finished, closure = [json.loads(evidence[k]) for k in
                                  ("normalStarted", "normalFinished", "processClosure")]
    if (finished["exitCode"] != 1 or started["pid"] != finished["pid"]
            or started["startedAt"] != finished["startedAt"]
            or started["revision"] != proof["oldRevision"] or finished["revision"] != proof["oldRevision"]
            or proof["code"] not in started["scope"]
            or closure["kind"] != "financial-master-run-process-closure"
            or closure["oldRevision"] != proof["oldRevision"] or closure["normalPid"] != started["pid"]
            or set(closure["absentPids"]) != {closure["operatorPid"], started["pid"]}
            or closure["psExitCode"] != 1 or closure["psOutput"] != "" or closure["normalExitCode"] != 1
            or closure["normalFinishedSha256"] != files["normalFinished"]["sha256"]
            or closure["normalLogSha256"] != files["normalLog"]["sha256"]):
        raise ValueError("旧normal/親processの既知閉鎖が不一致")
    clocks = [datetime.fromisoformat(value) for value in
              (started["startedAt"], finished["finishedAt"], closure["observedAt"])]
    if any(clock.tzinfo is None for clock in clocks) or not clocks[0] <= clocks[1] <= clocks[2]:
        raise ValueError("旧normal閉鎖の実時計が不一致")
    log = evidence["normalLog"]
    if ('POST https://api.notion.com/v1/pages "HTTP/1.1 400 Bad Request"' not in log
            or any(f'File "{started["runtime"]}/pipeline/src/jp_stock_pipeline/{file}"' not in log
                   for file in ("notion/upsert.py", "notion/file_upload.py", "jobs/runner.py"))
            or 'body.properties.取得URL.url should be populated or `null`, instead was `""`.' not in log
            or 'pre_archive = physical(pending, "pre")' not in log
            or 'notion.file_upload.RawUploadError' not in log or 'HTTP Request: PATCH ' in log
            or f"-_financial-master-pre_{proof['code']}_" not in log):
        raise ValueError("旧failureは既知PRE URL400の未PATCH証拠でない")
    readback = json.loads(evidence["freshReadback"])
    expected = {case["code"]: case["financial"] for case in json.loads(evidence["expectedFinancial"])["cases"]}
    observed = [datetime.fromisoformat(readback[k]) for k in ("startedAt", "finishedAt")]
    if any(clock.tzinfo is None for clock in observed) or not clocks[1] <= observed[0] <= observed[1] <= clocks[2]:
        raise ValueError("旧readbackの実時計が不一致")
    cases = readback["cases"]
    if (len(cases) != len(expected) or len({case["code"] for case in cases}) != len(cases)
            or {case["code"] for case in cases} != set(expected)):
        raise ValueError("旧financial readback母集団が不一致")
    target = None
    for case in cases:
        if (case["allPropertiesUnchanged"] is not True
                or case["current"]["properties"] != expected[case["code"]]["properties"]
                or case["financialPageId"] != case["current"]["id"]
                or case["current"]["id"] != expected[case["code"]]["id"]):
            raise ValueError("旧financial全propsが不一致")
        if case["code"] == proof["code"]:
            target = case
        elif case["r2Found"] is not False or case["r2Value"] is not None:
            raise ValueError("別financial操作はreconcile不可")
    if (target is None or target["r2Found"] is not True or target["r2Key"] != proof["controlKey"]
            or target["financialPageId"] != proof["financialPageId"]):
        raise ValueError("旧pending対象が不一致")
    pending = target["r2Value"]
    if (set(pending) != {"version", "status", "code", "financial_page_id", "master_page_id", "pre",
                        "pre_sha256", "raw", "native", "started_at"}
            or pending["status"] != "pending" or pending["version"] != 1
            or pending["code"] != proof["code"] or pending["financial_page_id"] != proof["financialPageId"]
            or pending["master_page_id"] != proof["masterPageId"]
            or hashlib.sha256(upsert._financial_relation_json(pending)).hexdigest() != proof["oldPendingSha256"]
            or pending["pre_sha256"] != proof["preSha256"]
            or hashlib.sha256(upsert._financial_relation_json(pending["pre"])).hexdigest() != proof["preSha256"]
            or pending["pre"]["properties"] != target["current"]["properties"]):
        raise ValueError("旧pending/PRE全bytesが不一致または消費済み")
    pending_clock = datetime.fromisoformat(pending["started_at"])
    if pending_clock.tzinfo is None or not clocks[0] <= pending_clock <= clocks[1]:
        raise ValueError("旧pendingの実時計が不一致")
    return {**proof, "proofSha256": digest, "oldPending": pending}


def execute(ctx: JobContext) -> None:
    # 不正な部分scopeは原本取得より前に止める。省略時は従来の全件同期。
    scope = _code_scope(ctx.args)
    path, digest = ctx.args.reconcile_financial_pre, ctx.args.reconcile_financial_pre_sha256
    if path is not None or digest is not None:
        if path is None or digest is None or scope is None or len(scope) != 1 or ctx.args.limit is not None:
            raise ValueError("reconcileは両proof引数と1code必須、limit併用不可")
        proof = _load_financial_pre_rejection(path, digest)
        if scope != {proof["code"]}:
            raise ValueError("reconcile --codesと証跡対象が不一致")
        bucket = None if (ctx.cloud is None or not ctx.cloud.settings.r2_enabled()) else ctx.cloud.raw_bucket
        result = upsert.reconcile_financial_master_pre_rejection(
            ctx.client, ctx.settings, proof, raw_bucket=bucket, archive=ctx.upload_raw,
        )
        if result != "repaired":
            raise RuntimeError("reconcileが正常完了していない")
        ctx.add_success()
        return
    # 1-3. Fetch / Save raw / Convert
    artifact = edinet_codelist.fetch_codelist(ctx.settings)
    artifact = edinet_codelist.convert_codelist(artifact)

    # 4. ⑤へ原本+変換版を UL。本番共通 strict: Notion⑤未保管で中止 (§8.1-4)
    raw_page_id = ctx.upload_raw(artifact)

    # D1 optionalは維持。既存sector READを前倒ししidentity資格と差分計画で共用。
    current = None
    store = None if ctx.args.limit or scope is not None else _sector33_store(ctx)
    if store is not None:
        try:
            current = store.query(codelist_identity.SNAPSHOT_SQL)
        except D1Error as exc:
            ctx.add_failure("core_stocks.sector33", f"現在値を読めない: {exc}")
    # current未取得では認定blankだけHOLD、literal経路は従来どおり。
    resolved = codelist_identity.resolve_blank_tickers(artifact.local_path.read_bytes(), current)
    if scope is not None:
        resolved = {line: code for line, code in resolved.items() if code in scope}
    identity_page_id = None
    if resolved:
        if raw_page_id is None:
            ctx.add_failure("codelist-identity", "元FSA rawPageId未保管")
            return
        source_asof = edinet_codelist._read_codelist_rows(artifact.local_path.read_bytes())[0]
        # 元原本SHA dedupへ添付追加せず、派生来歴を別の物理取得単位として保全。
        lineage = codelist_identity.binding_lineage(resolved, current)
        lineage["fsa"] = {"rawPageId": raw_page_id, "sha256": artifact.sha256,
                          "sourceAsOf": source_asof.isoformat(),
                          "sourceFetchedAt": artifact.fetched_at.isoformat()}
        identity_artifact = save_raw(
            json.dumps(lineage, ensure_ascii=False, sort_keys=True).encode("utf-8"),
            source=artifact.source, datatype="codelist-identity-derived", scope="ALL",
            data_date=source_asof, url=artifact.url, ext="json",
            license_tag=artifact.license_tag, base_dir=ctx.settings.raw_data_dir,
        )
        identity_page_id = ctx.upload_raw(identity_artifact)  # 失敗は認定行の書込前STOP
        if identity_page_id is None:
            ctx.add_failure("codelist-identity", "派生来歴未保管")
            return
    # 5. Transform（全件。欠損診断のため limit 前の全コードを保持）
    records = edinet_codelist.parse_codelist(
        artifact.local_path.read_bytes(), raw_page_id=raw_page_id, current=current
    )
    for record in records:
        if record.code in resolved.values():
            record.provenance.raw_page_id = identity_page_id
            record.provenance.fetched_at = artifact.fetched_at
    # 候補検査は全件 parse 後・limit 前・① upsert 前 (sector33_sync と共通)。
    # 重複は last-wins で潰さず STOP する (strict unique)。
    try:
        inspected = edinet_codelist.inspect_codelist_candidates(records)
    except edinet_codelist.CodelistInspectError as exc:
        ctx.add_failure("codelist-candidates", f"{exc.kind}: {exc}")
        return
    for hold in inspected.holds:
        logger.warning("候補 HOLD (%s): %s", hold.kind, hold.detail)
    fetched_codes = {r.code for r in inspected.candidates}
    if scope is not None and not scope <= fetched_codes:
        for code in sorted(scope - fetched_codes):
            ctx.add_failure(code, "指定銘柄が資格あるコードリスト候補にありません。書込前HOLD")
        return
    selected = inspected.candidates if scope is None else [
        r for r in inspected.candidates if r.code in scope
    ]
    upsert_records = apply_limit(selected, ctx.args.limit)
    logger.info("コードリスト: %d 銘柄を ① へ upsert", len(upsert_records))

    # ① 既存行マップ {code: page_id} を一括取得（per-record 検索を排除 §8.3。
    # ~3900銘柄×1req削減）。取得失敗時は書込前STOP（all-or-nothing:
    # 部分マップを信用して create すると重複行になるため §8.1-6）。このマップは
    # 欠損診断でも再利用し ① 全件スキャンを 2回→1回 にする。
    try:
        if scope is None:
            master_entries = upsert.load_stock_master_entries(ctx.client, ctx.settings)
        else:
            # 既存のコードfilter/全paginationと同じ行解釈を再用する。
            codes = [record.code for record in upsert_records]
            pages = []
            for offset in range(0, len(codes), 50):
                pages.extend(ctx.client.query_database(
                    ctx.settings.db_id("stock_master"),
                    filter={"or": [upsert.stock_master_filter(code) for code in codes[offset:offset + 50]]},
                ))
            master_entries = upsert._master_entries_from_pages(pages)
        map_ok = True
    except Exception as exc:  # noqa: BLE001 - 全件取得失敗は書込前STOP
        ctx.add_failure("stock-master-map", f"① 全件マップ取得失敗: {exc}")
        return  # 不明な母集団でcreate/update/sector/mirrorを書かない
    master_map = {code: pid for code, (pid, _props) in master_entries.items()}

    # 6. Upsert (冪等キー=銘柄コード)。状態/上場日/上場廃止日 は開示が所有する
    #    ため codelist 同期では書かない (include_lifecycle=False § Phase3 二重所有回避)。
    def _existing_page_id(pid: str) -> str:
        """同値 skip 時の notion 書き込み（何も書かず既存 page_id を返す）。"""
        return pid

    skipped = 0
    for record in upsert_records:
        # L-19: 既存行と同値なら PATCH を省く（月次 3,841 件 → 差分のみ）。
        # ローカル系統には書く（persist の notion 側だけを no-op にする）。
        entry = master_entries.get(record.code)
        identity_matches = record.code not in resolved.values() or (
            entry is not None
            and upsert._read_relation_ids_checked(entry[1], S.PROP_RAW_RELATION) == [identity_page_id]
            and upsert._relation_complete(entry[1], S.PROP_RAW_RELATION)
        )
        if (map_ok and entry is not None and identity_matches
                and upsert.stock_master_matches_page(entry[1], record)):
            skipped += 1
            notion_write = partial(_existing_page_id, entry[0])
        else:
            notion_write = partial(
                upsert.upsert_stock_master,
                ctx.client,
                ctx.settings,
                record,
                include_lifecycle=False,
                existing_page_id=master_map.get(record.code),
                page_resolved=map_ok,
            )
        # Notion とローカルへ独立に書く（双方向フェールセーフ）。状態/上場日/廃止日は
        # 開示が所有するため include_lifecycle=False で両系統とも書かない。
        if ctx.persist(
            record,
            notion_write,
            label=f"①{record.code}",
            include_lifecycle=False,
        ):
            ctx.add_success()
        else:
            ctx.add_failure(record.code, "①: Notion/ローカル両系統に書けず")
    if skipped:
        logger.info("① 同値 skip: %d 件の PATCH を省いた", skipped)

    # 新規masterだけに限定しない。前月HOLD/未完の③も選択codeのemptyだけ再確認。
    # UNKNOWNはhelperから例外伝播し、このrun/次runとも同pageへの再PATCHを禁止する。
    upsert.sync_financial_master_relations(
        ctx.client, ctx.settings, upsert_records,
        raw_bucket=None if (ctx.settings.dry_run or ctx.cloud is None
                            or not ctx.cloud.settings.r2_enabled()) else ctx.cloud.raw_bucket,
        archive=ctx.upload_raw, on_hold=ctx.add_failure,
    )

    if scope is not None:
        logger.info("--codes の部分実行: 選択銘柄のsector33のみ対象、全市場の欠損診断・写し更新なし")
        store = _sector33_store(ctx)
        if store is not None:
            # parse時のcurrent=Noneは維持。後読取でblank tickerの資格を増やさない。
            codes = [record.code for record in upsert_records]
            current = []
            try:
                for offset in range(0, len(codes), MAX_BOUND_PARAMS):
                    batch = codes[offset:offset + MAX_BOUND_PARAMS]
                    current.extend(store.query(
                        f"SELECT {codelist_identity.SNAPSHOT_COLUMNS} FROM core_stocks c "
                        f"WHERE c.code IN ({', '.join('?' for _ in batch)}) ORDER BY c.code",
                        batch,
                    ))
            except D1Error as exc:
                ctx.add_failure("core_stocks.sector33", f"現在値を読めない: {exc}")
                return
            selected_codes = set(codes)
            _sync_sector33(ctx, [r for r in inspected.sector if r.code in selected_codes],
                           store=store, current=current, certified=set())
        return
    # 7. 不在はHOLD診断だけ。limitのみの部分実行はsectorも従来どおり触らない。
    if ctx.args.limit:
        logger.info("--limit の部分実行: 全市場の欠損診断・sector33・写し更新を行わない")
        return
    _hold_absent_codes(ctx, fetched_codes, master_map, map_ok)
    # sector には資格側だけ渡す (blank issuer を sector tuple へ渡さない)。
    # ①upsert 用元 records との最小区別。① schema は改造しない。
    _sync_sector33(ctx, inspected.sector, store=store, current=current, certified=set(resolved.values()))
    _sync_notion_pages(ctx, master_entries, map_ok)


def _sector33_store(ctx: JobContext) -> D1Store | None:
    """`core_stocks` がある D1（正本）への接続。資格情報が無ければ None。"""
    settings = ctx.settings.cloud_store
    if not settings.d1_enabled():
        return None
    return D1Store(settings, writer=JOB_NAME)


def _sync_notion_pages(
    ctx: JobContext, master_entries: dict[str, tuple[str, dict]], map_ok: bool
) -> None:
    """① の {コード: page_id} 写しを D1 へ書く（L-20。読むのは tdnet/edinet）。

    upsert 前の props は古いため、書込後の①を1回全件スキャンし、両写しを作る。
    `--dry-run` / `--limit` では書かない（sector33 と同じ扱い）。
    マップ取得失敗・Notion upsert 失敗・逆引き競合では両写しを書かない。
    D1 の失敗は記録だけして同期は止めない（写しが古くても読み手は
    Notion スキャンへフォールバックする）。
    """
    if ctx.settings.dry_run or ctx.args.limit:
        return
    if not map_ok:
        return
    store = _sector33_store(ctx)
    if store is None:
        return
    if ctx.notion_failed:
        ctx.add_failure("jss_notion_pages", "① Notion upsert 失敗があるため写しを書かない")
        return
    try:
        post_entries = upsert.load_stock_master_entries(ctx.client, ctx.settings)
        if not post_entries:
            raise ValueError("① POST 全件マップが空")
        stock_map = {code: pid for code, (pid, _props) in post_entries.items()}
        edinet_map = upsert._edinet_map_from_pages([
            {"id": pid, "properties": props}
            for pid, props in post_entries.values()
        ])
    except Exception as exc:  # noqa: BLE001 - 未確定/競合マップで両区画を書かない
        ctx.add_failure("jss_notion_pages", f"① POST マップ未確定: {exc}")
        return
    try:
        now = int(time.time())
        n_stock = notion_pages.save_map(
            store, notion_pages.DB_STOCK_MASTER, stock_map, updated_at=now
        )
        n_edinet = notion_pages.save_map(
            store, notion_pages.DB_STOCK_MASTER_BY_EDINET, edinet_map, updated_at=now
        )
    except D1Error as exc:
        ctx.add_failure("jss_notion_pages", f"D1 写しを書けない: {exc}")
        return
    logger.info("① D1 写し: stock %d 件 / edinet逆引き %d 件", n_stock, n_edinet)


def _sync_sector33(
    ctx: JobContext, records: list, *, store: D1Store | None, current: list[dict] | None,
    certified: set[str]
) -> None:
    """EDINET「提出者業種」で D1 `core_stocks.sector33` の差分だけを埋める。

    D1 未設定は失敗にしない。このジョブの主目的は Notion ① / ローカル ① の同期で、
    D1 の資格情報が無い環境（手元・Notion 単独運用）でも従来どおり成功させる。
    成否は `processed` に数えない（① の件数の意味を変えないため）。
    """
    if store is None:
        logger.info("D1 未設定のため core_stocks.sector33 の充填はスキップ")
        return
    # 呼び出し前に検査済みの候補だけが来る。ここで collapse しない
    # (重複は planner が STOP する。last-wins は廃止)。
    codelist = [(r.code, r.sector33) for r in records]
    if current is None:
        return  # 前倒しREAD失敗は既に記録済み。再READしない。
    changes = core_stocks.plan_sector33_updates(current, codelist)
    asof = records[0].provenance.data_date if certified and records else None
    # blank認定の行だけUPDATE identity guardを追加する。
    guarded = {k: v for k, v in changes.items() if k in certified}
    statements = core_stocks.build_sector33_updates({k: v for k, v in changes.items() if k not in guarded})
    if guarded and asof is None:
        ctx.add_failure("core_stocks.sector33", "認定行の基準日不明")
        return
    statements += [codelist_identity.certified_update(k, v, asof) for k, v in guarded.items()]
    to_null = sum(1 for v in changes.values() if v is None)
    if ctx.settings.dry_run:
        logger.info(
            "dry-run: core_stocks.sector33 を書かない（変わる行 %d 件 / うち NULL %d 件"
            " / UPDATE %d 文 / 読んだ行 %d 件）",
            len(changes), to_null, len(statements), len(current),
        )
        return
    written = 0
    for sql, params in statements:
        try:
            result = store.query(sql, params)
            if "RETURNING code" in sql and result != [{"code": params[1]}]:
                raise D1Error("認定identityがUPDATE時に変化 (書込0)")
        except D1Error as exc:
            # 途中の文で止める。書けた分は残るが、次回は差分から再計算するので収束する。
            ctx.add_failure(
                "core_stocks.sector33",
                f"UPDATE 失敗（{written}/{len(changes)} 行まで適用済み）: {exc}",
            )
            return
        written += 1 if "RETURNING code" in sql else len(params) - 1
    logger.info(
        "core_stocks.sector33: %d 行を更新（うち NULL %d 件 / %d 文 / 読んだ行 %d 件）",
        written, to_null, len(statements), len(current),
    )


def _hold_absent_codes(
    ctx: JobContext, fetched_codes: set[str], existing: dict[str, str], map_ok: bool
) -> None:
    """コードリスト不在は未知として診断し、listed/status は変更しない。

    ticker 欠損や上場区分の差だけで、効力が発生した上場廃止とは確定できない。
    既存全件マップを再利用する。マップ取得失敗では診断せず、異常な縮小は
    従来どおり失敗として報告する。
    """
    if not map_ok:
        logger.warning("① マップ未取得のため欠損診断をスキップ (§3-2)")
        return
    # 安全弁: 取得コードが既存に対し極端に少ない＝異常取得として診断を中止する。
    # 部分情報を正常な全件として診断しない (§3-2)。
    if existing and len(fetched_codes) < MIN_CODELIST_COVERAGE * len(existing):
        ctx.add_failure(
            "codelist",
            f"取得 {len(fetched_codes)} 件が既存 {len(existing)} 件の "
            f"{MIN_CODELIST_COVERAGE:.0%} 未満。異常取得とみなし欠損診断を中止 (§ Phase3)",
        )
        return
    absent = sorted(set(existing) - fetched_codes)
    if not absent:
        return
    logger.warning("コードリスト不在 %d 銘柄を HOLD (上場状態は未知、既存値を保持)", len(absent))
    for code in absent:
        logger.warning("codelist-absence HOLD: %s (有効な上場廃止根拠なし、listed を保持)", code)


def main(argv: list[str] | None = None, *, env: dict[str, str] | None = None) -> int:
    parser = build_parser("EDINETコードリスト → ① 銘柄マスタ同期 (月1)")
    parser.add_argument("--reconcile-financial-pre", default=None, help="既知PRE URL400の固定証跡FILE")
    parser.add_argument("--reconcile-financial-pre-sha256", default=None, help="明示認可した証跡SHA256")
    return run_job(JOB_NAME, execute, argv, parser=parser, env=env)


if __name__ == "__main__":
    main_exit(main())
