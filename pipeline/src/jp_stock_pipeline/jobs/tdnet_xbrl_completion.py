"""既処理の短信 XBRL を、読み戻しが揃ったときだけ再取得しない (H-1)。

完了は D1 `jss_financials` の行があることでは決まらない。主キーは doc_id ではなく
`(code, fiscal_period_end, disclosure_type, consolidated)` で、D1 書込は失敗しても
本処理は続く。skip するのは次がすべて読取だけで確定した doc だけ。

1. 対象 doc_id を source=TDnet の一括 SELECT で読む（doc_id 索引は無いので
   N 回の全走査にはしない。全行をクライアントへは載せず、IN 句の該当行だけ）。
2. その行の raw_page_id で Notion ⑤を今 GET する。filename / sha_map /
   jss_raw_files ではページを探さない。page・親 DB・archived・in_trash を確認し、
   応答の signed URL から原本をメモリへ読む。file_upload id のキャッシュは無い。
   URL の失効時刻は URL の寿命であり、添付バイトや D1 行の TTL ではない。
3. 同じページの tidy CSV を読み、現在の normalize で ③ を作り直す。
   fin が None のときはこの範囲では完了にしない。
4. `financial_summary_matches_page` で Notion ③の owned 値・由来・relation を照合。
5. 作り直した record が `record_to_row` の全列で D1 行と一致する。

0 件・複数行・失敗・不明・例外は再処理。検査は書き込まない。
mirror / 1株当たり fact / 会社予想は独立のベストエフォートで、欠けていても
再処理の理由にしない。保存済み・不要とも判定せず、補填も成功計上もしない。
"""

from __future__ import annotations

import hashlib
import io
import logging
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from uuid import UUID

import pandas as pd

from ..cloud_store.d1 import MAX_BOUND_PARAMS
from ..cloud_store.financials import COLUMNS, TABLE, record_to_row
from ..licensing import source_license
from ..models import DataQuality, Provenance, Source, now_jst
from ..notion import schema as S
from ..notion.upsert import financial_summary_lookup_filter, financial_summary_matches_page
from ..rawstore import converted_filename
from ..request_guard import RequestNotStartedError
from ..convert.xbrl_to_csv import TIDY_COLUMNS
from ..transform.normalize import tidy_to_financial_record
from .scheduled import ScheduledWindowError

logger = logging.getLogger(__name__)

XBRL_BACKLOG_TAG = "[INC-20261105-kabulab_tool_cloudflare-tdnet-deadline-backlog]"
_PASSTHROUGH = (ScheduledWindowError, RequestNotStartedError)
_DOC_ID_BATCH = MAX_BOUND_PARAMS - 1  # source の bind を 1 つ残す


@dataclass
class XbrlProofStats:
    """証明のための読取。効率の本番推定には使わない。"""

    d1_queries: int = 0
    d1_rows_returned: int = 0
    d1_rows_read: int | None = None
    d1_rows_read_known: bool = True
    notion_gets: int = 0
    notion_queries: int = 0
    downloads: int = 0
    download_bytes: int = 0
    proof_seconds: float = 0.0
    skip: int = 0
    reprocess: int = 0
    evidence_read_failed: bool = False
    _rows_read_parts: list[int] = field(default_factory=list)

    def log_line(self) -> str:
        rows_read = "unknown" if not self.d1_rows_read_known else str(self.d1_rows_read or 0)
        return (
            f"{XBRL_BACKLOG_TAG} xbrl_skip={self.skip} xbrl_reprocess={self.reprocess} "
            f"d1_queries={self.d1_queries} d1_rows_returned={self.d1_rows_returned} "
            f"d1_rows_read={rows_read} notion_gets={self.notion_gets} "
            f"notion_queries={self.notion_queries} downloads={self.downloads} "
            f"download_bytes={self.download_bytes} proof_seconds={self.proof_seconds:.3f}"
        )


