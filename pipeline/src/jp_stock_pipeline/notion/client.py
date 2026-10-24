"""スロットル付き Notion API クライアント (DESIGN.md §6.1, §12-4)。

- 全リクエストを設定値 (既定 2.5req/s) でスロットル
- 429 は再試行。529 / その他5xx / 通信断は安全な読み取り・上書きだけ再試行
- 作成・追記は結果不明なら再送せず失敗を返す（成功後の応答欠落による重複を防ぐ）
- dry-run (§3-6): 本番DBへ一切書き込まない。書き込み操作は self.ops に記録し
  合成ID (`dry-run-*`) を返す。読み取りはトークンがあれば実行、無ければ空を返す
- 標準エンドポイントは notion-client、File Upload 等の未対応エンドポイントは
  raw_api() (requests) を使う
"""

from __future__ import annotations

import itertools
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
import requests
from ..request_guard import assert_request_allowed
from notion_client import Client
from notion_client.errors import APIResponseError, HTTPResponseError, RequestTimeoutError

from ..config import DEFAULT_NOTION_RPS

logger = logging.getLogger(__name__)

NOTION_API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"
MAX_RETRIES = 6


# Notion は 1 クエリ（1 ページネーション系列）あたり 10,000 件で打ち切る。
# 到達すると has_more が false になるため、検知しないと「全件取れた」と誤認する。
# 出典: https://developers.notion.com/reference/query-a-data-source
QUERY_RESULT_LIMIT = 10_000


class QueryTruncatedError(RuntimeError):
    """クエリが 10,000 件上限で打ち切られた。全件前提の処理は続行してはならない。"""


class NotionRequestError(RuntimeError):
    """Notion API の失敗。作成結果不明の場合も、再送せずこの例外を返す。"""


class NotionUnknownResultError(NotionRequestError):
    """非冪等mutationの結果不明。代替保存で成功化せず、既存pendingを保持する。"""


class NotionConfigError(RuntimeError):
    """応答の形が壊れている（契約違反）。設定・実装の問題なので再試行しない。

    `_call` の retry 判定タプルに入れないこと。不正 metadata/JSON は
    1 fetch で即 STOP する。メッセージに ID/body/cursor 値は入れない。
    """


class _RetryableRawError(Exception):
    """raw_api() の 429/5xx (requests.Response 由来)。Retry-After を保持する。"""

    def __init__(self, status: int, headers):
        super().__init__(f"Notion API HTTP {status}")
        self.status = status
        self.headers = headers


@dataclass
class RecordedOp:
    """dry-run 時に記録される書き込み操作。テスト検証にも使う。"""

    op: str  # "create_page" / "update_page" / "create_database" / ...
    payload: dict[str, Any]


