# EDINET コードリスト 9-IPO sector33 SOURCE PREP 証跡 (2026-09-30)

9 月新規上場 9 銘柄 (618A・619A・621A・625A・622A・623A・627A・634A・646A) の
EDINET 同一性・sector33 の一次取得 PREP。値は private のみ、ここには集計のみ。

## 取得 (source 1)

- URL: `https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip`
  (既存 `CODELIST_URL` の再利用。retry 0・redirect 0 の単発 GET)
- 完了: 2026-09-30T04:46:40Z、HTTP 200、571872 bytes、
  SHA256 `f7f1d42f8f573226…`、server content-md5 照合一致
- zip 内は `EdinetcodeDlInfo.csv` 単独 (exact 名)。メタ行 asOf 2026-09-30、
  データ 11394 行、ヘッダ 13 列一意、列不足行 0

## 保管

- `universe:edinet-codelist-2026-09-30` に raw ZIP + HTTP meta の 2 ファイルを
  `recordPrimaryData` force:false で 1 回記録し、同 run で unique + 全 bytes
  SHA の readback 2/2 一致を確認 (read-only lookup 4 API + hosted 2 GET)

## 適格 (offline・実 parser)

- 実 `parse_codelist` で上場 3817 件、data_date 2026-09-30
- 9 対象中 6 件が ticker 単独・EDINET コード有・sector33 正規化可で適格
  (618A・619A・621A・625A・623A・634A)
- 3 件は source asOf 時点で CSV 全フィールドに不在のため正直 HOLD
  (622A・627A: JPX 上場 9/18、646A: JPX 上場 9/29)
- 全 ticker の conflicting duplicate 0 (winner-last 採用なし)

## 信頼境界の最小修正 (本 PR)

- `edinet_codelist._read_codelist_csv`: 期待名単独でなければ STOP
  (複数 CSV の先頭採用・別名・不在の黙認を除去)
- `parse_codelist`: ヘッダ名の重複は STOP、非空白の列不足行は STOP
  (完全な空白行のみ従来どおり skip)
- 新規 7 件: 敵対ベクタ 6 (複数/別名/不在/重複ヘッダ/非空白短行/空白 skip)
  + 実フィクスチャの前提固定 1 (単一名・一意ヘッダ・短行なし)
- `pipeline: ruff + pytest` 全緑 (1453 passed / 0 failed / 58 skipped)。
  D1 変更 0・owner 書込 0 (enrichment は別途 review)。