def financial_read_statements(doc_ids: list[str]) -> list[tuple[str, list]]:
    """候補 doc_id だけの SELECT。1 文の bind は 100 未満。全表 SELECT は作らない。"""
    unique: list[str] = []
    seen: set[str] = set()
    for doc_id in doc_ids:
        if isinstance(doc_id, str) and doc_id and doc_id not in seen:
            seen.add(doc_id)
            unique.append(doc_id)
    columns = ", ".join(COLUMNS)
    statements: list[tuple[str, list]] = []
    for start in range(0, len(unique), _DOC_ID_BATCH):
        chunk = unique[start:start + _DOC_ID_BATCH]
        placeholders = ", ".join("?" for _ in chunk)
        sql = (
            f"SELECT {columns} FROM {TABLE} WHERE source = ? AND doc_id IN ({placeholders})"
        )
        statements.append((sql, [Source.TDNET.value, *chunk]))
    return statements


def load_tdnet_financials_by_doc_id(ctx, doc_ids: list[str], stats: XbrlProofStats) -> dict[str, list[dict]]:
    """読取時点の行だけを返す。件数の増減自体は失敗にしない。失敗時は空で再処理。"""
    statements = financial_read_statements(doc_ids)
    grouped = {params[index]: [] for _sql, params in statements for index in range(1, len(params))}
    if not statements:
        return grouped
    cloud = getattr(ctx, "cloud", None)
    settings = getattr(cloud, "settings", None)
    enabled = bool(settings is not None and settings.d1_enabled())
    if cloud is None or not enabled:
        stats.evidence_read_failed = True
        logger.warning("%s D1 を読めないため XBRL は再処理する", XBRL_BACKLOG_TAG)
        return {}
    started = time.perf_counter()
    try:
        for sql, params in statements:
            observe: dict = {}
            try:
                rows = cloud.d1.query(sql, params, observe=observe)
            except _PASSTHROUGH:
                raise
            except Exception as exc:
                stats.evidence_read_failed = True
                logger.warning(
                    "%s ③証跡の一括読取に失敗したため XBRL は再処理する: %s",
                    XBRL_BACKLOG_TAG, type(exc).__name__,
                )
                return {}
            stats.d1_queries += 1
            if type(observe.get("rows_read")) is int:
                stats._rows_read_parts.append(observe["rows_read"])
            else:
                stats.d1_rows_read_known = False
            if not isinstance(rows, list):
                stats.evidence_read_failed = True
                return {}
            for row in rows:
                if not isinstance(row, dict):
                    stats.evidence_read_failed = True
                    return {}
                doc_id = row.get("doc_id")
                if doc_id not in grouped:
                    stats.evidence_read_failed = True
                    return {}
                grouped[doc_id].append(row)
                stats.d1_rows_returned += 1
    finally:
        stats.proof_seconds += time.perf_counter() - started
    if stats.d1_rows_read_known:
        stats.d1_rows_read = sum(stats._rows_read_parts)
    return grouped


def financial_xbrl_already_complete(ctx, record, rows: list[dict], *, master_id: str | None, stats: XbrlProofStats) -> bool:
    """True のときだけ fetch を省く。例外（期限・未開始）は握らない。"""
    if stats.evidence_read_failed or len(rows) != 1:
        return False
    started = time.perf_counter()
    try:
        return _prove(ctx, record, rows[0], master_id=master_id, stats=stats)
    except _PASSTHROUGH:
        raise
    except Exception as exc:
        logger.warning(
            "%s doc_id=%s の完了証跡を確定できないため再処理する: %s",
            XBRL_BACKLOG_TAG, record.doc_id, type(exc).__name__,
        )
        return False
    finally:
        stats.proof_seconds += time.perf_counter() - started


