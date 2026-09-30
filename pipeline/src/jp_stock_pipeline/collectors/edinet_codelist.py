"""EDINETコードリスト収集 — 銘柄マスタの正本 (DESIGN.md §2.1, §4, P1)。

- 金融庁公開のコードリスト zip（CSV同梱）を取得する。商用利用可
  (公共データ利用規約 PDL1.0 準拠 §2.1) のため license_tag=commercial-ok
- zip 内 CSV は cp932。1行目はメタ行（公表基準日・件数）、
  2行目がヘッダ、3行目以降がデータ（実レスポンスで確認済み）
- 証券コードは5桁（末尾0、例 "72030"・新方式 "409A0"）→ 4桁に正規化
- 変換版は cp932→UTF-8 の文字コード正規化のみ（値不変 §5.2）
"""

from __future__ import annotations

import csv
import io
import logging
import re
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date

import requests

from ..config import Settings
from ..contracts.stock_code import source_code_to_ticker
from ..http import FetchError, fetch
from ..licensing import LicenseTag
from ..models import ConvertStatus, Provenance, RawArtifact, Source, StockMasterRecord, now_jst
from ..rawstore import converted_filename, save_raw

logger = logging.getLogger(__name__)

# EDINET「EDINETタクソノミ及びコードリスト」ページで公開されている EDINETコードリスト
# (zip 内に EdinetcodeDlInfo.csv)。2026-06-10 実取得確認済み
CODELIST_URL = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip"

# CSV ヘッダ名（実ファイル2行目。「ＥＤＩＮＥＴコード」は全角英字であることに注意）
_COL_EDINET_CODE = "ＥＤＩＮＥＴコード"
_COL_LISTED = "上場区分"
_COL_NAME = "提出者名"
_COL_SECTOR = "提出者業種"
_COL_SEC_CODE = "証券コード"

_LISTED_VALUE = "上場"

# メタ行（1行目）の「2026年06月10日現在」形式の日付
_META_DATE_RE = re.compile(r"(\d{4})年(\d{2})月(\d{2})日現在")


def normalize_sec_code(sec_code: str | None) -> str | None:
    """証券コードを4文字基準に正規化する。

    判定と正規化は `contracts/stock_code.py` の `source_code_to_ticker` に委譲する
    （TDnet 側の `normalize_company_code` と同一実装）。

    ここだけ「末尾0の5桁を4桁化し、それ以外は**入力をそのまま返す**」という
    規則を持っていたため、妥当性を一切検証しない素通しになっていた:

    - `"720"` / `"7203.T"` / `"A130"` / `"25935"` / `"１３０ａ"` のいずれも
      加工せずそのまま返しており、呼び出し側は不正なコードを正常値として
      受け取っていた（`edinet.py:209` は scope に、`:246` は code 列に使う）。
    - `"130a"` の大文字化と全角の半角化をしていなかったため、同じ銘柄が
      表記違いで別コードとして入りうる。

    **挙動が変わる点:** 妥当でない入力は入力の丸投げではなく None を返す
    （欠損は欠損 §3-1）。末尾0限定の扱いは旧実装から変えていないが、
    EDINET について末尾0限定の実測根拠は無い（生 secCode を保存している表が
    無く分布が取れない）。`source_code_to_ticker` の docstring を見ること。
    """
    return source_code_to_ticker(sec_code)


# 応答 metadata として manifest に残す header の allowlist (小文字)。
# 存在したものだけ拾い、欠けていても推測・補完しない。secret・session・
# Cookie・auth 系は載せない (下の deny が第二の関門)。
_RESPONSE_HEADER_ALLOWLIST = frozenset(
    {"content-type", "content-length", "last-modified", "etag"}
)
_RESPONSE_HEADER_DENY = frozenset(
    {
        "cookie",
        "set-cookie",
        "authorization",
        "proxy-authenticate",
        "proxy-authorization",
        "www-authenticate",
    }
)


