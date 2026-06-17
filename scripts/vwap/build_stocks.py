#!/usr/bin/env python3
"""
JPX 公式の「東証上場銘柄一覧(data_j.xls)」を取得し、検索用の銘柄マスター
docs/data/stocks.json を生成する。

- 4桁コード + 銘柄名 + 市場区分 を抽出(配列形式でサイズ最小化)。
- フロントの検索ボックスが、このファイルだけで コード/名称の部分一致を
  クライアントサイドで解決する。
"""

import json
import os
import re
import urllib.request

import xlrd

# 東証コード: 4桁数字、または新形式の英数字4文字(例 130A)。指数等の特殊行を除外。
CODE_RE = re.compile(r"[0-9][0-9A-Z]{3}")

JPX_URL = (
    "https://www.jpx.co.jp/markets/statistics-equities/misc/"
    "tvdivq0000001vg2-att/data_j.xls"
)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "stocks.json")
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# 市場区分の表示用短縮
SEG_SHORT = {
    "プライム（内国株式）": "プライム",
    "スタンダード（内国株式）": "スタンダード",
    "グロース（内国株式）": "グロース",
    "プライム（外国株式）": "プライム(外)",
    "スタンダード（外国株式）": "スタンダード(外)",
    "グロース（外国株式）": "グロース(外)",
    "ETF・ETN": "ETF/ETN",
    "PRO Market": "PRO",
}


def main():
    req = urllib.request.Request(JPX_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()

    book = xlrd.open_workbook(file_contents=data)
    sheet = book.sheet_by_index(0)

    header = [str(c.value).strip() for c in sheet.row(0)]
    col = {name: i for i, name in enumerate(header)}
    ci = col["コード"]
    ni = col["銘柄名"]
    si = col.get("市場・商品区分", -1)

    stocks = []
    for r_idx in range(1, sheet.nrows):
        row = sheet.row(r_idx)
        code = str(row[ci].value).strip()
        if code.endswith(".0"):
            code = code[:-2]
        # 4桁数字 or 英数字4文字(新形式)のみ。指数・特殊行を除外。
        if not CODE_RE.fullmatch(code):
            continue
        name = str(row[ni].value).strip()
        seg = str(row[si].value).strip() if si >= 0 else ""
        seg = SEG_SHORT.get(seg, seg)
        stocks.append([code, name, seg])

    stocks.sort(key=lambda x: x[0])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"count": len(stocks), "stocks": stocks},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"stocks.json: {len(stocks)} 銘柄")
    # 市場区分内訳
    from collections import Counter
    for seg, n in Counter(s[2] for s in stocks).most_common():
        print(f"  {seg or '(空)'}: {n}")


if __name__ == "__main__":
    main()
