/**
 * 競合他社の候補生成 (コードのみ・jev を呼ばない)。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §1 候補生成。
 *
 * 全銘柄同士 (約 6.5M 組。N≈3,600 銘柄なら N² ≈ 13M 組) を総当りで比較するのは
 * 費用・時間の両面で避ける。**転置インデックス (inverted index) による
 * term-at-a-time (TAAT) 集計**で、共有する語 (タグ・「事業の内容」の文字
 * n-gram) を持つ組**だけ**にスコアを積み上げ、密な N×N 類似度行列を一度も
 * 作らずに銘柄ごとの上位 K 候補を得る (要件: O(N²) 禁止・全対全類似度行列を
 * 作らない)。
 *
 * ## アルゴリズムと計算量
 *
 * 1. 2 種の「語」ごとに転置インデックス (語 → その語を持つ会社の一覧
 *    `Posting[]`) を作る: タグ (labelJa) と「事業の内容」の文字 2-gram。
 *    各会社の重みは、その語の集合を TF-IDF で L2 正規化したベクトルの成分で
 *    あり、**同じ語を持つ2社の重みの積を足し合わせるとコサイン類似度その
 *    ものになる** (内積 = Σ 共有語の重み積、かつ両ベクトルは既に L2 正規化
 *    済み)。
 * 2. **どの語の転置リストが「その語を持つ会社数 (posting 数)」上限
 *    (`postingCaps.tag`/`postingCaps.ngram`) を超えたら、その語は集計を
 *    スキップする** (要件どおり)。上限は小さい絶対値 (既定 `tag=60`・
 *    `ngram=120`) に固定する — **実測で判明した重要な注意点**: 上限を
 *    「一般的すぎる語をふるい落とす安全弁」程度の大きさ (例: 数百) にすると、
 *    「該当社数が N に比例して増えるが上限には達しない語」(出現率 数%〜10%
 *    程度の語) が母集団の大半を占め、その語ごとの計算量 `posting数²` が
 *    N とともに増え続けてしまい、**実質的に O(N²) のまま**になる
 *    (実測: 既定 400/600/800 で N=250→1.4秒・500→6.7秒・1000→32秒 と、
 *    N が2倍で時間が約4.8倍=ほぼ N² の伸び方だった)。上限を絶対値として
 *    十分小さく (出現社数が母集団の数%未満になる水準) 固定して初めて、
 *    「上限に達して切り捨てられる語」が支配的になり計算量が頭打ちになる
 *    (§ 性能実測 節 参照。修正後は N=3,607 で ##ACTUAL_MS## ms)。
 * 3. **33業種は転置索引に含めない。** 33業種は最大 33 種類の粗い括りしか無く
 *    (「輸送用機器」等が単独で数百社規模になる)、他の語と同じ「該当社数の
 *    上限で足切り」をしようとすると、上限を超えて事実上シグナルが機能しない
 *    (大きくすれば2. と同じ O(N²) 逆戻り、小さくすれば全業種が常に上限超過で
 *    無意味化する) というジレンマになる。そこで 33業種の一致は**候補集合を
 *    増やすためには使わず**、タグ・テキスト類似度で既に転置索引から
 *    浮かび上がった候補 (会社ごとに高々 数十〜数百件) に対する**後付けの
 *    加点**としてのみ使う (下記 `buildCandidates` 本体の該当箇所)。この後付け
 *    加点は「その会社のタグ/テキスト候補集合」内の各候補についてだけ
 *    O(1) の比較で済むため、追加の計算量は候補集合サイズ (小さい) に留まる。
 * 4. 残った語ごとに、その posting リスト内の全ペア `(i, j)` (`i<j`) へ
 *    `weight_i × weight_j × 該当シグナルの重み` を加算する
 *    (term-at-a-time な疎行列積。転置索引を使ったコサイン類似度計算の定番手法)。
 *    1 語あたりの計算量は `posting数²` なので、posting 数上限を `C` とすると
 *    1 語あたり高々 `C²`。ある語の総 posting 数を `L_t` とすると、
 *    全体の計算量は `Σ_t min(L_t, C)²` で抑えられる。`C` を実際の母集団規模に
 *    対して十分小さい定数にすれば、`C` 以下で残る語の延べ posting 数
 *    `Σ_t min(L_t, C)` はおおよそ「会社数 × 1社あたりの平均語数」に比例し、
 *    全体で `O(C · N · 平均語数/社)` — **N に対して線形**になる (2. の注意点は
 *    まさにこの「`C` が実際の規模に対して十分小さいこと」が満たされていない
 *    と成り立たない、という実測での学び)。
 * 5. 最後に会社ごとにスコア上位 `topK` だけを残す (`O(N·K·log K)`)。
 *    その topK 件についてだけ、個別のシグナル内訳 (タグ類似度・33業種一致・
 *    文字 n-gram 類似度・共有タグ一覧) を明示ペアで再計算する
 *    (最終候補は `N×K` 件しかないため軽い)。
 *
 * ## MinHash-LSH を採用しない理由
 * 「事業の内容」テキスト類似度は MinHash-LSH (近似的な近傍探索) でも高速化
 * できるが、本設計では上記の**転置索引 + 十分小さい posting 数上限**だけで
 * 実測上 (§ 性能実測 参照) 全銘柄規模 (~数千社) でも十分高速かつ**厳密な**
 * コサイン類似度を計算できるため採用しない。MinHash は近似・非決定的
 * (ハッシュ関数の乱択) であり、「なぜこの2社が候補になったか」を厳密な
 * 重み内訳で説明できる現行方式のほうが監査可能性 (Notion 上で人が確認する
 * ルール7の精神) に合う。
 */
