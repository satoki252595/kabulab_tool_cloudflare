# RAW索引の結果不明状態を変更せず照合する（2026-10-14）

通常の有限run `38571686207`（main `d23ba81c571cc3ba7e19293c9a602bfb51be9e1d`）は13:57:43Zにfailureで終端した。公開summaryは `lastPhase=receipt_inflight`、Errorのmessage SHA `67f723e2cff77e3946a97a33da1a54905fba71f064fd22b34ad073a5c9671a19`、最後に全文確認したraw SHA `111e06a1e83381ace6af46bbf43afe5048fc11721ea3f39b9f7ca71f36cf5853`・17,352B、Notion8・upstream0・再送0である。元errorの本文は保存されておらず、当run版の定型文・制御receiptキー・SDK静的605候補とのSHA照合にも一致しなかった。PUT、読戻し、local receiptのどの境界が失敗したかを断定しない。

保存manifestは31,579,382B、全SHA `fccedf9bb6c1548ff3a0b206634fbdbf531acaac63192275cc31720f1db11362`、78832原本、plan `canonical-20261014`、cutoff `2026-10-13T18:31:00.000Z`。最後のrawは0始まりitem5389の3452/S100TFGW/type5 CSVと一致する。直前の成功cursor5002・残73830から部分進捗はあったが、item5389をcursorとして認定しない。新しい実stateの読取まで現在cursor/完了数は不明のまま残す。

既存dryは通常再開の状態経路を通り、applyはcursor更新、reconcileは人間判断後の単一INSERTを含むため、診断には使わない。既CLIと既workflowへ `mode=inspect` を追加し、Active/Manifest/State/Complete、原本SHA、索引15列の既validatorと受入済みR2のbounded single-attempt readerを再用する。inspectはget/index/emitだけの型を受け取り、通常再開・reconcileへ分岐する前に独立した読取経路へ進む。旧stateのformat、通常dry/apply/reconcile、原本取得・母集団は変更しない。

最大予算は次のとおり。各個別GETも数え、manifestの再GETはない。

| 読取 | 最大request |
| --- | ---: |
| active / manifest / state / complete | 4 R2 GET |
| inflight時だけ当SHAの既resolution intent / complete | 2 R2 GET |
| 末尾state / activeの全bytes・ETag再照合 | 2 R2 GET |
| currentとpreviousの最大2件、各canonical/実legacyキー | 4 R2 GET |
| 対象2SHAの索引15列 | 2 D1 SELECT |
| 合計の明示上限 | 14 HTTP |

条件分岐で不要な読取は行わない。例えばinflightの実キーがあればその対象にlegacy探索はなく、実request数は上限を下回る。制御receiptと原本を含むR2 GET総bytesは最大64MiB、各制御receiptは256KiB（manifestだけ残予算全体）、最大600秒、各request直前に65秒のheadroomを要求する。原本は全文2キー分の予算を先に確保し、切詰め・別原本採用・予算の黙示拡張をしない。全SDK GETは単発、ContentLength/実body/期限を検査し、各native呼出直前にも時刻を確認する。D1応答JSONのbytesはこのR2予算へ混ぜず未計測とし、別に最大2 SELECT・各60秒・一意行/15列の既型検証へ固定する。総HTTP bytes上限を認定したとは扱わない。

現在inflightの原本/索引が欠測なら欠測を報告する。実在してもunknownを解除せず、state/cursorを一切更新しない。旧cursorが完了を主張する直前項目の原本/索引欠測、metadata不一致、全文SHA不一致、読取中のstate/active変化はSTOPする。索引の既取得時計や旧doc_id=NULLは既validatorの契約を維持し、後付け修正しない。完了receiptやresolutionの存在も通常runを再開してよいという判定に変えない。

全文bytes・ETag・metadata・索引行はGHAの0700作業dir/0600 private JSONLへ保存し、公開consoleにはSHA/bytes/ETagのSHA・cursor・inflight・request実数、pageID/docID/主体と検証済みの安全なR2 key構造、索引15列の検証結果/全row SHAを出す。安全な文字集合に入らないkeyや未検証IDはprivateのみと明示し、secret URLや原文は出さない。private raw/manifestをartifactへ公開する経路は追加しない。200body途中失敗は最大16KiB prefixとcomplete=false/receivedBytesを保存しSTOPする。新inspectの例外文とstack/SDK statusはprivateに上限付きで残し、公開logは従来のsafe summaryのみ。以前失われたerror本文や失敗時のPUT payload/ACKを再生成したとは扱わない。native現stateのpersistent inflight有無と各raw/index実在資格を機械分類し、旧receipt送信そのものの成否は別にunknownのまま明記する。

inspectからNotion照会・hosted再DL・EDINET/vendor取得・raw/receipt PUT・D1 INSERT・cursor reset・unknown clearは全0。継続dispatchは既workflowの `mode == 'apply'` と既Python helperのassertの両方で拒否する。実行はmain受入後のroot別reviewを要し、この修正ではnative実行0である。

Nix既存project shellで関連4suite・125test、root TypeScript、対象ESLint、diffcheckが成功した。両inflight・原本欠測・末尾state差・全文SHA差・索引差・transport・途中body・bytes/time/limit/reconcile拒否・非公開key・旧cursor欠測を故障注入し、全てのinspectでPUT/INSERT/list/download/antiJoinは0だった。既continuation helperもinspectを拒否するoffline故障検証を残した。実78832件manifestのstrict decoder再照合は全SHA/normalized bytes同値、ローカル238ms（network時間を含まない）、resourceUsage.maxRSS=471760KiBだった。新依存・native実行・prod書込は0。
