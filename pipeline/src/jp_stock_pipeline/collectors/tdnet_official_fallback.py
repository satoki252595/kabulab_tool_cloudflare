"""TDnet 公式「適時開示情報閲覧サービス」直接パースのフォールバックコレクター
(DESIGN.md §11: やのしんAPI停止リスク対応。P3で同時実装し後回しにしない)。

エンドポイント:
    GET https://www.release.tdnet.info/inbs/I_list_{ページ番号3桁}_{YYYYMMDD}.html
    例: I_list_001_20260610.html（1ページ=最大100件、当日含む直近約1ヶ月分のみ公開）

実レスポンス構造（2026-06-10 取得のフィクスチャで確認）:
- ``<table id="main-list-table">`` の各 ``<tr>`` が1開示。列は
  時刻(kjTime "HH:MM") / コード(kjCode 5桁) / 会社名(kjName) /
  表題(kjTitle, 相対PDFリンク) / XBRL(kjXbrl, あればzipリンク) /
  上場取引所(kjPlace) / 更新履歴(kjHistroy)
- ページャは ``onclick="pagerLink('I_list_002_20260610.html')"`` 形式。
  連番でループし、リンクに無いページ・404 で停止する
- 文書は UTF-8（meta が非標準形式のため lxml の自動判別に任せず明示デコード）

インターフェース契約（やのしん版と共通・§4 ソース抽象化）:
    list_disclosures_official(settings, target_date)
        -> (RawArtifact, list[DisclosureRecord])
  返り値の DisclosureRecord は collectors/tdnet_yanoshin.list_disclosures と
  完全に同一形式。doc_id は PDF ファイル名由来でやのしん側と同一値になるため、
  ④ の冪等 upsert キーがソースを跨いで安定する (CONTRACTS 不変条件5)。

原本保存 (§5.1): 1ページ取得=1原本。複数ページの日は
``fetch_list_pages()`` が全ページ分の RawArtifact を返すので、ジョブは
そちらを使って全原本を⑤へアップロードすること（原本必須 §8.1-4）。
``list_disclosures_official`` は共通シグネチャ維持のため代表として
1ページ目の RawArtifact を返す。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
import re
from datetime import date, datetime
from urllib.parse import urljoin

import lxml.html

from ..config import Settings
from ..http import FetchError, fetch
from ..licensing import source_license
from ..models import JST, DisclosureRecord, Provenance, RawArtifact, Source
from ..rawstore import save_raw
from .tdnet_yanoshin import classify_title, corporate_action_attrs, normalize_company_code

logger = logging.getLogger(__name__)

BASE_URL = "https://www.release.tdnet.info/inbs/"

# 連番ループの安全上限（1日100件×40ページ=4,000開示を超える日は実在しない）
MAX_PAGES = 40

# 公式一覧の1ページ件数。2026-11-02 の実ページは `1～100件 / 全N件`。
OFFICIAL_PAGE_SIZE = 100

# fresh 判定で増やす公式一覧 GET の上限（1ページ目を含む）。
# 時間判定が既に upstream_stopped のときは census 自体を呼ばない（追加 0）。
# これを超えるページは取らず partial。http.fetch が元々持つ 429/5xx の再試行は増やさない。
OFFICIAL_FRESHNESS_MAX_GETS = 40

# 休日・開示なしの公式ページ（HTTP 200）にだけ出る文。表も kaijiSum も無い。
_CLOSED_MARK = "に開示された情報はありません。"
_CLOSED_RE = re.compile(
    rf'<div id="kaiji-text-1">\s*{re.escape(_CLOSED_MARK)}\s*</div>'
)
_DATE_RE = re.compile(
    r'<div id="kaiji-date-1">(\d{4})年(\d{2})月(\d{2})日</div>'
)
# 全角チルダ（U+FF5E）が実ページ。波ダッシュ（U+301C）は同じ範囲記号として読む。
_KAIJI_RE = re.compile(
    r'class="kaijiSum">\s*(\d+)[\u301c\uff5e](\d+)件(?:&nbsp;)?/(?:&nbsp;)?全(\d+)件'
)

_PAGE_LINK_RE = re.compile(r"I_list_(\d{3})_(\d{8})\.html")


def page_url(target_date: date, page_no: int) -> str:
    """ページURL: I_list_{ページ番号3桁}_{YYYYMMDD}.html"""
    return f"{BASE_URL}I_list_{page_no:03d}_{target_date:%Y%m%d}.html"


def _known_page_numbers(html_text: str, target_date: date) -> set[int]:
    """ページャの onclick からその日のページ番号集合を抽出する。"""
    datestr = f"{target_date:%Y%m%d}"
    return {
        int(num)
        for num, d in _PAGE_LINK_RE.findall(html_text)
        if d == datestr
    }


def parse_official_page(
    html_text: str,
    target_date: date,
    *,
    fetched_at: datetime,
    raw_page_id: str | None = None,
) -> list[DisclosureRecord]:
    """公式一覧ページ1枚分の HTML を DisclosureRecord 群へ変換する（値不変）。

    - 相対PDFリンクは BASE_URL で絶対URL化
    - doc_id は PDF ファイル名（拡張子除く）から導出（やのしん側と同一値）
    - has_xbrl は XBRL 列のリンク有無
    - 時刻は HH:MM のみ公開のため秒=00 の JST datetime（値の捏造ではなく
      公式ページの粒度そのまま）
    """
    records, _skipped = _parse_official_rows(
        html_text, target_date, fetched_at=fetched_at, raw_page_id=raw_page_id
    )
    return records


def _parse_official_rows(
    html_text: str,
    target_date: date,
    *,
    fetched_at: datetime,
    raw_page_id: str | None = None,
) -> tuple[list[DisclosureRecord], int]:
    """行を開示へ変換し、読み飛ばした行数も返す。読み飛ばしを 0 件成功にはしない。"""
    doc = lxml.html.fromstring(html_text)
    records: list[DisclosureRecord] = []
    skipped = 0
    for row in doc.xpath('//table[@id="main-list-table"]/tr'):
        title_links = row.xpath('.//td[contains(@class,"kjTitle")]//a')
        if not title_links:
            # PDFリンクが無い行は doc_id（④の冪等キー）を導出できない。
            # 捏造IDは作らずスキップ（原本HTMLには残る §3）
            skipped += 1
            logger.warning("PDFリンクなしの行をスキップ: %s", row.text_content()[:60])
            continue
        link = title_links[0]
        href = (link.get("href") or "").strip()
        pdf_name = href.rsplit("/", 1)[-1]
        if not pdf_name.lower().endswith(".pdf"):
            skipped += 1
            logger.warning("PDF以外のリンクをスキップ: %s", href)
            continue
        doc_id = pdf_name[: -len(".pdf")]
        title = link.text_content().strip()

        time_text = _cell_text(row, "kjTime")
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", time_text)
        if not m:
            skipped += 1
            logger.warning("時刻を解釈できずスキップ: %r (doc_id=%s)", time_text, doc_id)
            continue
        disclosed_at = datetime(
            target_date.year, target_date.month, target_date.day,
            int(m.group(1)), int(m.group(2)), tzinfo=JST,
        )

        doc_type = classify_title(title)
        split_ratio, split_factor, effective_date = corporate_action_attrs(title, doc_type)
        records.append(
            DisclosureRecord(
                doc_id=doc_id,
                title=title,
                disclosed_at=disclosed_at,
                provenance=Provenance(
                    source=Source.TDNET,
                    license_tag=source_license(Source.TDNET),  # factual-cite (§2.2)
                    data_date=target_date,
                    fetched_at=fetched_at,
                    raw_page_id=raw_page_id,
                ),
                code=normalize_company_code(_cell_text(row, "kjCode")),
                doc_type=doc_type,
                source_url=urljoin(BASE_URL, href),
                has_xbrl=bool(row.xpath('.//td[contains(@class,"kjXbrl")]//a')),
                split_ratio=split_ratio,
                split_factor=split_factor,
                effective_date=effective_date,
            )
        )
    return records, skipped


def _cell_text(row: lxml.html.HtmlElement, klass: str) -> str:
    cells = row.xpath(f'.//td[contains(@class,"{klass}")]')
    return cells[0].text_content().strip() if cells else ""


@dataclass(frozen=True)
class OfficialListCensus:
    """公式一覧を読んだ結果。確定できない件数は None のまま（0 にしない）。"""

    status: str
    count: int | None
    skipped_rows: int
    gets: int
    detail: str
    records: tuple[DisclosureRecord, ...] = ()


@dataclass(frozen=True)
class _PageBody:
    total: int
    expected_last: int
    parsed: int
    skipped: int
    records: tuple[DisclosureRecord, ...]


def _listed_date(html: str) -> date | None:
    matched = _DATE_RE.search(html)
    if matched is None:
        return None
    try:
        return date(int(matched.group(1)), int(matched.group(2)), int(matched.group(3)))
    except ValueError:
        return None


def _kaiji_mark(html: str) -> tuple[str, tuple[int, int, int] | None]:
    found = _KAIJI_RE.findall(html)
    if not found:
        return "missing", None
    marks = [(int(start), int(end), int(total)) for start, end, total in found]
    if any(mark != marks[0] for mark in marks):
        return "disagree", None
    return "ok", marks[0]


def _census(
    status: str,
    *,
    count: int | None,
    skipped_rows: int,
    gets: int,
    detail: str,
    records: tuple[DisclosureRecord, ...] = (),
) -> OfficialListCensus:
    return OfficialListCensus(status, count, skipped_rows, gets, detail, records)


def _save_official_page(
    settings: Settings,
    target_date: date,
    page_no: int,
    content: bytes,
    url: str,
    on_raw: Callable[[RawArtifact], None] | None,
) -> RawArtifact:
    artifact = save_raw(
        content,
        source=Source.TDNET,
        datatype="tdnet_official_list",
        scope=f"p{page_no:03d}",
        data_date=target_date,
        url=url,
        ext="html",
        license_tag=source_license(Source.TDNET),
        base_dir=settings.raw_data_dir,
    )
    if on_raw is not None:
        on_raw(artifact)
    return artifact


def _read_official_page(
    settings: Settings,
    target_date: date,
    page_no: int,
    *,
    gets: int,
    before_fetch: Callable[[], None] | None,
    on_raw: Callable[[RawArtifact], None] | None,
    expected_total: int | None,
) -> tuple[OfficialListCensus | _PageBody, int]:
    """1 ページを 1 GET で読む。再試行は足さない。確定不能は census で返す。"""
    if gets >= OFFICIAL_FRESHNESS_MAX_GETS:
        return _census(
            "partial",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"GET 上限 {OFFICIAL_FRESHNESS_MAX_GETS} に達した",
        ), gets
    gets += 1
    url = page_url(target_date, page_no)
    request_kwargs = {} if before_fetch is None else {"before_request": before_fetch}
    try:
        if before_fetch is not None:
            before_fetch()
        resp = fetch(url, **request_kwargs)
    except FetchError as exc:
        status = "fetch_failed" if page_no == 1 else "partial"
        why = "1ページ目を取得できない" if page_no == 1 else f"{page_no}ページ目を取得できない"
        return _census(
            status, count=None, skipped_rows=0, gets=gets, detail=f"{why}: {exc}"
        ), gets
    content = resp.content
    if not isinstance(content, bytes):
        raise TypeError(
            f"公式一覧の応答本文が bytes でない: {type(content).__name__}"
        )
    try:
        html = content.decode("utf-8")
    except UnicodeError as exc:
        return _census(
            "unreadable",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"{page_no}ページ目が UTF-8 でない: {exc}",
        ), gets
    artifact = _save_official_page(settings, target_date, page_no, content, url, on_raw)
    if page_no == 1 and _CLOSED_RE.search(html) and (
        'id="main-list-table"' not in html and "kaijiSum" not in html
    ):
        listed = _listed_date(html)
        if listed is None:
            return _census(
                "unreadable",
                count=None,
                skipped_rows=0,
                gets=gets,
                detail="開示なしの文はあるが日付を読めない",
            ), gets
        if listed != target_date:
            return _census(
                "unreadable",
                count=None,
                skipped_rows=0,
                gets=gets,
                detail=f"開示なしの日付 {listed.isoformat()} が対象日と違う",
            ), gets
        # 文面が 0 件を述べている。欠測の 0 埋めではない。
        return _census(
            "holiday",
            count=0,
            skipped_rows=0,
            gets=gets,
            detail="HTTP 200 で表が無く、開示された情報はないと明記",
        ), gets
    if 'id="main-list-table"' not in html:
        status = "no_table" if page_no == 1 else "partial"
        detail = (
            "HTTP 200 だが main-list-table が無く、開示なしの文もない"
            if page_no == 1
            else f"{page_no}ページ目に表が無い"
        )
        return _census(
            status, count=None, skipped_rows=0, gets=gets, detail=detail
        ), gets
    listed = _listed_date(html)
    if listed is None:
        return _census(
            "unreadable",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"{page_no}ページ目の日付を読めない",
        ), gets
    if listed != target_date:
        return _census(
            "unreadable",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"{page_no}ページ目の日付 {listed.isoformat()} が対象日と違う",
        ), gets
    kind, mark = _kaiji_mark(html)
    if kind == "disagree":
        return _census(
            "unreadable",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"{page_no}ページ目の kaijiSum が一致しない",
        ), gets
    if kind != "ok" or mark is None:
        return _census(
            "unreadable",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"{page_no}ページ目の kaijiSum を読めない",
        ), gets
    start, end, total = mark
    if expected_total is not None and total != expected_total:
        return _census(
            "count_mismatch",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"{page_no}ページ目の全{total}件が 1 ページ目の全{expected_total}件と違う",
        ), gets
    if total < 1 or start < 1 or end < start or end > total:
        return _census(
            "unreadable",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"{page_no}ページ目の kaijiSum 範囲が不正",
        ), gets
    expected_start = (page_no - 1) * OFFICIAL_PAGE_SIZE + 1
    expected_end = min(page_no * OFFICIAL_PAGE_SIZE, total)
    if start != expected_start or end != expected_end:
        return _census(
            "unreadable",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=(
                f"{page_no}ページ目の範囲 {start}-{end} が"
                f"ページサイズ {OFFICIAL_PAGE_SIZE} と合わない"
            ),
        ), gets
    expected_last = (total + OFFICIAL_PAGE_SIZE - 1) // OFFICIAL_PAGE_SIZE
    known = _known_page_numbers(html, target_date)
    expected_pages = set(range(1, expected_last + 1))
    if known and known != expected_pages:
        return _census(
            "partial",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"ページャ {sorted(known)} が kaijiSum の {expected_last} ページと違う",
        ), gets
    if not known and expected_last > 1:
        return _census(
            "partial",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"全{total}件なのにページャが無い",
        ), gets
    records, skipped = _parse_official_rows(
        html, target_date, fetched_at=artifact.fetched_at
    )
    if skipped:
        return _census(
            "skipped_rows",
            count=None,
            skipped_rows=skipped,
            gets=gets,
            detail=f"{page_no}ページ目で {skipped} 行を読み飛ばした",
        ), gets
    span = end - start + 1
    if len(records) != span:
        return _census(
            "count_mismatch",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=f"{page_no}ページ目は {len(records)} 行で、kaijiSum の範囲は {span} 件",
        ), gets
    return _PageBody(total, expected_last, len(records), skipped, tuple(records)), gets


def census_official_list(
    settings: Settings,
    target_date: date,
    *,
    before_fetch: Callable[[], None] | None = None,
    on_raw: Callable[[RawArtifact], None] | None = None,
) -> OfficialListCensus:
    """対象日の公式一覧を読み、行数と kaijiSum が一致するか返す。

    GET は最大 OFFICIAL_FRESHNESS_MAX_GETS（40）。休日（200 で開示なしの文、
    表も kaijiSum も無い）は count=0。1 ページ目の FetchError は fetch_failed。
    続きのページが取れないときは partial。件数は確定しない限り None。
    """
    first, gets = _read_official_page(
        settings,
        target_date,
        1,
        gets=0,
        before_fetch=before_fetch,
        on_raw=on_raw,
        expected_total=None,
    )
    if isinstance(first, OfficialListCensus):
        return first
    if first.expected_last > OFFICIAL_FRESHNESS_MAX_GETS:
        return _census(
            "partial",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=(
                f"kaijiSum {first.total} 件は {first.expected_last} ページ。"
                f"GET 上限 {OFFICIAL_FRESHNESS_MAX_GETS} を超えるため続きを取らない"
            ),
        )
    parsed = first.parsed
    collected = list(first.records)
    for page_no in range(2, first.expected_last + 1):
        nxt, gets = _read_official_page(
            settings,
            target_date,
            page_no,
            gets=gets,
            before_fetch=before_fetch,
            on_raw=on_raw,
            expected_total=first.total,
        )
        if isinstance(nxt, OfficialListCensus):
            return nxt
        parsed += nxt.parsed
        collected.extend(nxt.records)
    if parsed != first.total or len(collected) != parsed:
        detail = (
            f"読み取った {parsed} 件が kaijiSum {first.total} 件と違う"
            if parsed != first.total
            else f"ページごとの件数 {parsed} と開示一覧 {len(collected)} が違う"
        )
        return _census(
            "count_mismatch",
            count=None,
            skipped_rows=0,
            gets=gets,
            detail=detail,
        )
    return _census(
        "confirmed",
        count=parsed,
        skipped_rows=0,
        gets=gets,
        detail=f"kaijiSum {first.total} 件と一致",
        records=tuple(collected),
    )


def fetch_list_pages(
    settings: Settings, target_date: date, *, before_fetch: Callable[[], None] | None = None,
    on_raw: Callable[[RawArtifact], None] | None = None,
) -> list[tuple[RawArtifact, list[DisclosureRecord]]]:
    """指定日の一覧を全ページ取得する（1ページ=1原本 §5.1）。

    ページャリンクで判明したページを連番で辿り、未知ページ・404 で停止する。
    1ページ目の取得失敗はその日の一覧自体が取得不能として FetchError を送出
    （欠損として記録するのは呼び出し側 §3-2）。
    """
    results: list[tuple[RawArtifact, list[DisclosureRecord]]] = []
    known_pages = {1}
    page_no = 1
    while page_no <= MAX_PAGES and page_no in known_pages:
        if before_fetch is not None:
            before_fetch()
        url = page_url(target_date, page_no)
        try:
            resp = fetch(url, **({} if before_fetch is None else {"before_request": before_fetch}))
        except FetchError:
            if page_no == 1:
                raise  # その日の一覧が存在しない（休日等）or 取得不能
            logger.warning("ページ %d の取得に失敗。ここまでで停止: %s", page_no, url)
            break
        content = resp.content
        html_text = content.decode("utf-8")  # メタ宣言どおり UTF-8 を明示
        # 構造検証 (CONTRACTS): 一覧テーブルが無い 200 応答 (メンテ/エラーページ)
        # は原本保存しない。1ページ目なら一覧自体の取得不能として FetchError (§3)
        if 'id="main-list-table"' not in html_text:
            if page_no == 1:
                raise FetchError(
                    f"公式TDnet一覧に main-list-table が無い (エラーページ?): {url}"
                )
            logger.warning("ページ %d が一覧形式でない。ここまでで停止: %s", page_no, url)
            break
        artifact = save_raw(
            content,
            source=Source.TDNET,
            datatype="tdnet_official_list",
            scope=f"p{page_no:03d}",  # ページごとに原本ファイル名を一意化
            data_date=target_date,
            url=url,
            ext="html",
            license_tag=source_license(Source.TDNET),
            base_dir=settings.raw_data_dir,
        )
        if on_raw is not None:
            on_raw(artifact)
        records = parse_official_page(
            html_text, target_date, fetched_at=artifact.fetched_at
        )
        results.append((artifact, records))
        known_pages |= _known_page_numbers(html_text, target_date)
        page_no += 1
    return results


def list_disclosures_official(
    settings: Settings, target_date: date
) -> tuple[RawArtifact, list[DisclosureRecord]]:
    """指定日の適時開示一覧を公式ページから取得する（やのしん版フォールバック）。

    Returns:
        (RawArtifact, list[DisclosureRecord])
        RawArtifact は1ページ目の原本（代表）。複数ページの日に全ページの
        原本 RawArtifact が必要な場合は fetch_list_pages() を使うこと
        （原本必須 §8.1-4。本関数の records は全ページ分を含む）。

    Note:
        collectors/tdnet_yanoshin.list_disclosures と同一の返り値契約
        （§4 ソース抽象化）。DisclosureRecord のフィールド・doc_id 体系も
        同一のため、やのしん停止時 (§11) にそのまま差し替えられる。
    """
    pages = fetch_list_pages(settings, target_date)
    first_artifact = pages[0][0]
    all_records = [rec for _artifact, recs in pages for rec in recs]
    return first_artifact, all_records
