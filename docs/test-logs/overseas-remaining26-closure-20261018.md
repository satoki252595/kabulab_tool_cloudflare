# 海外売上の残26文書を通常ツールで閉鎖

2026-10-18。保存済み有価証券報告書を使い、固定集合の残26文書・151件の数値を20文書＋6文書に分けて反映し、独立した読み戻しまで受け入れた。既受入140文書・842件と合わせ、**固定166文書・993件、残0**になった。

これは指定した原本集合の完了であり、全市場の海外売上や全20項目の完了ではない。追加の原本取得API・モデル利用は0。対象集合と通常ツールの契約は[保存原本CLIの記録](overseas-saved-cohort-20261017.md)を参照する。

## 原本・更新・読み戻し

- 受入済みソース `85261e3d465a49ff4447450a9e9b722ac3e6b27c` の通常 `backfill-overseas.ts` を使用した。`prepare` で現在の原本・本文・関連6表を読み、`apply` で反映し、別の `inspect` で全値を再確認した。
- 保存ZIPの全文SHA、提出者・文書・期末、現在の原本ページと本文を資格化した。更新前後の全6表と対象外の値を照合し、共通アーカイブで保存したPRE/POSTの物理ファイルも全bytesで検証した。旧manifestが不明の原本は、不明のまま保持した。
- 同じ原本を重ねて適用しないための不変claimsは166件すべて保持した。別出力先による再送やclaims削除は行っていない。
- 旧期限・STOP・元の監査失敗は消していない。先頭20件の通常APPLY完了後に生じた保存監査の時計順序の誤判定は、別版の保存監査で判定し直した。正常writerの再実行・業務リクエストの再送は0。

## 原期限と累積消費

今回26件の操作は **10/18 07:33:19.609〜10:33:19.609 JST** の原3時間枠を維持し、最終閉鎖は09:13:06.013 JSTだった。各phaseの収集と保存監査・プロセス閉鎖を同じ枠内に予約し、途中で期限や費用カウンタをリセットしていない。

通常native台帳は旧消費5,929 HTTPを引き継ぎ、今回1,317 HTTPを加えて累積7,246 HTTPになった。

| 累積項目 | 実消費 |
|---|---:|
| Notion / hosted読取 | 4,540 / 179 |
| D1 SELECT / atomic batch | 2,382 / 145 |
| 要求 / 保存応答bytes | 38,248,692 / 642,374,773 |
| D1 rows_read | 1,369,237 |

入場時のGitHub Actions RAW79は別の予約として確認した。workflow head `364f0d6f04c3a2c0b08655f19eb40fdec29a9fe8` と実行予定revision `85261e3d465a49ff4447450a9e9b722ac3e6b27c` を区別し、原pool200内の79＋残121、Notion API 0.25 rpsを維持した。この入場資格は、RAW79自身の実checkoutや全量原本監査の受入を意味しない。

## 保存された閉鎖証拠

以下はprivateの `tmp/feature-audit-20261018/overseas-remaining26-normal-recovery-v1/` 配下。署名URL・原本文・秘密値はGitへ保存していない。

| 証拠 | 全文SHA-256 |
|---|---|
| 先頭20件の独立inspect閉鎖 `root-inspect20-final-acceptance-v1.json` | `4ccf8a243079133694065a10b65bf7ad584d684ab47c09c1a6de03f4673af077` |
| 残6件のfullPOST保存監査 `stage-02/apply-v1/root-independent-writer-post-acceptance-v1.json` | `4fef9aa7bc5d4f9af3ad52a03599f790bf051e724b8fa4cd9ee120acf056fba4` |
| 残6件の独立inspect保存監査 `stage-02/inspect-v1/root-independent-normal-inspect-acceptance-v1.json` | `d4bf865f0ffbab1d83bfdbd902b28628dd691eda6a5f38e399fb06eace135361` |
| 最終root閉鎖 `root-inspect6-final-acceptance-v1.json` | `46b04cd87e82b04bb57cdd1efd2e5531381ee8fc2eac696c4dd50df42b0f4af4` |

最終receiptは通常INSPECT・保存監査ともexit 0、全所有プロセス閉鎖・kernelFree、次stage未releaseを記録する。別のFS照合でも保存証拠2,001 filesの全SHA、原費用からの累積、166 claimsの原本対応と全文SHAが一致した。追加HTTP・独立監査の再実行・書込みは0。全市場受入・全20項目完了は引き続きfalse。
