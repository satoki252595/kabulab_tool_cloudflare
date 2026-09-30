# VWAP R2 の取得版を条件にした保存

## 根因と変更

通常の日足・5分足・信用データの全 writer は `r2Get` で取得した本文を使う一方、ETag を捨てて無条件 PUT していた。修復用 CLI の If-Match だけでは通常実行の競合を防げない。

全 writer が `r2GetVersion` の本文と不透明 ETag を同時に保持し、更新はその ETag の If-Match、新規は明示 NoSuchKey の場合だけ If-None-Match:* にする。共有 `r2Put` の版引数は必須。欠落・空・wildcard は送信前に拒否する。412 と結果不明は既存の停止経路に入り、再送しない。読み取り専用 caller は変更しない。

LOCAL_OUT はローカル出力のプレビューであり、R2 の CAS 成功証拠にはしない。SDK maxAttempts:1 と正当な missing-object 判定は維持した。

## 検証

- Nix 内の既存 r2/daily/intra/margin 4 suites: 62 passed。
- Nix `tsc --noEmit`: exit 0。
- Nix full suite: 251 files / 4107 passed / 389 skipped。Nix lint: exit 0。
- 新規作成競合の If-None-Match と更新競合の不透明 ETag が送られること、412 が1送信で停止し次の銘柄を取得しないこと、invalid version が SDK 送信0で拒否されることを検証した。
- 既存全10年置換・保管順序・同値再入 PUT0 のテストを維持した。

## 現物の READ

2026-09-30 の既存許可により対象3件を各1回だけ R2 から取得した。本文・実ETag・取得時計を私有原本に保存してから判定し、3件とも以前保存した本文の全SHA/byte長と一致した。歴史的な不正調整終値の発生原因は未確定。原文や資格情報は Git に保存していない。

本変更の検証で本番 PUT、Yahoo 再取得、workflow dispatch は行っていない。現物修復は全 preimage の物理保管と別の具体 CAS packet 許可後に行う。