def response_metadata(resp: requests.Response) -> dict[str, object]:
    """同一 Response から status・最終 URL・安全 header だけを抜き出す。

    body は触らない (原本は `save_raw` の `resp.content` が正)。header 名は
    小文字に正準化する。deny 掲載・allowlist 外は捨てる。
    """
    headers: dict[str, str] = {}
    for name, value in resp.headers.items():
        low = name.lower()
        if low in _RESPONSE_HEADER_DENY:
            continue
        if low in _RESPONSE_HEADER_ALLOWLIST:
            headers[low] = value
    return {"status": resp.status_code, "finalUrl": resp.url, "headers": headers}


def fetch_codelist(
    settings: Settings,
    *,
    on_response: Callable[[requests.Response], None] | None = None,
) -> RawArtifact:
    """コードリスト zip を取得し、無加工で原本保存する (§8.1 step 1-2)。

    `on_response` は同一 Response を受け取る最小 seam (検証通過後のみ呼ぶ。
    新 GET・新 schema なし)。渡さない既存呼び出し (月次) の挙動は不変。
    """
    resp = fetch(CODELIST_URL)
    # マジックバイト検証 (CONTRACTS): 200 で返るエラーページを正本の原本にしない (§3)
    if not resp.content.startswith(b"PK\x03\x04"):
        raise FetchError(
            f"コードリスト応答が zip でない (エラーページ?): head={resp.content[:16]!r}"
        )
    if on_response is not None:
        on_response(resp)
    data_date = None
    try:
        data_date = _meta_row_date(
            next(csv.reader(io.StringIO(_read_codelist_csv(resp.content))), [])
        )
    finally:
        # 日付解読に失敗しても原本は保全する。例外は呼出側へ伝播し、
        # 不正ZIPを成功扱いしない。取得時刻は save_raw が別に記録する。
        artifact = save_raw(
            resp.content,
            source=Source.EDINET,
            datatype="codelist",
            scope="ALL",
            data_date=data_date,
            url=CODELIST_URL,
            ext="zip",
            license_tag=LicenseTag.COMMERCIAL_OK,
            base_dir=settings.raw_data_dir,
        )
    return artifact


# zip 内のコードリスト CSV の期待名（実物はこの1ファイルのみ）。
# 複数・別名・不在は黙って先頭採用せず STOP する（信頼境界 §3）。
_EXPECTED_CSV_NAME = "EdinetcodeDlInfo.csv"


def _read_codelist_csv(zip_bytes: bytes) -> str:
    """zip 内のコードリスト CSV を cp932 でデコードして返す（値不変）。"""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if csv_names != [_EXPECTED_CSV_NAME]:
            raise ValueError(
                "コードリスト zip 内の CSV が想定と不一致 "
                f"(期待 [{_EXPECTED_CSV_NAME}] のみ、実際 {sorted(csv_names)})"
            )
        return zf.read(_EXPECTED_CSV_NAME).decode("cp932")


