# 優待 source52 historical repair — 運用記録 (2026-09-30)

16銘柄・52優待行の historical ABC/desc/利回り修復の実施記録。
本番コード追加なし。本書に raw 本文・Notion page ID・秘密情報・body 成果物は
含まない (公開 stock/context ID・SHA/counts のみ開示)。

## スコープ

- 16 stocks / 52 benefit rows / 54 outside rows (保護)
- 7075: canonical desc + 6,500/13,000 company 値。8153 sibs 2行は別正準証明
- 35 unrepaired siblings: HOLD のまま (illegal-attr 0)

## source custody (事前・read-only 検証)

- 34 unique physical records / 68 原本: manifest SHA 68/68 一致。再取得なし
- 82 literal spans: 82/82 検証 (pointer 解決 + bytes 内包 + grounding)
- span 被覆 50/52。38126/38130 は 82span 外 → 一意 triple + 機械 HOLD +
  3 spans の別証明で支える (開示継続)
- v3 taskId 11件 stale (pins 由来・SQL bytes 外)。開示のみ

## stage8 custody (Notion)

- 8 files: PRE4 raw4 + LEDGER + CAPTURE-RESULT + prep6b report + metadata
- key `657d8ed83b091d0335d80385047ffb9c101f36eea16c0f45e588ff2073fc7a21`
- payload `bf7cce6b8245fd92ecc10330fb6c80fd61aa1fd54a18682964f8cc5534eb4ce7`
- `recorded`/`written` (force=false, 1 call)。readback 当初 STOP は
  期待名誤り (正規化名で照合) が原因。runtime は page 添付に original 名を
  使用 (archive.ts)。original 8名で full bytes readback 8/8 PASS
  (recovery receipt `474d1e42716e5f2e5a8e193e029ccc29a69d82ce9f04322e9bf9c781e35dcce8`)

## WRITE (exec16。承認済み1回実行)

- 16/16 success、74 statements (preflight16 + ABC38 + desc4 + yield10 + score6)
- 38 groups / 52 rows: 31 groups・42 cleanup 行 + 1 group・sib 2行 +
  4 groups・company 4行 + 2 groups・7075 4行。desc 4件は 7075 shares-tier 別。
  利回り changed 10銘柄・score 6銘柄
- 銘柄別文数: 143:6、343:7、493:6、501:3、515:2、644:4、826:4、927:2、
  1051:2、1095:2、1127:8、1230:4、1243:2、1476:5、1500:7、1546:10
- 共有 strict sender (success 厳密判定・有限 binds・UNKNOWN STOP) +
  private fetch-tee の exact-200 強制 (sender 本体の `res.ok` ではない)。
  銘柄毎 attempt-before + settle receipt + raw bytes (wx0600)。retry/resend 0
- 実行時計は銘柄毎の送受信 UTC + HTTP Date を記録。EMIT 判定は実測時計のみ

## POST4 (承認済み1回実行。`yutai-post4-capture-2026-09-30T08-10-53-779Z`)

- 16/106/16/16 行・11/11/19/7 列。touched52 / outside54 / core16 /
  fin16 / sco16 全一致
- EMIT 時刻 (52 updated_at + 10 fetched_at): 整数・EXEC16 記録時計内・
  HTTP Date 整合。tolerance なし
- 保護列: outside54 全11列・core16 全列・price/data_date・created_at・
  scored_at は byte-exact。touched 行の非書込列も全一致
- NEWPOST LOCAL 再演 (bridge + 実 fetch + compute + snapshot + 52決定):
  reentry 0 (利回り・ABC・desc いずれも再plan 0件)

## post-custody (承認済み1回実行)

- 56点 1-ZIP: exec16 raw16+meta16+receipt16、post4 raw4+LEDGER+RESULT+
  REPORT+ATTEMPT の8点。8PRE の重複なし。secrets スキャン 0
- key `6d3f09dacfda2d512b13327c3a8f210e7a49dfacb7bc886ffea723a9d7b540e1`
- ZIP `03724221f2fa4f3e07c6e644b14fc5d16396e9aaad2b48396ada16622a4f26ba`
  (152,975B)。manifest `fd336d8d9705b13a8aca79aaec8bce505410a3b420111f822ce9e172d9aa6688`
- `recorded`/`written` (force=false, 1 call)。uniqueDB/key/pageID 一致。
  ZIP full bytes + inner56 SHA readback PASS
  (receipt `8675e1d40629d402abde136ae084b03b3daad4e82c9fe4094bd3ba647d3a6841`)

## フォールバックなし宣言

- 各送信・ capture は単一試行。失敗時は STOP し、再送・再試行・新 key なし
- EMIT 時刻は書き込み時まで未知として扱い、捏造・黙殺なし
- バイト一致は source 最新 GET を意味しない (原本は historical)

## 証跡 SHA

- prep6b report `f2819701df42935a77ac6e1fd87e07c39d021f5c9bd0fc085ee0a80ee543e8a3`
- prep6b runner `9a1b3035579bea3bd079c94dcfdf59caf4f0eff78943dd939ce3e280f7c5ac21`
- metadata `6a2a4fcfcac5e493dcd21dec6de122f77270eb485df9af53eccc9284fe191582`
- stage runner `095bfa4dcaa21e4d23cdfd07cf0b57f453b0aa4be0b1e4293a965603c0f6daf7`
- recovery runner `daf47424bd1ad37e749fdb20b4822d6fcd06c620de97aa67dc4cee538d57a985`
- exec16 runner `2fdd0b4cb1fb6d6a3a7b2f5e983185919441c0e922bc2dca69cf55f41264de26`
- exec packet `3e6f211d794cfcfff9a1b110d0a09f9ed3676d8876a81d24ca9e2ad1edab8146`
- post4 runner `eeb43a187239e37ad4993164283b58224304c9986cd3ec037b265805f6bd130c`
- postcap `41723b4aa1f54f950c1db5c58570f13848aaeb0297b09000587cfdc1f34a9e8b`
- post4 report `6c97a3b8dca22de5f855e4bce97c51597b278e61553c5ff1b672b3b530b8a2a9`
- postcustody runner `34872a87fad40a2e20ba9eaaee9b264b8f613d022323a082fd779867fff036c8`