class _Throttle:
    def __init__(self, rps: float):
        if rps <= 0:
            raise ValueError("rps must be positive")
        self._min_interval = 1.0 / rps
        self._lock = threading.Lock()
        self._last = 0.0
        self._resume_at = 0.0

    def wait(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                delta = max(self._last + self._min_interval, self._resume_at) - now
                if delta <= 0:
                    self._last = now
                    return
            # 冷却の延長を他threadがすぐ反映できるよう、sleep中はLockを持たない。
            time.sleep(delta)

    def defer(self, seconds: float) -> None:
        with self._lock:
            self._resume_at = max(self._resume_at, time.monotonic() + seconds)


def _require_complete_request_status(resp: dict, *, op: str) -> None:
    """旧marker不在は保持。存在する未完/未知statusは最初のpageからSTOPする。"""
    if "request_status" not in resp:
        return
    status = resp["request_status"]
    if isinstance(status, dict) and status in (
        {"type": "incomplete"},
        {"type": "incomplete", "incomplete_reason": "query_result_limit_reached"},
    ):
        raise QueryTruncatedError(
            f"Notion {op}: クエリが打ち切られた。全件前提の処理を続行せず再試行しません。"
        )
    if not isinstance(status, dict) or status != {"type": "complete"}:
        raise NotionConfigError(f"Notion {op}: request_status が未知/不正。再試行しません。")


def _require_read_list_envelope(resp: object, *, op: str) -> tuple[list, bool, str | None]:
    """read-list 応答 envelope の厳密検証。NG は NotionConfigError (再試行なし)。

    - resp は dict、results は own list
    - has_more は own exact bool (int の 1 は不可)
    - next_cursor は own None または非空 str (空白のみ不可)
    - true→非空 str、false→None の pair まで見る
    - object が present なら list 以外は reject
    - request_status は absentを保持、presentの未完/未知は即STOP
    エラー文に ID/body/cursor 値は入れない。
    """
    if not isinstance(resp, dict):
        raise NotionConfigError(f"Notion {op}: 応答が dict ではない。再試行しません。")
    _require_complete_request_status(resp, op=op)
    if resp.get("object", "list") != "list":
        raise NotionConfigError(f"Notion {op}: object が list ではない。再試行しません。")
    results = resp.get("results")
    if not isinstance(results, list):
        raise NotionConfigError(f"Notion {op}: results が list ではない。再試行しません。")
    has_more = resp.get("has_more")
    if has_more is not True and has_more is not False:
        raise NotionConfigError(f"Notion {op}: has_more が exact bool ではない。再試行しません。")
    if "next_cursor" not in resp:
        raise NotionConfigError(f"Notion {op}: next_cursor が無い。再試行しません。")
    cursor = resp["next_cursor"]
    if has_more:
        if not isinstance(cursor, str) or not cursor.strip():
            raise NotionConfigError(
                f"Notion {op}: has_more=true だが next_cursor が非空 str ではない。再試行しません。"
            )
    elif cursor is not None:
        raise NotionConfigError(
            f"Notion {op}: has_more=false だが next_cursor が None ではない。再試行しません。"
        )
    return results, has_more, cursor


def _require_scalar_property_item(resp: dict, *, op: str) -> dict:
    """property retrieve の正規 scalar のみ受理する。

    object=property_item かつ type 判別子 (非空 str) があり、その判別子名の
    payload key を持つ canonical union 形だけ通す。arbitrary non-list の
    `[resp]` success fallback はしない。NG は NotionConfigError。
    """
    _require_complete_request_status(resp, op=op)
    if resp.get("object") != "property_item":
        raise NotionConfigError(f"Notion {op}: object が list/property_item 以外。再試行しません。")
    ptype = resp.get("type")
    if not isinstance(ptype, str) or not ptype or ptype not in resp:
        raise NotionConfigError(
            f"Notion {op}: property_item の type 判別子が正規形ではない。再試行しません。"
        )
    return resp


def _check_cursor_unseen(seen: set[str], cursor: str, *, op: str) -> None:
    """同一 cursor の再送 (same/A→B→A) を追加 GET 前に止める。値は出さない。"""
    if cursor in seen:
        raise NotionConfigError(f"Notion {op}: 同一 cursor の再送を検出。再試行しません。")
    seen.add(cursor)


def _retry_after_seconds(exc: Exception, attempt: int) -> float:
    """Retry-After ヘッダを尊重しつつ指数バックオフ。"""
    retry_after = 0.0
    headers = getattr(exc, "headers", None)
    if headers:
        try:
            retry_after = float(headers.get("retry-after") or headers.get("Retry-After") or 0)
        except (TypeError, ValueError):
            retry_after = 0.0
    return max(retry_after, min(2.0**attempt, 120.0))


class NotionClient:
    def __init__(
        self,
        token: str | None,
        *,
        rps: float = DEFAULT_NOTION_RPS,
        dry_run: bool = False,
    ):
        if not token and not dry_run:
            raise ValueError("NOTION_TOKEN が未設定。dry_run=True 以外では必須")
        self.dry_run = dry_run
        self.ops: list[RecordedOp] = []
        self._dry_counter = itertools.count(1)
        self._token = token
        self._throttle = _Throttle(rps)
        self._client = Client(auth=token, notion_version=NOTION_VERSION) if token else None
        self._session = requests.Session()

    # ------------------------------------------------------------------
    # 低レベル: スロットル+バックオフ付き呼び出し
    # ------------------------------------------------------------------

    def _call(self, fn, /, *, _retry_safe: bool = True, **kwargs) -> Any:
        # 429は明示拒否。529も非冪等mutationではNode同様に結果不明で止める。
        # https://developers.notion.com/reference/request-limits
        # POST query/search は読取だが、PATCH children.append は非冪等なので
        # HTTPメソッドだけでは判定しない。呼び出し側が操作の性質を指定する。
        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            self._throttle.wait()
            assert_request_allowed()
            try:
                return fn(**kwargs)
            except (
                APIResponseError, HTTPResponseError, _RetryableRawError,
                requests.RequestException, RequestTimeoutError, httpx.HTTPError,
            ) as exc:
                status = getattr(exc, "status", None) or 0
                rate_limited = status in (429, 529) or getattr(exc, "code", None) == "rate_limited"
                if isinstance(exc, APIResponseError) and not (rate_limited or status >= 500):
                    raise
                if not _retry_safe and status != 429:
                    raise NotionUnknownResultError(
                        "Notion 書き込みの結果不明。重複防止のため自動再送しません。"
                        "対象が既に作成・追記されていないか確認してから再実行してください。"
                        f" ({type(exc).__name__}, HTTP {status or '不明'})"
                    ) from exc
                delay = (
                    _retry_after_seconds(exc, attempt)
                    if isinstance(exc, (HTTPResponseError, _RetryableRawError))
                    else min(2.0**attempt, 60.0)
                )
                if rate_limited:
                    self._throttle.defer(delay)
                logger.warning("Notion %s (attempt %d) — %.1fs 待機", type(exc).__name__, attempt, delay)
                time.sleep(delay)
                last_exc = exc
        raise NotionRequestError(f"Notion API リトライ枯渇: {last_exc}") from last_exc

    def raw_api(
        self,
        method: str,
        path: str,
        *,
        json_body: dict | None = None,
        data: dict | None = None,
        files: dict | None = None,
        record_in_dry_run: bool = True,
    ) -> dict:
        """notion-client 未対応エンドポイント (File Upload 等) の直接呼び出し。

        書き込み系メソッドは dry-run では実行せず記録のみ。
        """
        is_write = method.upper() != "GET"
        if self.dry_run and is_write:
            if record_in_dry_run:
                return self._record(f"{method.upper()} {path}", json_body or data or {})
            return {}
        if not self._token:
            return {}

        endpoint = path.strip("/")
        is_list_query = method.upper() == "POST" and (
            endpoint == "search"
            or re.fullmatch(r"(?:databases|data_sources)/[^/]+/query", endpoint) is not None
        )
        is_children_list = method.upper() == "GET" and (
            re.fullmatch(r"blocks/[^/]+/children", endpoint) is not None
        )
        is_property_retrieve = method.upper() == "GET" and (
            re.fullmatch(r"pages/[^/]+/properties/[^/]+", endpoint) is not None
        )
        guard_read_list = is_list_query or is_children_list or is_property_retrieve

        def _do() -> dict:
            headers = {
                "Authorization": f"Bearer {self._token}",
                "Notion-Version": NOTION_VERSION,
            }
            resp = self._session.request(
                method,
                f"{NOTION_API_BASE}/{path.lstrip('/')}",
                json=json_body,
                data=data,
                files=files,
                headers=headers,
                timeout=120,
            )
            if resp.status_code == 429 or resp.status_code >= 500:
                raise _RetryableRawError(resp.status_code, resp.headers)
            if resp.status_code >= 400:
                raise NotionRequestError(f"Notion API {resp.status_code}: {resp.text[:500]}")
            try:
                return resp.json()
            except ValueError as exc:
                if not guard_read_list:
                    raise
                raise NotionConfigError(
                    "Notion raw_api: 応答 JSON の decode に失敗。再試行しません。"
                ) from exc

        # raw POST の読取だけを列挙する。未知のPOST・File Upload作成/送信/完了は
        # 冪等性を仮定せず、応答不明なら上位の RawUploadError / 部分失敗経路へ返す。
        retry_safe = method.upper() == "GET" or (
            method.upper() == "POST" and (
                endpoint == "search"
                or re.fullmatch(r"(?:databases|data_sources)/[^/]+/query", endpoint) is not None
            )
        )
        body = self._call(_do, _retry_safe=retry_safe)
        # 既知 read-list 経路だけ envelope を検証する (File Upload 等の
        # 非 list 成功 shape には広げない)。
        if is_property_retrieve:
            # property endpoint は own object discriminator 必須 (TS 同契約)。
            if not isinstance(body, dict) or body.get("object") not in ("list", "property_item"):
                raise NotionConfigError(
                    "Notion raw_api: object が list/property_item ではない。再試行しません。"
                )
            if body["object"] != "list":
                _require_scalar_property_item(body, op="raw_api")
                return body
        if guard_read_list:
            _require_read_list_envelope(body, op="raw_api")
        return body

    def _record(self, op: str, payload: dict[str, Any]) -> dict:
        self.ops.append(RecordedOp(op=op, payload=payload))
        synthetic_id = f"dry-run-{next(self._dry_counter)}"
        logger.info("[dry-run] %s -> %s", op, synthetic_id)
        return {"object": "dry_run", "id": synthetic_id, "op": op}

    # ------------------------------------------------------------------
    # 読み取り
    # ------------------------------------------------------------------

    def query_database(
        self,
        database_id: str,
        *,
        filter: dict | None = None,
        sorts: list[dict] | None = None,
        page_size: int = 100,
        max_pages: int | None = None,
        strict: bool = False,
        filter_properties: list[str] | None = None,
    ) -> list[dict]:
        """全ページをページネーションして返す。トークン無し dry-run では空。

        request_statusの既知incompleteは最初のpageからstrictに関係なく停止する。
        marker不在は補完せず、自然終端で取得件数>=10,000でも全量とは認定しない。
        明示max_pagesでhas_more=trueの部分読取だけ従来どおり返す（strict=Trueは
        件数上限でも停止）。complete markerでも正確10,000件は保守的に停止する。
        strict引数は既存caller互換のため維持する。
        """
        if self._client is None or str(database_id).startswith("dry-run-"):
            # dry-run の合成DB ID (runner が補完) への実クエリは行わない (§3-6)
            return []
        results: list[dict] = []
        cursor: str | None = None
        seen: set[str] = set()
        pages = 0
        while True:
            kwargs: dict[str, Any] = {"database_id": database_id, "page_size": page_size}
            if filter_properties is not None:
                kwargs["filter_properties"] = filter_properties
            if filter is not None:
                kwargs["filter"] = filter
            if sorts is not None:
                kwargs["sorts"] = sorts
            if cursor:
                kwargs["start_cursor"] = cursor
            try:
                resp = self._call(self._client.databases.query, **kwargs)
            except ValueError as exc:
                # SDK の JSON decode 失敗。HTTP/transient の retry には入れない。
                raise NotionConfigError(
                    "Notion query_database: 応答 JSON の decode に失敗。再試行しません。"
                ) from exc
            page_results, has_more, next_cursor = _require_read_list_envelope(
                resp, op="query_database"
            )
            if has_more:
                if not isinstance(next_cursor, str):
                    raise NotionConfigError(
                        "Notion query_database: 内部不整合。再試行しません."
                    )
                _check_cursor_unseen(seen, next_cursor, op="query_database")
            results.extend(page_results)
            pages += 1
            intentional_partial = bool(has_more and max_pages and pages >= max_pages)
            if not has_more or intentional_partial:
                capped = len(results) >= QUERY_RESULT_LIMIT
                if capped:
                    message = (
                        f"Notion クエリが打ち切られた可能性: db={database_id} "
                        f"取得={len(results)} 件 上限={QUERY_RESULT_LIMIT}。"
                        "全件前提の処理はこの結果を使ってはならない"
                    )
                    logger.warning("%s", message)
                    if strict or not intentional_partial:
                        raise QueryTruncatedError(message)
                return results
            cursor = next_cursor

    def get_page(self, page_id: str) -> dict:
        if self._client is None:
            return {}
        return self._call(self._client.pages.retrieve, page_id=page_id)

    def download_file(self, url: str, *, max_bytes: int | None = None) -> bytes:
        """Notion が返した添付の全実体を、認証ヘッダ・再試行・redirect 無しで読む。"""
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise NotionConfigError("Notion 添付 URL の形式が不正")
        if max_bytes is not None and (type(max_bytes) is not int or max_bytes <= 0):
            raise NotionConfigError("Notion 添付サイズ上限が不正")
        assert_request_allowed()
        try:
            options = {"stream": True} if max_bytes is not None else {}
            response = requests.get(url, timeout=120, allow_redirects=False, **options)
            if response.status_code != 200:
                if max_bytes is not None:
                    response.close()
                raise NotionRequestError(f"Notion 添付読戻し HTTP {response.status_code}")
            if max_bytes is not None:
                try:
                    length = response.headers.get("Content-Length")
                    if length is not None and (not length.isdigit() or int(length) > max_bytes):
                        raise NotionConfigError("Notion 添付がサイズ上限を超えた")
                    chunks, size = [], 0
                    for chunk in response.iter_content(chunk_size=64 * 1024):
                        size += len(chunk)
                        if size > max_bytes:
                            raise NotionConfigError("Notion 添付がサイズ上限を超えた")
                        chunks.append(chunk)
                    return b"".join(chunks)
                finally:
                    response.close()
            return response.content
        except requests.RequestException:
            # presigned URL の認証queryを、ジョブの例外traceへ持ち出さない。
            raise NotionRequestError("Notion 添付読戻しの結果不明。再試行しません") from None

    def list_page_property_items(self, page_id: str, property_id: str) -> list[dict]:
        """ページの 1 プロパティを「プロパティ取得 API」で全件読む（読み取りのみ）。

        ページオブジェクトの relation は 25 件を超えると has_more が立ち、残りが載らない。
        全件が要る処理（④重複の集約・バックアップ）はこちらで読み直す。
        戻り値は property_item の配列（relation なら各要素の ["relation"]["id"]）。
        出典: https://developers.notion.com/reference/retrieve-a-page-property
        """
        if self._client is None:
            return []
        results: list[dict] = []
        cursor: str | None = None
        seen: set[str] = set()
        while True:
            kwargs: dict[str, Any] = {"page_id": page_id, "property_id": property_id}
            if cursor:
                kwargs["start_cursor"] = cursor
            try:
                resp = self._call(self._client.pages.properties.retrieve, **kwargs)
            except ValueError as exc:
                raise NotionConfigError(
                    "Notion list_page_property_items: 応答 JSON の decode に失敗。再試行しません。"
                ) from exc
            if not isinstance(resp, dict) or resp.get("object") not in ("list", "property_item"):
                # property endpoint は own object discriminator 必須
                # (TS 同契約。missing object の list 成功 fallback はしない)。
                raise NotionConfigError(
                    "Notion list_page_property_items: object が list/property_item ではない。"
                    "再試行しません。"
                )
            if resp["object"] != "list":
                # 単一値プロパティは初頁 scalar のみ受理する。pagination begun
                # (cursor 送出済み) 後の scalar は protocol 違反として止める。
                # `if results` では空初頁→scalar を誤 success するため cursor で見る。
                if cursor is not None:
                    raise NotionConfigError(
                        "Notion list_page_property_items: list 頁の後に scalar。再試行しません。"
                    )
                return [_require_scalar_property_item(resp, op="list_page_property_items")]
            page_results, has_more, next_cursor = _require_read_list_envelope(
                resp, op="list_page_property_items"
            )
            if has_more:
                if not isinstance(next_cursor, str):
                    raise NotionConfigError(
                        "Notion list_page_property_items: 内部不整合。再試行しません."
                    )
                _check_cursor_unseen(seen, next_cursor, op="list_page_property_items")
            results.extend(page_results)
            if not has_more:
                return results
            cursor = next_cursor

    def retrieve_database(self, database_id: str) -> dict:
        if self._client is None:
            return {}
        return self._call(self._client.databases.retrieve, database_id=database_id)

    def list_child_blocks(self, block_id: str) -> list[dict]:
        if self._client is None:
            return []
        results: list[dict] = []
        cursor: str | None = None
        seen: set[str] = set()
        while True:
            kwargs: dict[str, Any] = {"block_id": block_id, "page_size": 100}
            if cursor:
                kwargs["start_cursor"] = cursor
            try:
                resp = self._call(self._client.blocks.children.list, **kwargs)
            except ValueError as exc:
                raise NotionConfigError(
                    "Notion list_child_blocks: 応答 JSON の decode に失敗。再試行しません。"
                ) from exc
            page_results, has_more, next_cursor = _require_read_list_envelope(
                resp, op="list_child_blocks"
            )
            if has_more:
                if not isinstance(next_cursor, str):
                    raise NotionConfigError(
                        "Notion list_child_blocks: 内部不整合。再試行しません."
                    )
                _check_cursor_unseen(seen, next_cursor, op="list_child_blocks")
            results.extend(page_results)
            if not has_more:
                return results
            cursor = next_cursor

    # ------------------------------------------------------------------
    # 書き込み (dry-run では記録のみ)
    # ------------------------------------------------------------------

    def create_page(
        self,
        *,
        parent: dict,
        properties: dict,
        children: list[dict] | None = None,
        icon: dict | None = None,
    ) -> dict:
        payload: dict[str, Any] = {"parent": parent, "properties": properties}
        if children:
            payload["children"] = children
        if icon:
            payload["icon"] = icon
        if self.dry_run:
            return self._record("create_page", payload)
        return self._call(self._client.pages.create, _retry_safe=False, **payload)

    def update_page(self, page_id: str, properties: dict) -> dict:
        if self.dry_run:
            return self._record("update_page", {"page_id": page_id, "properties": properties})
        return self._call(self._client.pages.update, page_id=page_id, properties=properties)

    def archive_page(self, page_id: str) -> dict:
        """ページを archive する（Notion のゴミ箱へ移す。復元可能な削除）。

        同じ page_id を何度 archive しても結果は同じなので、update と同様に再試行してよい。
        完全削除（ゴミ箱を空にする）はしない。
        """
        if self.dry_run:
            return self._record("archive_page", {"page_id": page_id})
        return self._call(self._client.pages.update, page_id=page_id, archived=True)

    def create_database(
        self,
        *,
        parent_page_id: str,
        title: str,
        properties: dict,
        icon: dict | None = None,
        description: str | None = None,
    ) -> dict:
        payload: dict[str, Any] = {
            "parent": {"type": "page_id", "page_id": parent_page_id},
            "title": [{"type": "text", "text": {"content": title}}],
            "properties": properties,
        }
        if icon:
            payload["icon"] = icon
        if description:
            payload["description"] = [{"type": "text", "text": {"content": description}}]
        if self.dry_run:
            return self._record("create_database", payload)
        return self._call(self._client.databases.create, _retry_safe=False, **payload)

    def update_database(
        self, database_id: str, *, properties: dict | None = None
    ) -> dict:
        payload: dict[str, Any] = {"database_id": database_id}
        if properties is not None:
            payload["properties"] = properties
        if self.dry_run:
            return self._record("update_database", payload)
        return self._call(self._client.databases.update, **payload)

    def append_block_children(self, block_id: str, children: list[dict]) -> dict:
        if self.dry_run:
            return self._record("append_block_children", {"block_id": block_id, "children": children})
        return self._call(
            self._client.blocks.children.append, _retry_safe=False,
            block_id=block_id, children=children
        )