def _meta_row_date(meta_row: list[str]) -> date | None:
    """1行目メタ行の「YYYY年MM月DD日現在」からデータ基準日を読む。

    読めない場合は None（推定はしない §3-1）。
    """
    for cell in meta_row:
        m = _META_DATE_RE.search(cell)
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def _read_codelist_rows(
    zip_bytes: bytes,
) -> tuple[date | None, dict[str, int], list[tuple[int, list[str]]]]:
    """マスタ・業種同期で同じヘッダ/行幅検証と空白行の扱いを使う。"""
    text = _read_codelist_csv(zip_bytes)
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        raise ValueError("コードリスト CSV の行数が不足（メタ行+ヘッダ行が必要）")

    data_date = _meta_row_date(rows[0])
    header = rows[1]
    if len(header) != len(set(header)):
        dupes = sorted({h for h in header if header.count(h) > 1})
        raise ValueError(f"コードリスト CSV のヘッダ名が重複: {dupes}")
    try:
        idx = {
            name: header.index(name)
            for name in (_COL_EDINET_CODE, _COL_LISTED, _COL_NAME, _COL_SECTOR, _COL_SEC_CODE)
        }
    except ValueError as exc:
        raise ValueError(f"コードリスト CSV のヘッダが想定と不一致: {header}") from exc

    if "提出者法人番号" in header:
        idx["提出者法人番号"] = header.index("提出者法人番号")
    width = len(header)
    validated: list[tuple[int, list[str]]] = []
    for lineno, row in enumerate(rows[2:], start=3):
        if not any(cell.strip() for cell in row):
            continue  # 完全な空白行のみスキップ
        # 非空白行はヘッダと同幅が必須。過少も過多も構造不正として STOP
        # する（必要列より後ろの欠落・余分列の黙殺をしない）。
        # ヘッダ自体の拡張は妨げない（一意＋必須名＋同幅なら正常）。
        if len(row) < width:
            raise ValueError(
                f"コードリスト CSV の{lineno}行目が列不足 "
                f"(ヘッダ {width} 列に対し {len(row)} 列)"
            )
        if len(row) > width:
            raise ValueError(
                f"コードリスト CSV の{lineno}行目が列過多 "
                f"(ヘッダ {width} 列に対し {len(row)} 列)"
            )
        validated.append((lineno, row))
    return data_date, idx, validated


def parse_codelist(
    zip_bytes: bytes, *, raw_page_id: str | None = None, current: list[dict] | None = None
) -> list[StockMasterRecord]:
    """証券コードを持つ上場企業を返す。基準日は原本メタ行から読む。"""
    from .codelist_identity import resolve_blank_tickers

    resolved = resolve_blank_tickers(zip_bytes, current)
    data_date, idx, rows = _read_codelist_rows(zip_bytes)
    fetched_at = now_jst()
    records: list[StockMasterRecord] = []
    for lineno, row in rows:
        if row[idx[_COL_LISTED]].strip() != _LISTED_VALUE:
            continue  # 上場企業のみ
        code = resolved[lineno] if lineno in resolved else normalize_sec_code(row[idx[_COL_SEC_CODE]])
        if code is None:
            continue  # 証券コードを持つ企業のみ
        records.append(
            StockMasterRecord(
                code=code,
                name=row[idx[_COL_NAME]].strip(),
                edinet_code=row[idx[_COL_EDINET_CODE]].strip() or None,
                sector33=row[idx[_COL_SECTOR]].strip() or None,  # 提出者業種（33業種相当）
                listed=True,
                status="上場",  # コードリストは上場区分=上場 のみ通すため (§ Phase3)
                provenance=Provenance(
                    source=Source.EDINET,
                    license_tag=LicenseTag.COMMERCIAL_OK,
                    data_date=data_date,
                    fetched_at=fetched_at,
                    raw_page_id=raw_page_id,
                ),
            )
        )
    return records


# --- 候補検査 (master_sync / sector33_sync 共通) -------------------------------

# `00000` 証券コード由来の phantom ticker。listed として parse されるが
# 銘柄を指さないため候補から外し HOLD 診断にする (STOP しない)。
_PHANTOM_TICKER = "0000"

# EDINET code の literal 形 (`E` + 5 桁)。レジストリ照会はしない。
# 実測の両世代 (11348/11394 行) で非空白値は全てこの形。
_EDINET_RE = re.compile(r"^E[0-9]{5}$")


def is_valid_edinet_code(value: str | None) -> bool:
    """EDINET code の literal 有効性。blank は False (未知として扱う)。"""
    return value is not None and value != "" and _EDINET_RE.match(value) is not None


class CodelistInspectError(ValueError):
    """候補検査の typed STOP。`kind` で事由を区別する。"""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind


