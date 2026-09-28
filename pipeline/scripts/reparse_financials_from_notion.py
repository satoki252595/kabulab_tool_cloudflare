"""Notion③の原本⑤をSHA256照合して再解析する。監査journalを確認後にNotionだけへ反映する。"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import time
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
from datetime import date, datetime
from pathlib import Path

import httpx

from backfill_financials_from_notion import _bounds, _next_month, notion_financial
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.convert.xbrl_to_csv import edinet_csv_zip_to_tidy, xbrl_zip_to_tidy
from jp_stock_pipeline.licensing import LicenseTag
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
PARSER_SHA256 = hashlib.sha256(Path(normalize_module.__file__).read_bytes()).hexdigest()


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
        "raw_url": props[S.RAW_PROP_URL]["url"],
        "changes": changes,
    }


def apply_reparsed(
    client: NotionClient, database_id: str, page: dict, record: FinancialSummaryRecord
) -> str:
    """開示日時ガードで新しい原本を守る。修正先の再読検証後だけ旧キーをarchiveする。"""
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
    if allowed:
        client.update_page(target["id"], financial_summary_properties(record))
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
    if target["id"] != page["id"]:
        client.archive_page(page["id"])
    return "reparsed" if allowed else "newer_disclosure_preserved"


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


def apply_journal(journal: Path):
    items = list(_journal_items(journal).values())
    if any("error" in item for item in items):
        raise ValueError("失敗を含むjournalは反映できません。確認・再解析が必要です")
    if any(item.get("parser_sha256") != PARSER_SHA256 for item in items):
        raise ValueError("parserが監査後に変わりました。同じjournalで全件を再解析してください")
    settings = load_settings()
    client = NotionClient(settings.notion_token, rps=settings.notion_rps)
    for item in items:
        if not item["changes"]:
            continue
        page = client.get_page(item["page_id"])
        current = _record_dict(_page_record(page))
        if current == item["new"]:
            continue
        if current != item["old"]:
            raise ValueError(f"{item['page_id']}: 監査後に正本が変わりました。再監査してください")
        action = apply_reparsed(
            client, settings.db_id("financials"), page, _record_from_dict(item["new"])
        )
        print(_json({"page_id": item["page_id"], "action": action}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=["TDnet", "EDINET"])
    parser.add_argument("--code", action="append", help="先行監査する銘柄コード。複数指定可")
    parser.add_argument("--future-after", type=date.fromisoformat)
    parser.add_argument("--limit", type=int, help="サンプル監査の件数。全件検証とは扱わない")
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, default=Path("/tmp/kabulab-financial-raw-cache"))
    parser.add_argument(
        "--apply-journal", action="store_true", help="監査済みjournalをNotion③だけへ反映"
    )
    args = parser.parse_args()
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit は正数が必要です")
    if args.apply_journal:
        apply_journal(args.journal)
    else:
        audit(
            source=args.source,
            future_after=args.future_after,
            limit=args.limit,
            journal=args.journal,
            cache_dir=args.cache_dir,
            codes=args.code,
        )
