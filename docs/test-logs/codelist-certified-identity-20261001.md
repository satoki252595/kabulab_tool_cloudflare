# EDINET ticker欠損の認定identity経路

実装base: `8f95f788`。新規source GET／Notion／D1／dispatch実行0。本番627A適用は別作業で未実施。622AのFSA上場・業種不一致、646Aの直接識別証拠不足は未解消。

## 正常経路

既存IPO ledgerの任意 `identityBinding` が共通形式。627Aは公式noticeのE38412と同host stock頁の627Aを直接認定し、原本全SHA・取得時計・既存物理archive key/ZIP SHAを記録。原本は過去のbinding事実であり、将来の業種や上場状態の保証ではない。

初期認定FSA基準日より古いCSVへ遡及せず、現在FSA一意EDINET・法人番号・上場区分、core同ID/ticker・active equity、owner singleton eligibility>=FSA sourceAsOf、最新listing episode一致を毎回検査する。効力済みdelist-after-anchorはactiveでも拒否し、将来delistは早期除外しない。market transferは発行体bindingを失効させない。業種は毎回現在FSA原文から読む。原文literal証券コードが戻ればliteral優先、認定との矛盾はSTOP。

両jobは同じ共有resolverを使用。raw ticker空欄は改変せずsector scannerに認定由来を明示する。既存current READを前倒しして共用し、master D1 optionalと--limit読み取り省略を維持。D1未設定・current未取得はblank認定HOLD。認定行のsector33-only UPDATEには同identity/owner/episode述語とRETURNINGの実結果確認を付け、競合を成功計数しない。他列・updated_atは変更しない。

master全件Notion map取得失敗は書込前STOPに変更し、不明な母集団でper-record createへ切り替えない。

## 実原本と回帰

FSA取得済みZIP `f7f1d42f8f5732265cc241a9689f6e35f483593327f6250ec3aa30ec8bb53816`（9/30基準）の3issuer行投影、既存owner POSTのcore18160/listing193（9/18）投影を使用。原本取得・物理保管は既存source5証跡を再利用。原本CSVは既存非公開fixture方針を維持し、未配置CIでは明示skip。

Nix `uv run pytest`: **1529 passed / 58 skipped**（取得済み原本ありのローカル実行）。新回帰15件は過去CSVへの遡及拒否、両caller一致、原文欠損保持、次日CSVと現在業種、literal復帰、競合・重複・法人番号変更、coreID/active/owner/listing変更HOLD、UPDATE時競合、将来／効力済みdelistを実際のSQLite SQLで確認。全件map失敗で原本保全・構造化書込0も確認。変更対象ruff PASS。

初期coreID/episodeは保存済みPOST時点の証明であり現在DBの再観測とは扱わない。実適用前はRootの別資格確認・実行条件が必要。

認定subsetの来歴は共通関数で作成。sector世代manifestにledger SHA・raw空欄/resolvedコード・証拠参照・現在owner検査値を保存する。masterは認定行がある場合のみ派生来歴を既存save_raw/upload_rawで物理保管し、認定行のprovenance.raw_page_idで結ぶ。派生manifestは元FSA rawPageId/SHA・CSV sourceAsOf・実sourceFetchedAt・過去binding取得時計を別々に記録。原本SHA重複スキップで来歴が未添付になる方式は採らない。保管失敗時の認定行書込0を実経路で検証。新model/schemaなし。

認定subsetのNotion同値skipは意味値だけでは許可せず、既存原本relationが同じ認定manifestに完全一致した時だけ許可する。旧FSArelationの場合にPATCHされる実caller回帰を確認し、native同値skipは変更しない。

共通Notion _upsert（master/財務サマリ/開示）も、確定既存IDのUPDATE object_not_foundをcreateへ切り替えず例外伝播する。権限喪失と削除を区別できないため。確定不存在None→createと通常update/キー検索の正常回帰は維持。
