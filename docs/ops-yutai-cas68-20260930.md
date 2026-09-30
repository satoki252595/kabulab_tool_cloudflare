# 優待303候補・68銘柄の実修復 — 2026-09-30

## 実施範囲と結果

- 67銘柄の09:21 UTC読取と1808の09:59 UTC読取を別時点のまま保持し、68銘柄の4表全列（core 11 / benefit 11 / financial 19 / score 7）を銘柄ごとの同一原子バッチで照合した。
- 60銘柄・417 SQL文の実送信は全件known success。unknown・再送は0。続く4 SELECTで68 core / 847 benefits / 68 financials / 68 scoresを取得した。修復前の優待961行から114行を削除した。
- 現在の金額303候補は、削除53・金額/出典NULL化154・原本適格の会社額面化88・既修復golden8保護。削除114には金額NULLだった61行も含む。
- 保存見出し13、3232の2行の正準本文と原本に基づく要約を修正。3232の経済額5000は変更しない。
- 同じpost-imageからfinancial.yutaiYield 44・score 38・yutaiMonths 1を更新。genre集合は変化0。price・data_dateは68銘柄すべて保護。
- 完了済golden52と会社額面8、非対象8銘柄を保護。これらの修復を再実行したものではない。

## 全列照合と再適用

実際のpost全4表を凍結した同じwhole-writerへ戻し、原本actionsと所有者対応から計画を再生成した。

| 検証 | 実結果 |
| --- | --- |
| 優待ID集合 | preからDELETE114を除いた847行と一致 |
| runtime以外の全セル | 11,547 / 11,547一致、差0 |
| 保護timestamp | 1,680 / 1,680がpreと厳密一致 |
| 再生成バッチ / 送信stock / 送信statement | 0 / 0 / 0 |
| 再生成postとactual post | 一致 |

空配列を手で渡した検証ではない。実際に生成した計画を既存applyへ渡し、送信があればthrowするsenderで送信0を確認した。

## runtime時計の判定

元の厳密比較は5957の4セルでSTOPした。benefit 36258–36260のupdated_atとfinancial 938のfetched_atは実値 `1790777275`、client送受信・HTTP Dateの秒は1秒後だった。元のSTOP原本を削除・置換していない。

実SQLは4つとも `unixepoch()` のDB生成式で、timestampのbindはない。対応するUPDATEの実成功・changes・rows_writtenを照合し、変更runtime 286セルの整数epochとDB生成を検証した。原因をclock skewやcached nowと断定せず、client/HTTP区間との一致は4セルで未検証のままとする。許容秒やHTTP Dateへの置換は導入していない。

SQLiteの `now` はVFSのxCurrentTimeを使い、client/HTTP時計との同期を保証しない。[SQLite日付関数](https://www.sqlite.org/lang_datefunc.html)、[D1概要](https://developers.cloudflare.com/d1/)。報告状態は `OFFLINE68-QUALIFIED-DB-GENERATED-WITH-4-INTERVAL-UNVERIFIED`。元の厳密COMPARE PASSとは区別する。

## 残る行生成のHOLD

経済額の候補修復と、優待行そのものの適格性は別の範囲である。15行はDELETE114に含めずHOLD、3行はKEEP。

- 2307の未来移行5行、2001の解析/制度差6行、8508の一回限り1行、3189の消失2行、6577の消失1行は原本から恒常行の処置を確定できない。
- HOLD15のうち11行の金額をNULLで抑止、4行は未変更。KEEP3（38644–38646）は6月条件が成立する本文差。

全68銘柄の行生成を完全修復したという主張ではない。追加の原本取得・処置は未実行。

## 原本と物理保管

既存のsource34とsource42の物理保管を再利用し、原本の再取得・再uploadは行っていない。PRE ZIPは24原本、POST ZIPは実送信60のattempt/raw/meta/known receipt、post4、原pre8、固定計画、元STOP、別qualificationと再適用証明を含む274原本。

| 保管物 | 全体SHA-256 | bytes |
| --- | --- | ---: |
| PRE ZIP | `0c9e4440033977dc0c8dfea9fc0a2ee0bb1e03f218bdc6b3cc96c3bd6862171f` | 5664840 |
| POST ZIP | `1b817512e3b84cb4fa7b620a03688eac86fd54c9ec400f8f8ef8700692e3fd92` | 6704121 |
| POST manifest | `ca10a089bc6eccf9d0f969cf9331a39f2456fb331e8e15ce5229ed26492d51f0` | 42433 |
| POST physical receipt | `2612559643ba113047906d0849aef4d7952996cb463ab355bd4f86929de05b2c` | 329 |

POSTはimmutable key `yutai-cas68-post-20260930-1b817512e3b8`、force:falseの1回記録。実13 API +2 hosted GETは全200・再送0。known return 14:53:49.709 UTCを先に保存し、unique page確認とfull readback完了14:53:52.609 UTC。取得し直したZIPの274ファイルの集合・順序・長さ・SHAをすべて照合した。秘密情報・原本文はGitに含めない。
