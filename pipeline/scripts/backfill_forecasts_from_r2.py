"""保管済み TDnet 短信 XBRL から会社予想をバックフィルする (#652)。

`jss_financial_forecasts` の writer は tdnet_hourly (新規開示のみ)。
過去分は R2 に保管済みの短信 XBRL 原本 (`jss_raw_files` の
source='TDnet' / datatype='tdnet_xbrl') を再解析して入れる。

## 原則 (§3-1 捏造しない)

- 原本が辿れる書類だけを対象にする。doc_id が索引にも③財務サマリ
  (raw_sha256 結合) にも無い原本は、キーを捏造せず数えて飛ばす。
- 開示時刻 disclosed_at は保管済み TDnet 一覧 (tdnet_list 原本) の
  pubdate を正とし、無ければ③財務サマリの同 doc 行、それも無ければ
  NULL のまま入れる。取得時刻で開示時刻を代用しない。
- 取得時刻 fetched_at は原本索引の first_fetched_at (当時の取得時刻)
  を使う。再解析した今の時刻を塗ると、後から来る正規の書込との
  前後関係が壊れる。
- 原本の SHA256 は索引と照合してから解析する。

## 使い方

    set -a; . ../.env; set +a
    uv run python scripts/backfill_forecasts_from_r2.py --codes 6532            # dry-run
    uv run python scripts/backfill_forecasts_from_r2.py --codes 6532 --apply \
        --journal tmp/forecast-backfill-6532.jsonl
    uv run python scripts/backfill_forecasts_from_r2.py --from 2026-10-01 --apply \
        --journal tmp/forecast-backfill-recent.jsonl

既に (code, doc_id) が入っている書類は飛ばすので再実行は冪等。
失敗した書類が 1 件でもあれば終了コード 1 (黙って成功にしない)。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from collections.abc import Iterable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jp_stock_pipeline.cloud_store import financial_forecasts
from jp_stock_pipeline.cloud_store.d1 import D1Store
from jp_stock_pipeline.cloud_store.r2 import R2Store
from jp_stock_pipeline.collectors.tdnet_yanoshin import parse_list_payload
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.convert.xbrl_to_csv import xbrl_zip_to_tidy
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import Provenance, Source
from jp_stock_pipeline.transform.normalize import tidy_to_financial_record

WRITER = "backfill_forecasts_from_r2"
MAX_RAW_BYTES = 64 * 1024 * 1024  # reparse 金融原本と同じ上限


def build_disclosure_map(
    payloads: Iterable[dict], *, fetched_at: datetime
) -> tuple[dict[str, tuple[datetime, str | None]], set[str], int]:
    """TDnet 一覧 payload 群から doc_id -> (disclosed_at, code) を作る。

    同じ doc_id で開示時刻やコードが食い違う場合は競合として外す
    (どちらが正しいか一覧だけでは決められない)。yanoshin 独自 id
    (`yanoshin-*`) は公式 doc_id ではないので含めない。
    解釈できない payload は数えて飛ばす (黙って捨てない)。
    """
    mapping: dict[str, tuple[datetime, str | None]] = {}
    conflicts: set[str] = set()
    failed = 0
    for payload in payloads:
        try:
            records = parse_list_payload(payload, fetched_at=fetched_at)
        except Exception:  # noqa: BLE001 - 壊れた一覧1本で対応表全体を止めない
            failed += 1
            continue
        for record in records:
            if record.doc_id.startswith("yanoshin-"):
                continue
            value = (record.disclosed_at, record.code)
            known = mapping.get(record.doc_id)
            if known is None and record.doc_id not in conflicts:
                mapping[record.doc_id] = value
            elif known != value:
                mapping.pop(record.doc_id, None)
                conflicts.add(record.doc_id)
    return mapping, conflicts, failed


def resolve_doc_id(raw_doc_id: str | None, financials_doc_id: str | None) -> str | None:
    """原本索引の doc_id を正とし、無い場合だけ③ (raw_sha256 結合) から補う。

    両方あって食い違う場合は同一原本の同一性を疑うべき状態なので
    None を返して呼び出し側に失敗として数えさせる。
    """
    if raw_doc_id and financials_doc_id and raw_doc_id != financials_doc_id:
        return None
    return raw_doc_id or financials_doc_id


def forecast_rows_from_zip(
    content: bytes,
    *,
    code: str,
    doc_id: str,
    raw_sha256: str,
    disclosed_at: datetime | None,
    fetched_at: datetime,
    data_date: date,
) -> tuple[list[list[Any]], str]:
    """短信 XBRL zip 1 本から予想行を作る。status は journal 用の分類。"""
    tidy = xbrl_zip_to_tidy(content, code, doc_id)
    prov = Provenance(
        source=Source.TDNET,
        license_tag=LicenseTag.FACTUAL_CITE,
        data_date=data_date,
        fetched_at=fetched_at,
    )
    diagnostics: dict[str, dict] = {}
    record = tidy_to_financial_record(
        tidy, code, prov, disclosed_at=disclosed_at, diagnostics=diagnostics
    )
    if record is None:
        return [], "no_record"
    rows = financial_forecasts.build_rows(
        record, diagnostics, doc_id=doc_id, raw_sha256=raw_sha256
    )
    if not rows:
        return [], "no_forecast_elements"
    return rows, "written"


def _raw_store(stores: dict[str, R2Store], settings, bucket: str) -> R2Store:
    if bucket not in stores:
        stores[bucket] = R2Store(settings, bucket, writer=WRITER)
    return stores[bucket]


def _load_disclosure_map(store: D1Store, raw_stores: dict[str, R2Store], settings,
                         counters: Counter) -> dict[str, tuple[datetime, str | None]]:
    """保管済み tdnet_list 原本を全て読み、doc_id -> 開示時刻の対応を作る。"""
    rows = store.query(
        "SELECT r2_bucket, r2_key, sha256, first_fetched_at FROM jss_raw_files"
        " WHERE source = 'TDnet' AND datatype = 'tdnet_list'"
        " ORDER BY data_date, sha256"
    )
    payloads: list[dict] = []
    seen_sha: set[str] = set()
    for row in rows:
        if row["sha256"] in seen_sha:
            continue
        seen_sha.add(row["sha256"])
        content = _raw_store(raw_stores, settings, row["r2_bucket"]).get_bytes(row["r2_key"])
        if content is None:
            counters["list_r2_missing"] += 1
            continue
        if hashlib.sha256(content).hexdigest() != row["sha256"]:
            counters["list_sha_mismatch"] += 1
            continue
        try:
            payload = json.loads(content)
        except ValueError:
            counters["list_not_json"] += 1
            continue
        if isinstance(payload, dict):
            payloads.append(payload)
    fetched_at = datetime.now(UTC)
    mapping, conflicts, failed = build_disclosure_map(payloads, fetched_at=fetched_at)
    counters["list_payloads"] = len(payloads)
    counters["list_doc_conflicts"] = len(conflicts)
    counters["list_parse_failed"] = failed
    return mapping


def _financials_maps(store: D1Store) -> tuple[dict[str, dict], dict[str, int]]:
    """③財務サマリから raw_sha256 -> 行情報 / doc_id -> disclosed_at を作る。"""
    by_sha: dict[str, dict] = {}
    by_doc: dict[str, int] = {}
    for row in store.query(
        "SELECT code, doc_id, raw_sha256, disclosed_at FROM jss_financials"
        " WHERE raw_sha256 IS NOT NULL OR doc_id IS NOT NULL"
    ):
        if row.get("raw_sha256"):
            # 同一原本から複数行 (連結/単体等) があり得る。doc_id が
            # 食い違ったら使わない (同一性の捏造をしない)。
            known = by_sha.get(row["raw_sha256"])
            if known is None:
                by_sha[row["raw_sha256"]] = row
            elif known.get("doc_id") != row.get("doc_id") or known.get("code") != row.get("code"):
                by_sha[row["raw_sha256"]] = {"code": None, "doc_id": None, "disclosed_at": None}
        if row.get("doc_id") and row.get("disclosed_at") is not None:
            known_disc = by_doc.get(row["doc_id"])
            if known_disc is None:
                by_doc[row["doc_id"]] = int(row["disclosed_at"])
            elif known_disc != int(row["disclosed_at"]):
                by_doc.pop(row["doc_id"], None)
    return by_sha, by_doc


def _parse_date(text: str) -> date:
    return date.fromisoformat(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TDnet 短信 XBRL 保管原本から会社予想をバックフィルする")
    parser.add_argument("--codes", nargs="*", default=[], help="銘柄コードで絞る (省略時は全件)")
    parser.add_argument("--from", dest="from_date", type=_parse_date, help="data_date の下限 YYYY-MM-DD")
    parser.add_argument("--to", dest="to_date", type=_parse_date, help="data_date の上限 YYYY-MM-DD")
    parser.add_argument("--limit", type=int, help="処理する原本の上限件数")
    parser.add_argument("--apply", action="store_true", help="実際に書く (省略時は dry-run)")
    parser.add_argument("--journal", type=Path, help="処理結果 JSONL の出力先 (--apply 時は必須)")
    args = parser.parse_args(argv)
    if args.apply and args.journal is None:
        parser.error("--apply 時は --journal が必須 (監査証跡)")
    if len(args.codes) > 50:
        parser.error("--codes は最大 50 件 (D1 バインド上限)")

    settings = load_settings()
    cloud = settings.cloud_store
    if not cloud.d1_enabled():
        raise SystemExit("D1 が未設定 (CF_ACCOUNT_ID / CF_API_TOKEN / CF_D1_DATABASE_ID)")
    store = D1Store(cloud, writer=WRITER)
    raw_stores: dict[str, R2Store] = {}
    counters: Counter = Counter()
    journal: list[dict] = []

    disclosure_map = _load_disclosure_map(store, raw_stores, cloud, counters)
    fin_by_sha, fin_by_doc = _financials_maps(store)
    existing = {
        (row["code"], row["doc_id"])
        for row in store.query("SELECT code, doc_id FROM jss_financial_forecasts")
    }
    existing_before = len(existing)

    where = ["source = 'TDnet'", "datatype = 'tdnet_xbrl'", "convert_status = '完了'"]
    params: list[Any] = []
    if args.codes:
        where.append(f"code IN ({', '.join('?' for _ in args.codes)})")
        params.extend(args.codes)
    if args.from_date:
        where.append("data_date >= ?")
        params.append(args.from_date.isoformat())
    if args.to_date:
        where.append("data_date <= ?")
        params.append(args.to_date.isoformat())
    raw_rows = store.query(
        "SELECT sha256, r2_bucket, r2_key, doc_id, code, data_date, size_bytes,"
        " first_fetched_at FROM jss_raw_files WHERE " + " AND ".join(where)
        + " ORDER BY data_date, code, sha256",
        params,
    )
    if args.limit:
        raw_rows = raw_rows[: args.limit]
    counters["raw_rows"] = len(raw_rows)

    # 対象は最大でも保管 tdnet_xbrl の件数規模。全行を集めて最後に
    # まとめて書く (write 側がバインド上限で分割する)。
    pending: list[list[Any]] = []

    for raw in raw_rows:
        code = str(raw["code"] or "")
        sha = str(raw["sha256"])
        entry: dict[str, Any] = {"code": code, "sha256": sha, "data_date": raw["data_date"]}
        try:
            fin = fin_by_sha.get(sha) or {}
            if fin.get("code") and fin["code"] != code:
                raise ValueError("③財務サマリと原本索引で銘柄コードが食い違う")
            doc_id = resolve_doc_id(raw.get("doc_id"), fin.get("doc_id"))
            if raw.get("doc_id") and fin.get("doc_id") and doc_id is None:
                raise ValueError("原本索引と③財務サマリで doc_id が食い違う")
            if not doc_id:
                counters["skipped_no_doc_id"] += 1
                entry["status"] = "skipped_no_doc_id"
                journal.append(entry)
                continue
            entry["doc_id"] = doc_id
            if (code, doc_id) in existing:
                counters["skipped_existing"] += 1
                entry["status"] = "skipped_existing"
                journal.append(entry)
                continue
            content = _raw_store(raw_stores, cloud, raw["r2_bucket"]).get_bytes(raw["r2_key"])
            if content is None:
                raise ValueError("R2 に原本実体が無い")
            if len(content) > MAX_RAW_BYTES:
                raise ValueError("原本が64MiB上限を超えました")
            if hashlib.sha256(content).hexdigest() != sha:
                raise ValueError("原本SHA256が索引と一致しません")

            disclosed_at: datetime | None = None
            listed = disclosure_map.get(doc_id)
            if listed is not None:
                if listed[1] and listed[1] != code:
                    raise ValueError("TDnet一覧と原本索引で銘柄コードが食い違う")
                disclosed_at = listed[0]
            elif fin_by_doc.get(doc_id) is not None:
                disclosed_at = datetime.fromtimestamp(fin_by_doc[doc_id], tz=UTC)
            elif fin.get("disclosed_at") is not None:
                disclosed_at = datetime.fromtimestamp(int(fin["disclosed_at"]), tz=UTC)
            if disclosed_at is None:
                counters["disclosed_at_unknown"] += 1

            fetched_epoch = raw.get("first_fetched_at")
            if not fetched_epoch:
                raise ValueError("原本索引に first_fetched_at が無い")
            fetched_dt = datetime.fromtimestamp(int(fetched_epoch), tz=UTC)
            indexed_date = (
                date.fromisoformat(str(raw["data_date"])) if raw.get("data_date") else None
            )
            rows, status = forecast_rows_from_zip(
                content,
                code=code,
                doc_id=doc_id,
                raw_sha256=sha,
                disclosed_at=disclosed_at,
                fetched_at=fetched_dt,
                data_date=(
                    disclosed_at.date() if disclosed_at is not None
                    else indexed_date or fetched_dt.date()
                ),
            )
            counters[status] += 1
            entry["status"] = status
            if rows:
                pending.extend(rows)
                existing.add((code, doc_id))
        except Exception as exc:  # noqa: BLE001 - 1書類の失敗で全体を止めない。件数は数える
            counters["failed"] += 1
            entry["status"] = "failed"
            entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
        journal.append(entry)

    if args.apply:
        counters["rows_written"] = financial_forecasts.write(store, pending)
    else:
        counters["rows_would_write"] = len(pending)

    summary = {
        "apply": bool(args.apply),
        "counters": dict(sorted(counters.items())),
        "disclosure_map_docs": len(disclosure_map),
        "existing_before": existing_before,
    }
    if args.journal is not None:
        args.journal.parent.mkdir(parents=True, exist_ok=True)
        with args.journal.open("w") as fh:
            for item in journal:
                fh.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
            fh.write(json.dumps({"summary": summary}, ensure_ascii=False, sort_keys=True) + "\n")
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 1 if counters.get("failed") else 0


if __name__ == "__main__":
    raise SystemExit(main())