def _prove(ctx, record, row: dict, *, master_id: str | None, stats: XbrlProofStats) -> bool:
    raw_page_id = row.get("raw_page_id")
    raw_sha = row.get("raw_sha256")
    if not isinstance(raw_page_id, str) or not isinstance(raw_sha, str):
        return False
    try:
        page_uuid = str(UUID(raw_page_id))
    except ValueError:
        return False
    if raw_sha != row.get("raw_sha256") or len(raw_sha) != 64:
        return False
    stats.notion_gets += 1
    page = ctx.client.get_page(page_uuid)
    props = _active_raw_page(page, ctx.settings.db_id("raw_files"), page_uuid)
    if props is None:
        return False
    if not _clock_ok(_read_date(props, S.PROP_FETCHED_AT)):
        return False
    if (
        _read_select(props, S.PROP_SOURCE) != Source.TDNET.value
        or _read_select(props, S.PROP_LICENSE_TAG) != source_license(Source.TDNET).value
        or _plain(props, S.RAW_PROP_DATATYPE) != "tdnet_xbrl"
        or _plain(props, S.RAW_PROP_SCOPE) != (record.code or "")
        or _read_date(props, S.PROP_DATA_DATE) != record.disclosed_at.date().isoformat()
    ):
        return False
    filename = _plain(props, S.RAW_PROP_FILENAME)
    page_sha = _plain(props, S.RAW_PROP_SHA256)
    size = props.get(S.RAW_PROP_SIZE, {}).get("number")
    files = props.get(S.RAW_PROP_FILES, {}).get("files")
    if (
        not filename or page_sha != raw_sha or type(size) is not int or size <= 0
        or not isinstance(files, list)
    ):
        return False
    original = _one_file(files, filename)
    tidy_name = converted_filename(filename, "csv")
    tidy_file = _one_file(files, tidy_name)
    if original is None or tidy_file is None:
        return False
    raw_bytes = _download(ctx, original, filename, stats, max_bytes=size)
    if raw_bytes is None or len(raw_bytes) != size or hashlib.sha256(raw_bytes).hexdigest() != raw_sha:
        return False
    tidy_bytes = _download(ctx, tidy_file, tidy_name, stats, max_bytes=None)
    if tidy_bytes is None:
        return False
    frame = _read_tidy(tidy_bytes, record)
    if frame is None:
        return False
    fetched = _clock_ok(_read_financial_clock(ctx, record, frame, master_id, page_uuid, stats))
    if fetched is None:
        return False
    prov = Provenance(
        source=Source.TDNET,
        license_tag=source_license(Source.TDNET),
        data_date=record.disclosed_at.date(),
        fetched_at=fetched,
        raw_page_id=page_uuid,
        quality=DataQuality.OK,
    )
    built = tidy_to_financial_record(
        frame, record.code or "", prov, disclosed_at=record.disclosed_at,
    )
    if built is None:
        return False
    cache = getattr(getattr(ctx, "cloud", None), "_stock_ids", None)
    if not isinstance(cache, dict) or record.code not in cache:
        return False
    expected = record_to_row(
        built, stock_id=cache[record.code], doc_id=record.doc_id, raw_sha256=raw_sha,
    )
    for column, want in zip(COLUMNS, expected, strict=True):
        if column not in row or not _cell_equal(column, want, row[column]):
            return False
    return True


def _read_financial_clock(ctx, record, frame, master_id, page_uuid, stats: XbrlProofStats):
    """③の取得日時。⑤の原本時計とは別に保存されるので、ここで等しいとは要求しない。"""
    built_probe = tidy_to_financial_record(
        frame, record.code or "",
        Provenance(
            source=Source.TDNET, license_tag=source_license(Source.TDNET),
            data_date=record.disclosed_at.date(), fetched_at=now_jst(), raw_page_id=page_uuid,
        ),
        disclosed_at=record.disclosed_at,
    )
    if built_probe is None:
        return None
    stats.notion_queries += 1
    pages = ctx.client.query_database(
        ctx.settings.db_id("financials"),
        filter=financial_summary_lookup_filter(
            built_probe.code, built_probe.fiscal_period_end,
            built_probe.disclosure_type, built_probe.consolidated,
        ),
    )
    if not isinstance(pages, list) or len(pages) != 1 or not isinstance(pages[0], dict):
        return None
    properties = pages[0].get("properties")
    if not isinstance(properties, dict):
        return None
    clock = _clock_ok(_read_date(properties, S.PROP_FETCHED_AT))
    if clock is None:
        return None
    prov = Provenance(
        source=Source.TDNET, license_tag=source_license(Source.TDNET),
        data_date=record.disclosed_at.date(), fetched_at=clock, raw_page_id=page_uuid,
        quality=DataQuality.OK,
    )
    built = tidy_to_financial_record(
        frame, record.code or "", prov, disclosed_at=record.disclosed_at,
    )
    if built is None or not financial_summary_matches_page(properties, built, master_id):
        return None
    return _read_date(properties, S.PROP_FETCHED_AT)


