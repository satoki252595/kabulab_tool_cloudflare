"""認定済み直接 ticker↔issuer 証拠を、現在FSA/JPX ownerで再資格化する。

原本証明は過去のbindingのみ。名前・Notion mirror・過去業種は使わない。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)
LEDGER = Path(__file__).resolve().parents[4] / "docs/ipo-classification-ledger-20260930.json"

# 既存current READの拡張。singleton以外はNULLとなり認定経路をHOLDする。
# listing履歴の最新episodeを使う。新しい（未来を含む）episodeなら過去認定は失効。
SNAPSHOT_COLUMNS = """c.id, c.code, c.sector33, c.is_active, c.instrument_type,
 (SELECT CASE WHEN COUNT(*) = 1 AND MAX(id) = 1 THEN MAX(eligibility_as_of) END
  FROM universe_overlay_state) AS owner_as_of,
 (SELECT MAX(effective_date) FROM universe_official_events e
  WHERE e.code = c.code AND e.kind = 'listing') AS latest_listing_date,
 (SELECT MAX(effective_date) FROM universe_official_events e
  WHERE e.code = c.code AND e.kind = 'delist'
  AND e.effective_date <= (SELECT MAX(eligibility_as_of)
  FROM universe_overlay_state)) AS effective_delist_date"""
SNAPSHOT_SQL = f"SELECT {SNAPSHOT_COLUMNS} FROM core_stocks c ORDER BY c.code"
ACTIVE_SNAPSHOT_SQL = (
    f"SELECT {SNAPSHOT_COLUMNS} FROM core_stocks c "
    "WHERE c.is_active = ? AND c.instrument_type = ? ORDER BY c.code"
)


def load_bindings() -> list[dict]:
    """既存台帳内の明示認定だけ読む。不正な認定entryは黙って無効化しない。"""
    entries = json.loads(LEDGER.read_text(encoding="utf-8"))["entries"]
    bindings = []
    for entry in entries:
        if "identityBinding" not in entry:
            continue
        b = dict(entry["identityBinding"], ticker=entry["code"])
        if (entry["status"] != "domestic-ordinary-positive"
                or b["listingDate"] != entry["listingDate"]
                or not re.fullmatch(r"E[0-9]{5}", b["edinetCode"])
                or not re.fullmatch(r"[0-9]{13}", b["corporateNumber"])
                or type(b["coreStockId"]) is not int or b["coreStockId"] <= 0):
            raise ValueError("IPO identityBinding が不正")
        date.fromisoformat(b["listingDate"])
        date.fromisoformat(b["fsaReference"]["asOf"])
        for ref in (b["fsaReference"], b["coreReference"]):
            if not re.fullmatch(r"[0-9a-f]{64}", ref["sha256"]):
                raise ValueError("IPO identityBinding 初期資格参照pinが不正")
        if not b["archiveKey"] or not re.fullmatch(r"[0-9a-f]{64}", b["archiveZipSha256"]):
            raise ValueError("IPO identityBinding の物理原本参照が不正")
        sources = b["sources"]
        if len(sources) != 2 or {s["role"] for s in sources} != {"notice", "stock"}:
            raise ValueError("IPO identityBinding の直接証拠が不足")
        hosts = set()
        for s in sources:
            url = urlsplit(s["url"])
            fetched = datetime.fromisoformat(s["fetchedAt"])
            if (url.scheme != "https" or not url.hostname or fetched.tzinfo is None
                    or not re.fullmatch(r"[0-9a-f]{64}", s["sha256"])
                    or type(s["bytes"]) is not int or s["bytes"] <= 0):
                raise ValueError("IPO identityBinding 原本pinが不正")
            hosts.add(url.hostname)
        if len(hosts) != 1:
            raise ValueError("IPO identityBinding の公式hostが不一致")
        bindings.append(b)
    for key in ("ticker", "edinetCode"):
        if len({b[key] for b in bindings}) != len(bindings):
            raise ValueError(f"IPO identityBinding の {key} が重複")
    return bindings


def resolve_blank_tickers(zip_bytes: bytes, current: list[dict] | None) -> dict[int, str]:
    """行番号→認定ticker。生CSVは変更せず、literal競合は全callerでSTOP。

    current未提供/owner遅延/issuer変更はHOLD。将来CSVでも毎回現在値を検査する。
    """
    from .edinet_codelist import _read_codelist_rows, normalize_sec_code

    asof, idx, rows = _read_codelist_rows(zip_bytes)
    bindings = load_bindings()
    resolved = {}
    for b in bindings:
        issuer = b["edinetCode"]
        matches = [(n, r) for n, r in rows if r[idx["ＥＤＩＮＥＴコード"]].strip() == issuer]
        # literal tickerを他issuerが使う場合も認定との矛盾。blankからそこへjoinしない。
        for _, r in rows:
            if (normalize_sec_code(r[idx["証券コード"]]) == b["ticker"]
                    and r[idx["ＥＤＩＮＥＴコード"]].strip() != issuer):
                raise ValueError(f"identity literal conflict: {b['ticker']} / {issuer}")
        if len(matches) > 1:
            raise ValueError(f"identity duplicate issuer: {issuer}")
        if not matches:
            continue
        lineno, row = matches[0]
        raw = row[idx["証券コード"]].strip()
        if raw and normalize_sec_code(raw) != b["ticker"]:
            raise ValueError(f"identity literal conflict: {issuer} / {raw!r}")
        corp_index = idx.get("提出者法人番号")
        corp = row[corp_index].strip() if corp_index is not None else None
        if corp != b["corporateNumber"] or row[idx["上場区分"]].strip() != "上場":
            if raw:
                raise ValueError(f"identity current FSA conflict: {issuer}")
            logger.warning("identity HOLD: %s (現在FSA法人番号/上場区分が不一致)", issuer)
            continue
        if raw:
            continue  # 一致したliteralは通常parserに任せる
        candidates = [] if current is None else [r for r in current if r.get("code") == b["ticker"]]
        valid = (len(candidates) == 1 and asof is not None
                 and asof >= date.fromisoformat(b["fsaReference"]["asOf"]))
        if valid:
            c = candidates[0]
            owner = c.get("owner_as_of")
            valid = (type(c.get("id")) is int and c["id"] == b["coreStockId"]
                     and c.get("is_active") == 1 and c.get("instrument_type") == "equity"
                     and isinstance(owner, str) and date.fromisoformat(owner) >= asof
                     and asof >= date.fromisoformat(b["listingDate"])
                     and c.get("latest_listing_date") == b["listingDate"]
                     and (c.get("effective_delist_date") is None
                          or c["effective_delist_date"] < b["listingDate"]))
        if not valid:
            logger.warning("identity HOLD: %s (現在core/owner/listing episode未資格)", issuer)
            continue
        resolved[lineno] = b["ticker"]
        logger.info("identity certified: %s -> %s (raw tickerは空欄のまま)", issuer, b["ticker"])
    return resolved


def certified_update(ticker: str, sector: str, asof: date) -> tuple[str, list]:
    """認定行だけ同じidentity述語をUPDATE時にも適用し、競合はRETURNING空でSTOP。"""
    b = next(b for b in load_bindings() if b["ticker"] == ticker)
    sql = """UPDATE core_stocks SET sector33 = ?
 WHERE code = ? AND id = ? AND is_active = 1 AND instrument_type = 'equity'
 AND (SELECT CASE WHEN COUNT(*) = 1 AND MAX(id) = 1 THEN MAX(eligibility_as_of) END
      FROM universe_overlay_state) >= ?
 AND (SELECT MAX(effective_date) FROM universe_official_events
      WHERE code = core_stocks.code AND kind = 'listing') = ?
 AND NOT EXISTS (SELECT 1 FROM universe_official_events e
      WHERE e.code = core_stocks.code AND e.kind = 'delist'
      AND e.effective_date >= ? AND e.effective_date <=
      (SELECT MAX(eligibility_as_of) FROM universe_overlay_state))
 RETURNING code"""
    return sql, [sector, ticker, b["coreStockId"], asof.isoformat(), b["listingDate"], b["listingDate"]]