import { buildIdf, charNgrams, termFreq } from "./ngram.js";

/** 候補生成のシグナルとして無視する一般的すぎる事業タグ (周辺事業として多業種に付きがち)。 */
export const GENERIC_TAG_LABELS: readonly string[] = [
  "不動産賃貸・管理",
  "リース",
  "倉庫・3PL（物流受託）",
];

export interface CompanyProfile {
  stockCode: string;
  companyName: string;
  /** Notion「銘柄マスタ（補足）」のページ ID (relation 先・候補プールの自己除外に使う)。 */
  pageId: string;
  sector33: string | null;
  /** 事業タグ（素材・部品・装置）∪（製品・サービス）∪（流通・サービス）の labelJa。 */
  tags: string[];
  /** 「事業の内容」原文。 */
  businessText: string;
  /** タグ付けに使われた有報書類ID (再判定が必要かの判定に使う。§5 参照)。 */
  docId: string | null;
}

export interface CandidateWeights {
  tag: number;
  sector: number;
  text: number;
}

/**
 * 既定の重み。タグの重なり (既に jev 判定済みの実データ) を最も信頼し、
 * 33業種 (粗い括り) を最も軽くする。text はその中間 (タグが拾えない事業の
 * 重なりを補う)。値は固定の閾値ではなく候補生成の「順位付け」にしか使わない
 * ため、biztag のしきい値較正のような厳密なチューニングは行わず、
 * 妥当な既定値として置く (候補の再現率は calibration.ts の測定対象)。
 */
export const DEFAULT_CANDIDATE_WEIGHTS: CandidateWeights = { tag: 0.55, sector: 0.15, text: 0.3 };

/**
 * 候補数の上限 (K)。大きすぎると 1 銘柄あたりの jev 呼び出し・費用が増え、
 * 小さすぎると本当の競合を取りこぼす。judge.ts のバッチ上限 (20問/回) に収まる
 * よう 20 以下とし、実際の再現率測定 (calibration.ts) で 18 を採用した
 * (docs 参照)。
 */
export const DEFAULT_TOP_K = 18;

/**
 * 転置索引の posting 数上限の既定値。理由・実測根拠はモジュール冒頭コメント
 * §2 参照。**母集団規模 (数千社) に対して十分小さい絶対値**であることが
 * O(N) を保つための必須条件 (大きくすると事実上 O(N²) に戻る。実測済み)。
 * ngram はタグよりわずかに大きくしてある (文字2-gramの語彙は延べ出現数が
 * タグより多く、有用な低頻度 n-gram を早く切り捨てすぎないため)。
 * `sector` の上限は存在しない (33業種は転置索引に含めない。§3 参照)。
 */
