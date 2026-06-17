# 辞書ライセンスと帰属表記

## 由来

本ディレクトリの極性辞書 `pn_wago.json` / `pn_noun.json` は、東北大学
乾・岡崎研究室『日本語評価極性辞書』を [ikegami-yukino/oseti](https://github.com/ikegami-yukino/oseti)
リポジトリが JSON 化したものを取得・再利用しています。

- **原典 (Original)**: 日本語評価極性辞書 — 東北大学 乾・岡崎研究室
  <https://www.cl.ecei.tohoku.ac.jp/Open_Resources-Japanese_Sentiment_Polarity_Dictionary.html>
  - 用言編 (`pn_wago.json` 由来): 約 5,000 表現
  - 名詞編 (`pn_noun.json` 由来): 約 8,500 表現
- **JSON 化中間配布**: ikegami-yukino/oseti (MIT License)

## ライセンスと利用条件

東北大学 乾・岡崎研究室の規約に従い、**クレジットを明記すれば商用利用可能**。
本プロジェクト (kabulab) は ir-catalog サービスの PDF 本文センチメント判定
(配当政策の変更・エクイティファイナンス・自己株式の処分など定性判断が必要な
タグ) でこの辞書を使用する。

## 引用 (Required Citation)

### 用言編 (`pn_wago.json`)

小林のぞみ, 乾健太郎, 松本裕治, 立石健二, 福島俊一. **「意見抽出のための
評価表現の収集」**. 自然言語処理, Vol.12, No.3, pp.203-222, 2005.

### 名詞編 (`pn_noun.json`)

東山昌彦, 乾健太郎, 松本裕治. **「述語の選択選好性に着目した名詞評価極性の
獲得」**. 言語処理学会第15回年次大会論文集, pp.584-587, 2009.

## UI 上の表示

[services/ir-catalog/src/views/stock-detail.ts](../../../views/stock-detail.ts)
の `.disclaimer` 内に、エンドユーザに対する出典明記を含める。

## 修正禁止

辞書ファイルの内容 (キー・値) は**改変しない**。誤判定や追加判定が必要な
場合は、本ディレクトリ外 (例: `dispatch.ts` 内のオーバーライドマップ) で
対処すること。

---

## 中間配布元 MIT License 全文 (ikegami-yukino/oseti)

```
MIT License

Copyright (c) 2017 Yukino Ikegami

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
