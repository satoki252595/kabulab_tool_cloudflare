# 保有明細の結果不明PATCHを読取だけで観測する

通常backfillの通信失敗後はローカルpendingと本番sourceの未確定状態を保持する。既存の単通CLI、backfill、定期resumeはいずれも自動再送を拒否する。通常CLIに`inspect-pending-patch`を追加し、最後のjournal送信意図に束縛した1 GETの観測だけを別receiptへ保存する。

```sh
nix develop --offline -c env -u NODE_PATH node --env-file=.env --import tsx \
  scripts/notion/shareholdings.ts inspect-pending-patch \
  <pending.json> <native-intent.json> <request.body> <before.json> <schema.json> <new-output.json>
```

最後の未応答attempt・URL SHA・body SHA・送信時刻を照合し、旧PRE、schema、pending、全journalのSHAを前後で確認する。共有publisherの全PRE比較と移行POST比較を再利用する。表示値だけでなく旧列、property ID、式、その他全propsも照合する。Filesがある場合の署名表現は既存の安定比較に従う。

| 観測 | 意味 |
|---|---|
| `observed_pre` | 読取時に旧PREと一致。遅延適用の可能性を否定しない。 |
| `observed_intended` | 読取時に意図全propsと旧値保全を確認。通全体の完了の証明ではない。 |
| `unknown` | 両方を確定できない。旧未確定状態を保持する。 |

全状態で`replayAuthorized=false`。PATCH、pendingの削除、旧journalの追記・編集、source cursorや完了markerの変更は行わない。通信不明もsingleAttemptの1 GETから再送しない。実運用では固定入力・期限・native/bytes上限の外側guardと承認されたNotion枠を使う。

保存実1911/S100Y1XPの全EDINET ZIP（45明細）と、既知31行目の実PRE/request/POST、未知32行目の実PRE/request、143attemptの全journalをfixtureにした。ZIP・native request/journalは元bytesのまま。ページfixtureは全business propsを保持し、除いたtransport keysをprovenanceに列挙した。署名URL、認証headers、ローカル私有パスは含めていない。私有の元fullnativeは不変で保持する。

Nixで関連4suite123件、全体型チェック、変更ファイルのlintを確認。実原本から通常producerの株数・単位・期末・意図全値を再計算し、PRE一致、意図全props一致、旧数値/表示selectの1値変造、network不明、journal/body不一致を検証した。新source取得・本番GET・業務書込は0。この検証は1911の実更新成否、先行5社55行のfresh全POST、全45明細の完了を受け入れたものではない。