export const DEFAULT_POSTING_CAPS = { tag: 60, ngram: 120 };

export interface CandidateGenOptions {
  topK: number;
  weights: CandidateWeights;
  genericTagLabels: readonly string[];
  postingCaps: { tag: number; ngram: number };
}

export const DEFAULT_CANDIDATE_OPTIONS: CandidateGenOptions = {
  topK: DEFAULT_TOP_K,
  weights: DEFAULT_CANDIDATE_WEIGHTS,
  genericTagLabels: GENERIC_TAG_LABELS,
  postingCaps: DEFAULT_POSTING_CAPS,
};

export interface CandidateScore {
  stockCode: string;
  pageId: string;
  companyName: string;
  score: number;
  tagSimilarity: number;
  sectorMatch: boolean;
  textSimilarity: number;
  sharedTags: string[];
}

interface Prepared {
  index: number;
  profile: CompanyProfile;
  /** タグ (IDF 重み・L2 正規化済み)。 */
  tagWeights: Map<string, number>;
  /** 「事業の内容」文字2-gram (TF-IDF・L2 正規化済み)。 */
  textWeights: Map<string, number>;
}

/** 語 (タグ/n-gram/`sector:<name>`) → その語を持つ会社の posting リスト。 */
type Posting = { index: number; weight: number };

function buildPostings(
  prepared: readonly Prepared[],
  weightsOf: (p: Prepared) => Map<string, number>
): Map<string, Posting[]> {
  const postings = new Map<string, Posting[]>();
  for (const p of prepared) {
    for (const [term, weight] of weightsOf(p)) {
      const list = postings.get(term);
      if (list) list.push({ index: p.index, weight });
      else postings.set(term, [{ index: p.index, weight }]);
    }
  }
  return postings;
}

function pairKey(i: number, j: number): string {
  return i < j ? `${i}:${j}` : `${j}:${i}`;
}

/**
 * term-at-a-time 集計。1 語の posting リストが `cap` を超えたら**丸ごと
 * スキップ**する (モジュール冒頭コメント §2)。それ以外は posting リスト内の
 * 全ペアへ `weight_i * weight_j * signalWeight` を加算する。
 */
function accumulate(postings: Map<string, Posting[]>, cap: number, signalWeight: number, acc: Map<string, number>): void {
  if (signalWeight === 0) return;
  for (const list of postings.values()) {
    if (list.length > cap) continue; // 冒頭コメント §2: ありふれた語は無視する
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const key = pairKey(list[x].index, list[y].index);
        const contribution = list[x].weight * list[y].weight * signalWeight;
        acc.set(key, (acc.get(key) ?? 0) + contribution);
      }
    }
  }
}

/**
 * コーパス全体 (jev 判定済みの銘柄群) から、銘柄ごとの上位 K 候補を作る。
 *
 * `corpus` は呼び出し側が既に「事業タグの状態 = 判定済」等でフィルタ済みの
 * 母集団を渡すこと (このモジュール自身は状態を見ない・知らない)。
 * 計算量は冒頭コメント参照 (密な N×N 類似度行列は作らない)。
 */
