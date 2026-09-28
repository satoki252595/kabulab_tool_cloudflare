"""Notion③の原本⑤をSHA256照合して再解析する。監査journalを確認後にNotionだけへ反映する。"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import time
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, replace
from datetime import date, datetime
from pathlib import Path
from threading import Event, Lock
from urllib.parse import urlparse

import httpx

from backfill_financials_from_notion import _bounds, _next_month, notion_financial
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.cloud_store.d1 import D1Store
from jp_stock_pipeline.cloud_store.financials import (
    COLUMNS, TABLE, UNKNOWN_CONSOLIDATED, prefetch_stock_ids, record_to_row,
)
from jp_stock_pipeline.cloud_store.schema import FINANCIALS_PK
from jp_stock_pipeline.convert.xbrl_to_csv import edinet_csv_zip_to_tidy, xbrl_zip_to_tidy
from jp_stock_pipeline.convert import xbrl_to_csv as convert_module
from jp_stock_pipeline.licensing import LicenseTag, strictness_rank, stricter_tag_sql
from jp_stock_pipeline.models import DataQuality, FinancialSummaryRecord, Provenance, Source
from jp_stock_pipeline.notion import schema as S
from jp_stock_pipeline.notion.client import NotionClient
from jp_stock_pipeline.notion.upsert import (
    financial_overwrite_allowed,
    financial_summary_filter,
    financial_summary_properties,
)
from jp_stock_pipeline.transform import normalize as normalize_module
from jp_stock_pipeline.transform.normalize import derive_disclosure_type, tidy_to_financial_record

MAX_RAW_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
PARSER_SHA256 = hashlib.sha256(
    Path(convert_module.__file__).read_bytes() + b"\0" + Path(normalize_module.__file__).read_bytes()
).hexdigest()


def _text(props: dict, name: str, kind: str = "rich_text") -> str:
    return "".join(part["plain_text"] for part in props[name][kind])


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str, sort_keys=True)


def _record_dict(record: FinancialSummaryRecord) -> dict:
    return json.loads(_json(asdict(record)))


def _record_from_dict(value: dict) -> FinancialSummaryRecord:
    fields = dict(value)
    raw = dict(fields.pop("provenance"))
    raw["source"] = Source(raw["source"])
    raw["license_tag"] = LicenseTag(raw["license_tag"])
    raw["quality"] = DataQuality(raw["quality"])
    raw["data_date"] = date.fromisoformat(raw["data_date"]) if raw["data_date"] else None
    raw["fetched_at"] = datetime.fromisoformat(raw["fetched_at"])
    fields["provenance"] = Provenance(**raw)
    fields["fiscal_period_end"] = date.fromisoformat(fields["fiscal_period_end"])
    fields["disclosed_at"] = (
        datetime.fromisoformat(fields["disclosed_at"]) if fields["disclosed_at"] else None
    )
    return FinancialSummaryRecord(**fields)


def _page_record(page: dict) -> FinancialSummaryRecord:
    record = notion_financial(page)
    ids = page["properties"][S.PROP_RAW_RELATION]["relation"]
    if len(ids) != 1:
        raise ValueError(f"{record.code}: 原本が一意ではありません")
    return replace(record, provenance=replace(record.provenance, raw_page_id=ids[0]["id"]))


def _journal_items(journal: Path) -> dict[str, dict]:
    # 同じpageの失敗後の成功を採る。失敗履歴そのものはjournalに残す。
    if not journal.exists():
        return {}
    return {item["page_id"]: item for item in map(json.loads, journal.read_text().splitlines())}


def _download(url: str, code: str, client: httpx.Client) -> bytes:
    content = bytearray()
    with client.stream("GET", url) as response:
        if response.status_code != 200:
            raise ValueError(f"{code}: 原本取得HTTP {response.status_code}")
        for chunk in response.iter_bytes():
            if len(content) + len(chunk) > MAX_RAW_BYTES:
                raise ValueError(f"{code}: 原本が64MiB上限を超えました")
            content.extend(chunk)
    return bytes(content)


def reparse_record(
    old: FinancialSummaryRecord, raw_page: dict, cache_dir: Path, client: httpx.Client
) -> tuple[FinancialSummaryRecord, dict]:
    props = raw_page["properties"]
    if props[S.PROP_SOURCE]["select"]["name"] != old.provenance.source.value:
        raise ValueError(f"{old.code}: 原本sourceが財務行と一致しません")
    if _text(props, S.RAW_PROP_SCOPE) != old.code:
        raise ValueError(f"{old.code}: 原本対象銘柄が財務行と一致しません")
    digest = _text(props, S.RAW_PROP_SHA256)
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError(f"{old.code}: 原本SHA256が不正です")
    cached = cache_dir / f"{digest}.zip"
    if cached.exists():
        if cached.stat().st_size > MAX_RAW_BYTES:
            raise ValueError(f"{old.code}: 原本が64MiB上限を超えました")
        content = cached.read_bytes()
    else:
        name = _text(props, S.RAW_PROP_FILENAME, "title")
        files = [file for file in props[S.RAW_PROP_FILES]["files"] if file["name"] == name]
        if len(files) != 1:
            raise ValueError(f"{old.code}: 原本ファイルが一意ではありません")
        file = files[0]
        if file["type"] != "file":
            raise ValueError(f"{old.code}: 原本実体がNotion保管ファイルではありません")
        # 期限付きURLはjournal/ログへ出さない。Notion⑤のハッシュで照合する。
        content = _download(file[file["type"]]["url"], old.code, client)
    if hashlib.sha256(content).hexdigest() != digest:
        raise ValueError(f"{old.code}: 原本SHA256が一致しません")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        if sum(entry.file_size for entry in archive.infolist()) > MAX_EXPANDED_BYTES:
            raise ValueError(f"{old.code}: 原本展開後が128MiB上限を超えました")
    cached.write_bytes(content)
    datatype = _text(props, S.RAW_PROP_DATATYPE)
    if datatype == "csv":
        tidy = edinet_csv_zip_to_tidy(content, old.code, raw_page["id"])
    elif datatype in ("tdnet_xbrl", "xbrl"):
        tidy = xbrl_zip_to_tidy(content, old.code, raw_page["id"])
    else:
        raise ValueError(f"{old.code}: 未対応の原本種別 {datatype}")
    new, details = _from_tidy(old, tidy, digest, props[S.RAW_PROP_URL]["url"])
    return new, {**details, "raw_datatype": datatype}


def _from_tidy(old, tidy, digest, raw_url):
    new = tidy_to_financial_record(
        tidy,
        old.code,
        old.provenance,
        disclosure_type=derive_disclosure_type(tidy) or old.disclosure_type,
        disclosed_at=old.disclosed_at,
    )
    reference = old.disclosed_at.date() if old.disclosed_at else old.provenance.data_date
    if new is None or new.consolidated is None or reference is None:
        raise ValueError(f"{old.code}: 実績期末・連結区分・開示日を原本で確定できません")
    if new.fiscal_period_end > reference:
        raise ValueError(f"{old.code}: 再解析後も実績期末が開示日より未来です")
    before, after = _record_dict(old), _record_dict(new)
    changes = {
        key: {"old": before[key], "new": value}
        for key, value in after.items()
        if before[key] != value
    }
    return new, {
        "parser_sha256": PARSER_SHA256,
        "raw_sha256": digest,
        "raw_url": raw_url,
        "changes": changes,
    }


def _cached_item(item: dict, cache_dir: Path) -> dict:
    """検証済みjournalの原本を再使用する。欠損時にHTTPで埋めない。"""
    old = _record_from_dict(item["old"])
    digest = item["raw_sha256"]
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError(f"{old.code}: 原本cache SHA256が不正です")
    cached = cache_dir / f"{digest}.zip"
    if not cached.exists() or cached.stat().st_size > MAX_RAW_BYTES:
        raise ValueError(f"{old.code}: 原本cache欠損/64MiB上限超過")
    content = cached.read_bytes()
    if hashlib.sha256(content).hexdigest() != digest:
        raise ValueError(f"{old.code}: 原本cache SHA256が一致しません")
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        if sum(entry.file_size for entry in archive.infolist()) > MAX_EXPANDED_BYTES:
            raise ValueError(f"{old.code}: 原本展開後が128MiB上限を超えました")
        names = archive.namelist()
    csv_format = any(name.lower().endswith(".csv") for name in names)
    xbrl_format = any(name.lower().endswith((".xbrl", "-ixbrl.htm")) for name in names)
    if csv_format == xbrl_format or (csv_format and old.provenance.source is not Source.EDINET):
        raise ValueError(f"{old.code}: 原本cacheの形式を一意に確定できません")
    if not old.provenance.raw_page_id:
        raise ValueError(f"{old.code}: 原本page IDがありません")
    if csv_format:
        tidy = edinet_csv_zip_to_tidy(content, old.code, old.provenance.raw_page_id)
        datatype = "csv"
    else:
        tidy = xbrl_zip_to_tidy(content, old.code, old.provenance.raw_page_id)
        datatype = "tdnet_xbrl" if old.provenance.source is Source.TDNET else "xbrl"
    new, details = _from_tidy(old, tidy, digest, item["raw_url"])
    return {"page_id": item["page_id"], "old": item["old"], "new": _record_dict(new),
            "raw_datatype": datatype, **details}


def reparse_cached(source_journal: Path, journal: Path, cache_dir: Path):
    """Notionへ再queryせず全cacheを再解析。apply時には正本を再読して一致を要求する。"""
    started = time.monotonic()
    items = list(_journal_items(source_journal).values())
    if not items or any("error" in item for item in items):
        raise ValueError("元journalに未検証の原本があります")
    previous = _journal_items(journal)
    done = {item["page_id"] for item in items
            if item["page_id"] in previous
            and previous[item["page_id"]].get("parser_sha256") == PARSER_SHA256
            and previous[item["page_id"]].get("raw_sha256") == item["raw_sha256"]
            and previous[item["page_id"]].get("old") == item["old"]}
    pending = [item for item in items if item["page_id"] not in done]
    journal.parent.mkdir(parents=True, exist_ok=True)
    checked = changed = failed = 0
    with journal.open("a") as output, ThreadPoolExecutor(max_workers=4) as pool:
        for offset in range(0, len(pending), 100):
            futures = [(item, pool.submit(_cached_item, item, cache_dir))
                       for item in pending[offset:offset + 100]]
            for original, future in futures:
                checked += 1
                try:
                    item = future.result()
                    changed += bool(item["changes"])
                except (ValueError, zipfile.BadZipFile) as exc:
                    failed += 1
                    item = {"page_id": original["page_id"], "error": str(exc)}
                output.write(_json(item) + "\n")
                output.flush()
            print(_json({"checked": checked, "changed": changed, "failed": failed}), flush=True)
    print(_json({"scanned": len(items), "resumed": len(done), "checked": checked,
                 "changed": changed, "failed": failed, "notion_requests": 0,
                 "elapsed_seconds": round(time.monotonic() - started, 1)}), flush=True)
    if failed:
        raise RuntimeError(f"原本cache再解析に{failed}件失敗しました。journalを確認してください")


def apply_reparsed(
    client: NotionClient, database_id: str, page: dict, record: FinancialSummaryRecord,
    *, targets: list[dict] | None = None, defer_readback: bool = False,
) -> tuple[str, dict]:
    """開示日時ガードで新しい原本を守る。修正先の再読検証後だけ旧キーをarchiveする。"""
    if targets is None:
        targets = client.query_database(
            database_id,
            filter=financial_summary_filter(
                record.code, record.fiscal_period_end, record.disclosure_type, record.consolidated
            ),
            strict=True,
        )
    if len(targets) > 1:
        raise ValueError(f"{record.code}: 修正先の財務キーが重複しています")
    target = targets[0] if targets else page
    allowed = financial_overwrite_allowed(target, record)
    saved = client.update_page(target["id"], financial_summary_properties(record)) if allowed else target
    if not defer_readback:
        saved = client.get_page(target["id"])
    actual = _page_record(saved)
    if allowed and actual != record:
        raise ValueError(f"{record.code}: Notion再読値が原本再解析値と一致しません")
    if not allowed and (
        actual.code != record.code
        or actual.fiscal_period_end != record.fiscal_period_end
        or actual.disclosure_type != record.disclosure_type
        or actual.consolidated != record.consolidated
        or financial_overwrite_allowed(saved, record)
    ):
        raise ValueError(f"{record.code}: 新しい開示を保持したことを確認できません")
    if not defer_readback and target["id"] != page["id"]:
        client.archive_page(page["id"])
    return ("reparsed" if allowed else "newer_disclosure_preserved"), saved


def _financial_pages(client, database_id, source, future_after, codes):
    filters = [{"property": S.PROP_SOURCE, "select": {"equals": source}}] if source else []
    if codes:
        filters.append(
            {"or": [{"property": S.FIN_PROP_CODE, "rich_text": {"equals": code}} for code in codes]}
        )
    if future_after:
        filters.append(
            {"property": S.FIN_PROP_PERIOD_END, "date": {"after": future_after.isoformat()}}
        )
    if future_after or codes:
        yield from client.query_database(database_id, filter={"and": filters}, strict=True)
        return
    month, last = _bounds(client, database_id)
    while month <= last:
        following = _next_month(month)
        bounds = [
            {"property": S.FIN_PROP_PERIOD_END, "date": {"on_or_after": month.isoformat()}},
            {"property": S.FIN_PROP_PERIOD_END, "date": {"before": following.isoformat()}},
        ]
        yield from client.query_database(
            database_id, filter={"and": [*filters, *bounds]}, strict=True
        )
        month = following


def audit(*, source, future_after, limit, journal: Path, cache_dir: Path, codes=None):
    started = time.monotonic()
    settings = load_settings()
    if not settings.notion_token:
        raise ValueError("NOTION_TOKEN が必要です")
    client = NotionClient(settings.notion_token, rps=settings.notion_rps)
    cache_dir.mkdir(parents=True, exist_ok=True)
    journal.parent.mkdir(parents=True, exist_ok=True)
    done = {
        page_id
        for page_id, item in _journal_items(journal).items()
        if "error" not in item and item.get("parser_sha256") == PARSER_SHA256
    }
    groups = defaultdict(list)
    scanned = 0
    for page in _financial_pages(client, settings.db_id("financials"), source, future_after, codes):
        if limit is not None and scanned >= limit:
            break
        scanned += 1
        if page["id"] in done:
            continue
        old = _page_record(page)
        if old.provenance.data_date is None:
            raise ValueError(f"{old.code}: 原本の取得対象日がありません")
        groups[(old.provenance.source.value, old.provenance.data_date)].append((page["id"], old))
    checked = changed = failed = fallbacks = 0
    with (
        journal.open("a") as output,
        httpx.Client(
            timeout=60,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=4),
        ) as download_client,
        ThreadPoolExecutor(max_workers=4) as pool,
    ):
        for (data_source, data_date), rows in sorted(
            groups.items(), key=lambda entry: (entry[0][0] != "TDnet", entry[0][1])
        ):
            # ⑤を日付・source・種別でまとめてquery。個別GETを100行/reqのページングへ減らす。
            raw_pages = client.query_database(
                settings.db_id("raw_files"),
                filter={
                    "and": [
                        {"property": S.PROP_SOURCE, "select": {"equals": data_source}},
                        {"property": S.PROP_DATA_DATE, "date": {"equals": data_date.isoformat()}},
                        {
                            "or": [
                                {"property": S.RAW_PROP_DATATYPE, "rich_text": {"equals": kind}}
                                for kind in ("csv", "tdnet_xbrl", "xbrl")
                            ]
                        },
                    ]
                },
                strict=True,
            )
            raw_by_id = {page["id"].replace("-", ""): page for page in raw_pages}
            futures = []
            for page_id, old in rows:
                raw_id = old.provenance.raw_page_id
                raw_page = raw_by_id.get(raw_id.replace("-", ""))
                if raw_page is None:
                    fallbacks += 1
                    raw_page = client.get_page(raw_id)
                futures.append(
                    (
                        page_id,
                        old,
                        pool.submit(reparse_record, old, raw_page, cache_dir, download_client),
                    )
                )
            for page_id, old, future in futures:
                checked += 1
                try:
                    new, details = future.result()
                    changed += bool(details["changes"])
                    item = {
                        "page_id": page_id,
                        "old": _record_dict(old),
                        "new": _record_dict(new),
                        **details,
                    }
                except (ValueError, httpx.HTTPError, zipfile.BadZipFile) as exc:
                    failed += 1
                    item = {
                        "page_id": page_id,
                        "error": str(exc) if isinstance(exc, ValueError) else type(exc).__name__,
                    }
                output.write(_json(item) + "\n")
                output.flush()
            print(
                _json(
                    {
                        "source": data_source,
                        "date": data_date,
                        "checked": checked,
                        "changed": changed,
                        "failed": failed,
                    }
                ),
                flush=True,
            )
    print(
        _json(
            {
                "scanned": scanned,
                "resumed": len(done),
                "checked": checked,
                "changed": changed,
                "failed": failed,
                "raw_get_fallbacks": fallbacks,
                "partial": bool(limit is not None or source or future_after or codes),
                "elapsed_seconds": round(time.monotonic() - started, 1),
            }
        ),
        flush=True,
    )
    if failed:
        raise RuntimeError(f"原本の再解析に{failed}件失敗しました。journalを確認し再開してください")


def _financial_key(record: FinancialSummaryRecord) -> tuple:
    return record.code, record.fiscal_period_end, record.disclosure_type, record.consolidated


def _live_pages(client: NotionClient, database_id: str, codes: list[str]) -> list[dict]:
    return client.query_database(
        database_id,
        filter={"or": [
            {"property": S.FIN_PROP_CODE, "rich_text": {"equals": code}} for code in codes
        ]},
        strict=True,
    )


APPLY_BATCH_CODES = 50


def apply_journal(journal: Path, receipts: Path | None = None, *, workers: int = 1):
    if not 1 <= workers <= 4:
        raise ValueError("Notion反映workersは1〜4が必要です")
    items = list(_journal_items(journal).values())
    if not items or any("error" in item for item in items):
        raise ValueError("失敗を含むjournalは反映できません。確認・再解析が必要です")
    if any(item.get("parser_sha256") != PARSER_SHA256 for item in items):
        raise ValueError("parserが監査後に変わりました。同じjournalで全件を再解析してください")
    settings = load_settings()
    client = NotionClient(settings.notion_token, rps=settings.notion_rps)
    database_id = settings.db_id("financials")
    grouped = defaultdict(list)
    canonical_values = defaultdict(list)
    for item in items:
        grouped[item["old"]["code"]].append(item)
        canonical_values[_financial_key(_record_from_dict(item["new"]))].append(item["new"])
    for group in grouped.values():
        # キー変更で複数の開示が合流するとき、最新原本を先に修復する。
        group.sort(key=lambda item: item["new"]["disclosed_at"] or "", reverse=True)
    codes = sorted(grouped)
    receipts = receipts if receipts is not None else journal.with_suffix(".applied.jsonl")
    receipts.parent.mkdir(parents=True, exist_ok=True)
    previous = _journal_items(receipts)
    stopping = Event()
    receipt_lock = Lock()

    def checked_batch(batch_codes):
        if stopping.is_set():
            return []
        try:
            # 対象コード群の直前の正本をまとめて読む。異なるbatchで同じコードは扱わない。
            pages = _live_pages(client, database_id, batch_codes)
            by_id = {page["id"]: page for page in pages}
            by_key = defaultdict(list)
            for page in pages:
                by_key[_financial_key(_page_record(page))].append(page)
            pending = []
            for code in batch_codes:
                for item in grouped[code]:
                    if stopping.is_set():
                        return []
                    record = _record_from_dict(item["new"])
                    key = _financial_key(record)
                    targets = by_key[key]
                    if len(targets) > 1:
                        raise ValueError(f"{code}: 修正先の財務キーが重複しています")
                    page = by_id.get(item["page_id"])
                    if targets and _record_dict(_page_record(targets[0])) == item["new"]:
                        saved, action = targets[0], "already_reparsed"
                        if page is not None and page["id"] != saved["id"]:
                            if _record_dict(_page_record(page)) != item["old"]:
                                raise ValueError(f"{code}: 監査後に旧正本が変わりました")
                    elif (targets and (
                            # 後日の誤キー修正で、この原本自身のページが最新版の
                            # 修正先になる場合。新鮮なcanonical全項目一致だけを許す。
                            (page is not None and page["id"] == targets[0]["id"])
                            or (page is None and item["page_id"] in previous
                                and previous[item["page_id"]].get("raw_sha256") == item["raw_sha256"]
                                and previous[item["page_id"]]["target_page_id"] == targets[0]["id"]))
                          # 旧receiptはarchive先のリンク証拠だけ。数値は必ず今回の
                          # parserで再解析したcanonical原本と新鮮な正本読取で再検証する。
                          and _record_dict(_page_record(targets[0])) in canonical_values[key]
                          and not financial_overwrite_allowed(targets[0], record)):
                        saved, action = targets[0], "newer_disclosure_preserved"
                    else:
                        if page is None or _record_dict(_page_record(page)) != item["old"]:
                            raise ValueError(f"{code}: 監査後に正本が変わりました。再監査してください")
                        action, saved = apply_reparsed(
                            client, database_id, page, record, targets=targets, defer_readback=True
                        )
                    if page is not None:
                        old_key = _financial_key(_page_record(page))
                        by_key[old_key] = [p for p in by_key[old_key] if p["id"] != page["id"]]
                        by_id.pop(page["id"], None)
                    by_id[saved["id"]] = saved
                    by_key[key] = [saved]
                    pending.append((item, saved, action, page))
            # PATCH応答だけを再読証拠にしない。変更/退避があるbatchは必ず新鮮な
            # まとめqueryを再発行し、全対象と旧ページの一致後にだけ退避/receiptを許す。
            if stopping.is_set():
                return []
            if any(action == "reparsed" or (page and page["id"] != saved["id"])
                   for _, saved, action, page in pending):
                fresh = {p["id"]: p for p in _live_pages(client, database_id, batch_codes)}
            else:
                fresh = by_id  # 未変更batchは最初の新鮮queryがそのまま再読証拠。
            fresh_keys = Counter(_financial_key(_page_record(p)) for p in fresh.values())
            for item, saved, action, page in pending:
                actual = fresh.get(saved["id"])
                if actual is None or _record_dict(_page_record(actual)) != _record_dict(_page_record(saved)):
                    raise ValueError(f"{item['old']['code']}: Notionまとめ再読値が原本再解析値と一致しません")
                if fresh_keys[_financial_key(_page_record(actual))] != 1:
                    raise ValueError(f"{item['old']['code']}: 再読した新正本キーが重複しています")
                if page and page["id"] != saved["id"]:
                    old = fresh.get(page["id"])
                    if old is None or _record_dict(_page_record(old)) != item["old"]:
                        raise ValueError(f"{item['old']['code']}: 退避前の旧正本が変わりました")
            for item, saved, action, page in pending:
                receipt = {
                    "page_id": item["page_id"], "target_page_id": saved["id"],
                    "parser_sha256": PARSER_SHA256, "raw_sha256": item["raw_sha256"],
                    "action": action, "record": _record_dict(_page_record(fresh[saved["id"]])),
                }
                # 1つのstreamへ一元append。退避成功後は停止判定を挟まず即証跡を残す。
                with receipt_lock:
                    if stopping.is_set():
                        return
                    if page and page["id"] != saved["id"]:
                        client.archive_page(page["id"])
                    output.write(_json(receipt) + "\n")
                    output.flush()
                    print(_json({"page_id": item["page_id"], "action": action}), flush=True)
        except BaseException:
            stopping.set()
            raise

    with receipts.open("a") as output:
        batches = [codes[offset:offset + APPLY_BATCH_CODES]
                   for offset in range(0, len(codes), APPLY_BATCH_CODES)]
        if workers == 1:
            for batch in batches:
                checked_batch(batch)
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(checked_batch, batch) for batch in batches]
                try:
                    for future in as_completed(futures):
                        future.result()
                except BaseException:
                    stopping.set()
                    for future in futures:
                        future.cancel()
                    raise  # contextの終了で開始済みrequestをdrain。未検証行はreceiptにしない。


def _repair_sql() -> str:
    # 監査済みの欠損もNULLで上書きする。通常取込と同じ正本完全置換。
    values = ", ".join(f"json_extract(j.value, '$[{i}]')" for i in range(len(COLUMNS)))
    assignments = [f"{c} = excluded.{c}" for c in COLUMNS if c not in FINANCIALS_PK
                   and c not in ("doc_id", "license_tag")]
    assignments.append("doc_id = CASE WHEN excluded.doc_id IS NOT NULL THEN excluded.doc_id "
                       f"WHEN excluded.source = {TABLE}.source AND excluded.disclosed_at IS "
                       f"{TABLE}.disclosed_at THEN {TABLE}.doc_id ELSE NULL END")
    assignments.append("license_tag = " + stricter_tag_sql(
        "excluded.license_tag", f"{TABLE}.license_tag"
    ))
    return (f"INSERT INTO {TABLE} ({', '.join(COLUMNS)}) SELECT {values} "
            f"FROM json_each(?) AS j WHERE true ON CONFLICT ({', '.join(FINANCIALS_PK)}) "
            f"DO UPDATE SET {', '.join(assignments)} WHERE "
            f"excluded.disclosed_at >= {TABLE}.disclosed_at OR {TABLE}.disclosed_at IS NULL")


def _doc_id(item: dict) -> str | None:
    if item["new"]["provenance"]["source"] != Source.EDINET.value:
        return None  # TDnetのZIP番号からPDF番号を推測しない。
    url = urlparse(item["raw_url"])
    match = re.fullmatch(r"/api/v2/documents/(S[0-9A-Z]+)", url.path)
    if url.scheme != "https" or url.hostname != "api.edinet-fsa.go.jp" or match is None:
        raise ValueError("EDINET原本URLから書類IDを検証できません")
    return match.group(1)


def _d1_rows(store: D1Store, codes: list[str]) -> dict:
    rows = {}
    for offset in range(0, len(codes), 50):
        batch = codes[offset:offset + 50]
        for row in store.query(f"SELECT {', '.join(COLUMNS)} FROM {TABLE} "
                               f"WHERE code IN ({', '.join('?' for _ in batch)})", batch):
            rows[tuple(row[c] for c in FINANCIALS_PK)] = row
    return rows


def sync_d1(journal: Path, receipts: Path) -> None:
    items, applied = _journal_items(journal), _journal_items(receipts)
    if not items or any("error" in i or i.get("parser_sha256") != PARSER_SHA256
                        for i in items.values()):
        raise ValueError("最新parserの成功監査だけをD1へ同期できます")
    canonical = defaultdict(list)
    for item in items.values():
        canonical[_financial_key(_record_from_dict(item["new"]))].append(item)
    verified = {}
    for page_id, item in items.items():
        receipt = applied.get(page_id)
        if (receipt is None or receipt.get("parser_sha256") != PARSER_SHA256
                or receipt.get("raw_sha256") != item["raw_sha256"]):
            raise ValueError(f"{page_id}: 原本監査と一致するNotion再読成功の記録が必要です")
        key = _financial_key(_record_from_dict(receipt["record"]))
        matches = [candidate for candidate in canonical[key] if candidate["new"] == receipt["record"]]
        if not matches:
            raise ValueError(f"{page_id}: 原本監査と一致するNotion再読成功の記録が必要です")
        proved = matches[0]
        if key in verified and verified[key][0]["new"] != proved["new"]:
            raise ValueError("同じ財務キーの正本が一意ではありません")
        verified[key] = (proved, receipt)
    settings = load_settings()
    if not settings.cloud_store.d1_enabled():
        raise ValueError("D1同期にはCF_ACCOUNT_ID、CF_API_TOKEN、CF_D1_DATABASE_IDが必要です")
    client = NotionClient(settings.notion_token, rps=settings.notion_rps)
    codes = sorted({key[0] for key in verified})
    live = {}
    for offset in range(0, len(codes), 50):
        for page in _live_pages(client, settings.db_id("financials"), codes[offset:offset + 50]):
            live[page["id"]] = _record_dict(_page_record(page))
    if any(live.get(receipt["target_page_id"]) != item["new"]
           for item, receipt in verified.values()):
        raise ValueError("Notion正本が再読成功後に変わりました。D1書込を止めます")
    store = D1Store(settings.cloud_store, writer="financials_verified_repair")
    existing = _d1_rows(store, codes)
    stock_ids = {}
    prefetch_stock_ids(store, codes, cache=stock_ids)
    rows = [record_to_row(_record_from_dict(item["new"]), stock_id=stock_ids[key[0]],
                          doc_id=_doc_id(item), raw_sha256=item["raw_sha256"])
            for key, (item, receipt) in verified.items()]
    proof_columns = ("code", "source", "disclosed_at", "raw_sha256")
    document_ids = defaultdict(set)
    for old in existing.values():
        if old["doc_id"] is not None and old["raw_sha256"] is not None:
            document_ids[tuple(old[c] for c in proof_columns)].add(old["doc_id"])
    for row in rows:
        if row[COLUMNS.index("doc_id")] is not None:
            continue
        ids = document_ids[tuple(row[COLUMNS.index(c)] for c in proof_columns)]
        if len(ids) > 1:
            raise ValueError("同じ原本の既存書類IDが一意ではありません")
        if ids:
            [row[COLUMNS.index("doc_id")]] = ids
    for offset in range(0, len(rows), 100):
        store.query(_repair_sql(), [_json(rows[offset:offset + 100])])
    saved = _d1_rows(store, codes)
    protected = 0
    for values in rows:
        expected = dict(zip(COLUMNS, values, strict=True))
        actual = saved.get(tuple(expected[c] for c in FINANCIALS_PK))
        if actual is None:
            raise ValueError("D1同期後に財務キーがありません")
        if (actual["disclosed_at"] is not None and
                (expected["disclosed_at"] is None or
                 actual["disclosed_at"] > expected["disclosed_at"])):
            protected += 1
            continue
        if (any(actual[c] != expected[c] for c in COLUMNS if c not in ("doc_id", "license_tag"))
                or strictness_rank(LicenseTag(actual["license_tag"])) <
                strictness_rank(LicenseTag(expected["license_tag"]))):
            raise ValueError("D1再読値がNotion正本と一致しません。旧キーは削除しません")
    # 正しいキーの書込・再読が済んでから、同じ原本・開示日時の誤キーだけを除く。
    new_keys = set(verified)
    removals, protected_old = [], 0
    for item in items.values():
        old = _record_from_dict(item["old"])
        key = _financial_key(old)
        if key in new_keys:
            continue
        disclosed = int(old.disclosed_at.timestamp()) if old.disclosed_at else None
        old_key = (old.code, old.fiscal_period_end.isoformat(), old.disclosure_type,
                   old.consolidated if old.consolidated is not None else UNKNOWN_CONSOLIDATED)
        existing = saved.get(old_key)
        if existing is None:
            continue
        if (existing["source"] != old.provenance.source.value
                or existing["disclosed_at"] != disclosed
                or existing["raw_sha256"] not in (None, item["raw_sha256"])):
            protected_old += 1
            continue
        removals.append([*old_key, old.provenance.source.value, disclosed, item["raw_sha256"]])
    key_join = " AND ".join(f"f.{c} = json_extract(j.value, '$[{i}]')"
                             for i, c in enumerate(FINANCIALS_PK))
    for offset in range(0, len(removals), 100):
        batch = _json(removals[offset:offset + 100])
        store.query(f"DELETE FROM {TABLE} WHERE rowid IN (SELECT f.rowid FROM json_each(?) j "
                    f"JOIN {TABLE} f ON {key_join} WHERE f.source = json_extract(j.value,'$[4]') "
                    "AND f.disclosed_at IS json_extract(j.value,'$[5]') "
                    "AND (f.raw_sha256 IS NULL OR f.raw_sha256 = json_extract(j.value,'$[6]')))",
                    [batch])
        remaining = store.query(f"SELECT COUNT(*) AS n FROM json_each(?) j "
                                f"JOIN {TABLE} f ON {key_join}", [batch])[0]["n"]
        if remaining:
            raise ValueError("旧キーが同期中に変わりました。保護して再監査が必要です")
    print(_json({"verified_rows": len(rows), "retired_old_keys": len(removals),
                 "protected_newer_d1_rows": protected,
                 "unverified_old_d1_keys": protected_old}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=["TDnet", "EDINET"])
    parser.add_argument("--code", action="append", help="先行監査する銘柄コード。複数指定可")
    parser.add_argument("--future-after", type=date.fromisoformat)
    parser.add_argument("--limit", type=int, help="サンプル監査の件数。全件検証とは扱わない")
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, default=Path("/tmp/kabulab-financial-raw-cache"))
    parser.add_argument("--reparse-cached-from", type=Path, help="検証済み原本cacheを再解析（API呼出なし）")
    parser.add_argument(
        "--apply-journal", action="store_true", help="監査済みjournalをNotion③だけへ反映"
    )
    parser.add_argument("--receipts", type=Path, help="Notion再読成功の記録先（D1同期の前提）")
    parser.add_argument("--apply-workers", type=int, choices=range(1, 5), default=1,
                        help="Notion修復の独立50コードbatch本数。既定1、共有rate上限はNOTION_RPS")
    parser.add_argument("--sync-d1", action="store_true", help="正本再読成功行を設定先D1へ同期")
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit は正数が必要です")
    if sum(bool(mode) for mode in (args.apply_journal, args.sync_d1, args.reparse_cached_from)) > 1:
        parser.error("Notion修復とD1同期は再読成功の記録を確認して別々に実行してください")
    if args.apply_workers != 1 and not args.apply_journal:
        parser.error("--apply-workers は --apply-journal と同時に指定してください")
    if args.reparse_cached_from:
        reparse_cached(args.reparse_cached_from, args.journal, args.cache_dir)
    elif args.sync_d1:
        if args.receipts is None:
            parser.error("--sync-d1 は --receipts が必要です")
        sync_d1(args.journal, args.receipts)
    elif args.apply_journal:
        apply_journal(args.journal, args.receipts, workers=args.apply_workers)
    else:
        audit(
            source=args.source,
            future_after=args.future_after,
            limit=args.limit,
            journal=args.journal,
            cache_dir=args.cache_dir,
            codes=args.code,
        )