def _active_raw_page(page: dict, database_id: str, page_uuid: str) -> dict | None:
    if not isinstance(page, dict):
        return None
    parent = page.get("parent")
    try:
        same = str(UUID(page.get("id"))) == page_uuid
    except (TypeError, ValueError):
        return None
    if (
        not same or page.get("object") != "page" or page.get("archived") is not False
        or page.get("in_trash") is True or not isinstance(parent, dict)
        or parent.get("type") != "database_id" or not isinstance(parent.get("database_id"), str)
        or parent["database_id"].replace("-", "").lower() != database_id.replace("-", "").lower()
    ):
        return None
    props = page.get("properties")
    return props if isinstance(props, dict) else None


def _one_file(files: list, name: str) -> dict | None:
    found = [item for item in files if isinstance(item, dict) and item.get("name") == name]
    if len(found) != 1 or found[0].get("type") != "file":
        return None
    url = found[0].get("file", {}).get("url") if isinstance(found[0].get("file"), dict) else None
    if not isinstance(url, str) or not url.startswith("https://"):
        return None
    return found[0]


def _download(ctx, attachment: dict, logical_name: str, stats: XbrlProofStats, *, max_bytes: int | None) -> bytes | None:
    url = attachment["file"]["url"]
    stats.downloads += 1
    content = ctx.client.download_file(url, max_bytes=max_bytes) if max_bytes is not None else ctx.client.download_file(url)
    if not isinstance(content, bytes):
        return None
    stats.download_bytes += len(content)
    hosted = attachment["name"]
    if hosted == logical_name:
        return content
    if hosted == f"{logical_name}.zip":
        return _unwrap_zip(content, logical_name)
    return None


def _unwrap_zip(content: bytes, logical_name: str) -> bytes | None:
    """ZIP の一時ファイルは読み終わったら消す。展開結果だけをメモリで返す。"""
    with tempfile.TemporaryDirectory(prefix="tdnet-xbrl-proof-") as tmp:
        path = Path(tmp) / "attachment.zip"
        path.write_bytes(content)
        try:
            with zipfile.ZipFile(path) as archive:
                if archive.namelist() != [logical_name] or archive.testzip() is not None:
                    return None
                data = archive.read(logical_name)
        finally:
            path.unlink(missing_ok=True)
        return data if isinstance(data, bytes) else None


def _read_tidy(csv_bytes: bytes, record) -> pd.DataFrame | None:
    try:
        frame = pd.read_csv(io.BytesIO(csv_bytes), dtype="string", keep_default_na=False)
    except (UnicodeError, pd.errors.ParserError, ValueError):
        return None
    if list(frame.columns) != TIDY_COLUMNS or frame.empty:
        return None
    if set(frame["doc_id"].astype(str)) != {record.doc_id}:
        return None
    if set(frame["code"].astype(str)) != {record.code or ""}:
        return None
    return frame


def _plain(props: dict, name: str) -> str:
    blocks = props.get(name, {})
    if not isinstance(blocks, dict):
        return ""
    parts = blocks.get("title", blocks.get("rich_text"))
    if not isinstance(parts, list):
        return ""
    return "".join(
        part.get("plain_text", "") for part in parts if isinstance(part, dict)
    ).strip()


def _read_select(props: dict, name: str) -> str | None:
    value = props.get(name, {})
    if not isinstance(value, dict):
        return None
    selected = value.get("select")
    if not isinstance(selected, dict):
        return None
    name_value = selected.get("name")
    return name_value if isinstance(name_value, str) else None


def _read_date(props: dict, name: str) -> str | None:
    value = props.get(name, {})
    if not isinstance(value, dict):
        return None
    date_value = value.get("date")
    if not isinstance(date_value, dict):
        return None
    start = date_value.get("start")
    return start if isinstance(start, str) else None


def _clock_ok(value: str | None) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        clock = datetime.fromisoformat(value)
    except ValueError:
        return None
    if clock.tzinfo is None or clock.utcoffset() is None or clock > now_jst():
        return None
    return clock


def _cell_equal(column: str, expected, got) -> bool:
    if column == "raw_page_id":
        try:
            return str(UUID(str(got))) == str(UUID(str(expected)))
        except (TypeError, ValueError):
            return False
    if expected is None or got is None:
        return expected is None and got is None
    if isinstance(expected, bool) or isinstance(got, bool):
        return False
    if isinstance(expected, float) or isinstance(got, float):
        try:
            return float(got) == float(expected)
        except (TypeError, ValueError):
            return False
    return got == expected