@dataclass(frozen=True)
class CandidateHold:
    """非候補の typed HOLD 診断。"""

    kind: str  # "legal-missing-ticker" | "blank-issuer-hold"
    detail: str


@dataclass(frozen=True)
class InspectedCandidates:
    """候補検査の結果。①upsert 用と sector 資格の最小区別。

    - `candidates`: ①upsert 用の全候補 (blank issuer を含む。① schema は
      optional のため改造しない)。
    - `sector`: sector 資格 (literal 有効 EDINET id 必須。blank は除外)。
    """

    candidates: list[StockMasterRecord]
    sector: list[StockMasterRecord]
    holds: list[CandidateHold]


def inspect_codelist_candidates(
    records: list[StockMasterRecord],
) -> InspectedCandidates:
    """全 records の正規化 ticker/issuer 一意性を検査し候補と HOLD に分離する。

    呼び出し位置: 全件 parse 後・limit 前・① upsert 前 (両 job 共通)。
    - `0000` phantom (`00000` 由来) → 非候補 + HOLD (STOP しない)。
    - 同一 ticker の複数行 (identical/conflicting 問わず) → STOP。
    - 同一 EDINET code の複数 ticker (blank 除外) → STOP。
    - 非空白で literal 不正な EDINET code → STOP。
    - blank issuer → typed identity HOLD + sector 除外 (①候補には残す)。
    - 候補は入力順 (dedup しない。last-wins は廃止)。name join はしない。
    """
    holds = [
        CandidateHold("legal-missing-ticker", f"00000 由来 (edinet={r.edinet_code})")
        for r in records
        if r.code == _PHANTOM_TICKER
    ]
    candidates = [r for r in records if r.code != _PHANTOM_TICKER]
    for r in candidates:
        if r.edinet_code and not is_valid_edinet_code(r.edinet_code):
            raise CodelistInspectError(
                "invalid-issuer-stop", f"{r.code}: 不正 EDINET {r.edinet_code!r}"
            )
    seen: set[str] = set()
    for r in candidates:
        if r.code in seen:
            raise CodelistInspectError(
                "dup-ticker-stop", f"{r.code} が複数行 (edinet={r.edinet_code})"
            )
        seen.add(r.code)
    by_edinet: dict[str, set[str]] = {}
    for r in candidates:
        if r.edinet_code:
            by_edinet.setdefault(r.edinet_code, set()).add(r.code)
    for edinet, tickers in sorted(by_edinet.items()):
        if len(tickers) > 1:
            raise CodelistInspectError(
                "dup-issuer-stop", f"{edinet}: {','.join(sorted(tickers))}"
            )
    sector: list[StockMasterRecord] = []
    for r in candidates:
        # 不正 nonempty は上で STOP 済み。ここに残る非有効は blank のみ。
        if not is_valid_edinet_code(r.edinet_code):
            holds.append(CandidateHold("blank-issuer-hold", f"{r.code}: issuer 空"))
            continue
        sector.append(r)
    return InspectedCandidates(candidates=candidates, sector=sector, holds=holds)


def convert_codelist(artifact: RawArtifact) -> RawArtifact:
    """原本 zip から変換版 CSV（cp932→UTF-8 正規化のみ・値不変 §5.2）を生成する。

    変換失敗時も原本保存は成立済みのまま convert_status=失敗 を記録して続行する
    (§8.1 step 3)。
    """
    try:
        text = _read_codelist_csv(artifact.local_path.read_bytes())
        out_path = artifact.local_path.parent / converted_filename(artifact.filename, "csv")
        # 文字コード正規化のみ。行・値・改行は一切変更しない (§5.2)
        out_path.write_bytes(text.encode("utf-8"))
        artifact.converted_paths.append(out_path)
        artifact.convert_status = ConvertStatus.DONE
    except Exception:
        logger.exception("コードリスト変換失敗 (原本は保存済み): %s", artifact.local_path)
        artifact.convert_status = ConvertStatus.FAILED
    return artifact
