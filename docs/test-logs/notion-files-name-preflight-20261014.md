# Notionの添付名を保存前に検査する（2026-10-14）

保存8303の準備v5は、添付名118文字でFile Upload作成200・send uploaded200の後、ページ作成が`Files.files[0].name.length`の100文字上限でvalidation_error400となった。全23応答、元ローカル添付33,767Bの全SHA、upload IDと期限、原STOPをprivateで保全した。D1業務送信と結果不明は0で、ページへの原本保管や添付全読戻しは成立していない。元uploadやページ作成は再送しない。

共通`toNotionUpload`に元添付名の100文字検査を加える。`recordPrimaryData`は全ファイルの正規化を最初のawait前に行うため、長名が一つでもあればDB検索や物理uploadより前に停止する。`uploadFile`も同じ検査をworkspace照会前に呼び、通常定期処理・保存原本backfill・直接uploadに適用する。名前や原文の切詰め、別名の推測、既存保管物の変更は行わない。

TSの通常callerは次の経路へ合流する。

| 経路 | 添付する名前 | 検査 |
| --- | --- | --- |
| `archive.recordPrimaryData` | 元`PrimaryFile.filename` | 全入力をDB照会前に検査 |
| `archive.moveToTrash` | 元Filesの`name` | upload前に検査、元rowを保持 |
| `dataset.upsertDisclosuresByStock` | 元PDFの`filename` | upload前に検査 |
| `file-upload.uploadFile` | callerの元`filename` | workspace/API通信前に検査 |

File Upload側のfilenameとFilesプロパティのnameは別の契約である。既存archiveは元名をFilesに使い、非対応のテキスト拡張子にはupload名だけ`.txt`を付ける。このため元98文字の`.jsonl`がupload時102文字になる合法な既存経路は維持する。100文字制約をupload名へ広げない。Pythonの通常原本経路は別実装なので、そちらの最終Files名の検査は別PRで扱う。

今回のnative境界証拠はASCII名118文字についてのもの。TSでは既存文字列のUTF-16 code unit長を用いる保守的な上限とし、Notionの非BMP文字の数え方を実証したとは扱わない。Unicodeや原名の正規化は追加していない。

回帰は元名100文字の保持、101文字の全HTTP前拒否、98文字からupload102文字の保持、実118文字名の`recordPrimaryData`検索・upload・ページ作成0を確認する。既存のsingle/multi-part確定、manifest、TDnet添付処理も同じsuiteで検証する。本番通信・業務書込・取得・追加依存は0。8303v6の短い明示名を使う単発回復は別の固定runtimeであり、この共通修正のデプロイとは区別する。

隔離worktreeのNix環境で既存2suite・78test、root TypeScript、対象ESLint、diffcheckが成功した。回帰の必須metadataを明示した後、該当1testも再確認した。旧失敗logと最終結果はprivateに保持する。追加依存・本番通信は0。