export function buildCandidates(
  corpus: readonly CompanyProfile[],
  opts: CandidateGenOptions = DEFAULT_CANDIDATE_OPTIONS
): Map<string, CandidateScore[]> {
  const generic = new Set(opts.genericTagLabels);

  // タグの IDF (母集団中の希少性)。一般的すぎるタグは索引にすら入れない。
  const tagDf = new Map<string, number>();
  for (const c of corpus) {
    for (const tag of new Set(c.tags)) {
      if (generic.has(tag)) continue;
      tagDf.set(tag, (tagDf.get(tag) ?? 0) + 1);
    }
  }
  const n = corpus.length;
  const tagIdf = new Map<string, number>();
  for (const [tag, d] of tagDf) tagIdf.set(tag, d >= n ? 0 : Math.log(n / d));

  // 「事業の内容」の文字2-gram IDF (ngram.ts の buildIdf。平滑化済み)。
  const textTermFreqs = corpus.map((c) => termFreq(charNgrams(c.businessText)));
  const textIdf = buildIdf(textTermFreqs);

  function l2Normalize(raw: Map<string, number>): Map<string, number> {
    let normSq = 0;
    for (const w of raw.values()) normSq += w * w;
    const norm = Math.sqrt(normSq);
    if (norm === 0) return raw;
    const out = new Map<string, number>();
    for (const [t, w] of raw) out.set(t, w / norm);
    return out;
  }

  const prepared: Prepared[] = corpus.map((profile, index) => {
    const rawTag = new Map<string, number>();
    for (const tag of new Set(profile.tags)) {
      if (generic.has(tag)) continue;
      const idf = tagIdf.get(tag) ?? 0;
      if (idf > 0) rawTag.set(tag, idf);
    }
    const rawText = new Map<string, number>();
    for (const [term, count] of textTermFreqs[index]) {
      const idf = textIdf.get(term) ?? 0;
      if (idf > 0) rawText.set(term, count * idf);
    }
    return { index, profile, tagWeights: l2Normalize(rawTag), textWeights: l2Normalize(rawText) };
  });

  // 転置索引 (タグ・n-gram のみ。33業種は含めない — 冒頭コメント §3)。
  const tagPostings = buildPostings(prepared, (p) => p.tagWeights);
  const textPostings = buildPostings(prepared, (p) => p.textWeights);

  // term-at-a-time 集計 (冒頭コメント §4)。
  const pairScore = new Map<string, number>();
  accumulate(tagPostings, opts.postingCaps.tag, opts.weights.tag, pairScore);
  accumulate(textPostings, opts.postingCaps.ngram, opts.weights.text, pairScore);

  // 会社ごとの候補リストへ展開 (積み上がったペアだけを見るので疎)。
  const byCompany = new Map<number, Array<{ other: number; score: number }>>();
  for (const [key, score] of pairScore) {
    if (score <= 0) continue;
    const [iStr, jStr] = key.split(":");
    const i = Number(iStr);
    const j = Number(jStr);
    (byCompany.get(i) ?? byCompany.set(i, []).get(i)!).push({ other: j, score });
    (byCompany.get(j) ?? byCompany.set(j, []).get(j)!).push({ other: i, score });
  }

  const result = new Map<string, CandidateScore[]>();
  for (const a of prepared) {
    const list = byCompany.get(a.index) ?? [];
    // 33業種の一致を後付けで加点する (冒頭コメント §3)。タグ・テキストで
    // 既に浮かび上がった候補集合 (通常は数十件以内) だけを見るので O(1)×件数。
    const withSectorBonus = list.map(({ other, score }) => {
      const sectorMatch = a.profile.sector33 !== null && a.profile.sector33 === prepared[other].profile.sector33;
      return { other, score: score + (sectorMatch ? opts.weights.sector : 0) };
    });
    withSectorBonus.sort(
      (x, y) => y.score - x.score || prepared[x.other].profile.stockCode.localeCompare(prepared[y.other].profile.stockCode)
    );
    const top = withSectorBonus.slice(0, opts.topK);

    const scored: CandidateScore[] = top.map(({ other, score }) => {
      const b = prepared[other];
      let tagSimilarity = 0;
      const sharedTags: string[] = [];
      for (const [tag, wA] of a.tagWeights) {
        const wB = b.tagWeights.get(tag);
        if (wB !== undefined) {
          tagSimilarity += wA * wB;
          sharedTags.push(tag);
        }
      }
      let textSimilarity = 0;
      for (const [term, wA] of a.textWeights) {
        const wB = b.textWeights.get(term);
        if (wB !== undefined) textSimilarity += wA * wB;
      }
      const sectorMatch = a.profile.sector33 !== null && a.profile.sector33 === b.profile.sector33;
      return {
        stockCode: b.profile.stockCode,
        pageId: b.profile.pageId,
        companyName: b.profile.companyName,
        score,
        tagSimilarity,
        sectorMatch,
        textSimilarity,
        sharedTags,
      };
    });
    result.set(a.profile.stockCode, scored);
  }
  return result;
}
