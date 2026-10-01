# 海外売上の単一行表と実context期間 — 2026-10-02

## 修正範囲

単一行の地域別売上表は、売上を直接表す囲みTextBlock・直前の売上小見出しが
成立しても、表ローカルのcaptionに期がなければ文書全体を停止していた。
同じ有報ZIPの実contextで期間を証明する経路を、この分岐にだけ追加する。
contextRefの名前や本文順序から年度を推測せず、captionに年度を継ぎ足さない。

- 本文と同一filing stem・提出者のPublicDoc instance/headerだけを読む。
- 使用するcontext IDは各sourceで一意。実entity・開始日・終了日・暦・dimension
  不在を厳格検証する。一方のみならその定義、両方あれば等価な定義が必須。
- 未使用IDの非対応・重複はそのIDの未証明として保持。他のIDへ波及させない。
- 欠損・重複・非対応・提出者/期間矛盾は停止。printed期間との開始/終了/当期
  区分の矛盾も別表の当期値で回復せず停止する。
- 実periodはsingleRowProof/captureへ明示。dimension不在やTextBlock名から
  連結区分を作らない。売上contract、地域不明、丸め、候補競合のguardは不変。
- HTML-only fixture/監査は実contextを借りず、従来のcaption証明を必須とする。

通常ingest、海外backfill、missing-backfill、745-prep、repair-prepの既存2引数は
変更せず共有parseOverseasDataで新判定へ接続。任意の第3引数captureで全文解析と
診断を一本化する。受注・テキスト抽出・DB schema/保存処理は変更しない。

## 実原本のoffline確認

EDINET S100YJVFの新規取得済ZIPは884,834 bytes、SHA-256
`41d3af026c1090c4dc92362005630992bbaebc08186f2a98a905951043d87d13`。
全ZIPは私有のまま、最小の公表原文回帰断片と実context投影のみをfixtureとする。
出典・取得時刻・各SHA・原文権利の扱いはfixture READMEに記載。

- 修正前: 全文がsingle-row-fiscal-unknownでHOLD、facts 0。
- 修正後: 前期874210/当期893001の表は実periodを解決後も、既存の地域不明
  guardで拒否する。数値候補にせず、拒否診断に実period2件を記録する。
- 採用は833503の別の収益分解表。既存印刷証拠でT:2026-03-31、既知連結true、
  4明細。保存前検証もPASS。前期だけを証明し当期contextを欠く変換はHOLDを維持。
- 旧D1の4明細は連結区分NULLであるため、数値が一致しても全項目MATCHとは
  扱わない。原本の保管成功と本番の条件付き修復は別工程。

私有全文probe SHA-256:
`7e176a3e0c6c020a5cfbae9b407929d85449bca2bc682ac43303022390eeb0c3`。
parser SHA `cf19523a9a4f0207c2d37caaca647675a23e8ca7ac4c91e306f0c6a6ad11d743`、
新reader SHA `7cfe550a8bfe0219cb10b7c4fcf4cb347cb4642c3bb0dd1adbecb898d10a658e`。
修復準備側は新readerもmodule pinに含め、全文parseの同じcaptureを使う必要がある。

## 検証と限界

Nix管理環境でyuho-quant 24 test files / 387 tests PASS、条件付き14 tests skipped。
新context回帰18件、従来parser回帰131件、ingest/backfill/原本保管関連を含む。
root typecheck/lint PASS。期間矛盾、欠損、同値/不正duplicate、dimension、instant、
不正暦、future、提出者不一致、unused変種、HTML-only/unknown-current停止を確認。

本変更中のsource追加GET・Notion・D1・R2操作はすべて0。本番データ修復・deployは
未実施。次15候補のうち実原本資格をまだ確認していない文書、旧59件への所属不明、
旧inventory/UNKNOWN履歴をこの1件のoffline成功から解決済みにはしない。
