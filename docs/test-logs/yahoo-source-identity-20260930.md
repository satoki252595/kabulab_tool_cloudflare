# Yahoo source identity proof (saved-54, GET0)

`meta.symbol` required + requested-normalized exact match の導入根拠。
historical saved-54 proof であり、current normal 3695 の identity 主張ではない。

## Source (private, raw Git 複写なし)

- dir: `/tmp/elig-p197-r2-20260930/grant-B/` (0700/0600)
- manifest: `hosted-04-s200.bin` SHA `f509f5dbc2e1838d9073067b9b7059de8cee760ac4878f1da3df63f8e1af894d`
- mapping: manifest.codes[i] ↔ saved[i+1] (arrival order)。byteLength + full SHA 照合。
- check script: `/tmp/identity-54-check.mts` (private, GET0)

## Results (counts only, no values)

- files 55 (manifest 1 + chart 54), entries 54
- SHA match 54/54, miss 0
- meta.symbol === requested code + ".T": 54/54, mismatch 0
- 新 parse (identity 検証あり) 通過: 54/54, bad 0

## Fixture pins (repo 内、実データ)

- `src/cron/__fixtures__/macro-canonical/`: ^GSPC/^N225/NIY=F は要求≡応答を確認。
- unit fixtures: `meta.symbol` を要求 code に明示 (0000.T 固定の穴を除去)。
