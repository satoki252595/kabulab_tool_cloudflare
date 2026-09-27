/**
 * BIS (国際決済銀行 / Bank for International Settlements)
 * Locational Banking Statistics (所在地ベース国際銀行統計) — 国別残高・四半期。
 *
 * 資金フロー計画 (docs/moneyflow.md 予定 / 承認済み計画 notion-velvet-goose.md)
 * Phase 5「世界の概況」担当分。R4 (日本⇔海外・世界の概況) の「銀行チャネル」の
 * 残高近似として使う。フローそのものではなく、ある四半期末時点の残高
 * (holdings_stock) である点に必ず留意すること。
 *
 * データフロー: BIS:WS_LBS_D_PUB(1.0) (Locational banking)。
 * 2026-09-27 に stats.bis.org の SDMX v2 API を実機で確認して確定した仕様:
 *
 *   GET https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LBS_D_PUB/1.0/{key}
 *       ?format=csv&lastNObservations=N
 *
 *   key は 12 次元をドット区切りで並べる (DSD BIS_LBS_DISS の定義順。
 *   `stats.bis.org/api/v2/structure/datastructure/BIS/BIS_LBS_DISS/+` で確認):
 *     FREQ.L_MEASURE.L_POSITION.L_INSTR.L_DENOM.L_CURR_TYPE.L_PARENT_CTY.
 *     L_REP_BANK_TYPE.L_REP_CTY.L_CP_SECTOR.L_CP_COUNTRY.L_POS_TYPE
 *
 * 固定する次元 (実データで存在を確認済みの組み合わせ):
 *   - FREQ=Q           (四半期)
 *   - L_MEASURE=S      (Amounts outstanding / 残高)
 *   - L_INSTR=A        (全商品)
 *   - L_DENOM=TO1      (全通貨合算)
 *   - L_CURR_TYPE=A    (全通貨タイプ合算)
 *   - L_PARENT_CTY=5J  (報告銀行の親会社国籍を問わない集計値。実際に公表
 *     されている系列はこの値のみで、JP 単独 (日系銀行のみ) は集計行にしか
 *     出てこない — 個別相手国別の内訳は 5J でしか取れないことを実機確認済み)
 *   - L_REP_BANK_TYPE=A (全報告銀行タイプ)
 *   - L_REP_CTY=JP     (日本に所在する報告銀行 = 「所在地ベース」の主体)
 *   - L_CP_SECTOR=A    (相手方は全部門合算)
 *   - L_CP_COUNTRY=(ワイルドカード) (相手国・地域ごとの内訳を得るための軸)
 *   - L_POS_TYPE=N     (Cross-border のみ。Local (R) は相手国が居住国と
 *     一致するため国別内訳を取る意味がない)
 *
 * L_POSITION は claims=C (Total claims) / liabilities=L (Total liabilities)
 * の 2 系列を別々にリクエストする (1 回の実行で計 2 リクエストに限定)。
 */

const AGENCY = "BIS";
const DATAFLOW_ID = "WS_LBS_D_PUB";
const DATAFLOW_VERSION = "1.0";
const API_BASE = "https://stats.bis.org/api/v2/data/dataflow";

/**
 * BIS Data Portal は公開 API であり、2026-09-27 の実機確認で UA 無しの
 * 素の HTTP クライアントでも 200 が返ることを確認済み (JPX のような
 * UA ベースの bot 対策は無い)。一方 `https://data.bis.org/help/legal` の
 * 「BIS data for developers」条項は
 * "The BIS reserves the right to limit or suspend any User's IP address
 * access to the APIs at any time" と明記しており、ブラウザを偽装するより
 * 自動化クライアントであることを正直に名乗るのが誠実な API 利用と判断し、
 * kabulab を名乗る識別可能な User-Agent を送る (JPX 系ソースのブラウザ UA
 * 偽装とは方針を分ける)。
 */
const USER_AGENT = "kabulab-cf-moneyflow/1.0 (+https://kabulab-cf.satoki252595.workers.dev/)";

export type BisBankingPosition = "claims" | "liabilities";

const POSITION_CODE: Record<BisBankingPosition, string> = {
  claims: "C",
  liabilities: "L",
};

const INDICATOR_KEY_BY_POSITION: Record<BisBankingPosition, string> = {
  claims: "bis_lbs_cross_border_claims_jp",
  liabilities: "bis_lbs_cross_border_liabilities_jp",
};

/** 全世界合計を表す BIS の擬似コード (CL_BIS_IF_REF_AREA)。国別内訳ではないので除外対象。 */
const ALL_COUNTRIES_CODE = "5J";

/** SDMX v2.1 key を組み立てる (BIS_LBS_DISS の 12 次元、ドット区切り)。 */
function buildKey(position: BisBankingPosition): string {
  const fields = [
    "Q", // FREQ
    "S", // L_MEASURE
    POSITION_CODE[position], // L_POSITION
    "A", // L_INSTR
    "TO1", // L_DENOM
    "A", // L_CURR_TYPE
    "5J", // L_PARENT_CTY
    "A", // L_REP_BANK_TYPE
    "JP", // L_REP_CTY
    "A", // L_CP_SECTOR
    "", // L_CP_COUNTRY (ワイルドカード)
    "N", // L_POS_TYPE (Cross-border)
  ];
  return fields.join(".");
}

/**
 * (1) 最新データの URL を解決する。
 *
 * BIS は JPX と異なり「最新ファイルへのリンクを HTML から都度探す」必要が
 * 無い — SDMX API の `lastNObservations` パラメータがサーバ側で最新観測値を
 * 解決してくれる (2026-09-27 実機確認: 2026-Q2 はまだ存在せず、
 * lastNObservations=1 は常に実在する最新四半期である 2026-Q1 を返した)。
 * そのため「URL 解決」は完全に決定的な組み立てで足りる。
 */
export function bisBankingUrl(
  position: BisBankingPosition,
  lastNObservations = 2
): string {
  const key = buildKey(position);
  const qs = new URLSearchParams({
    format: "csv",
    lastNObservations: String(lastNObservations),
  });
  return `${API_BASE}/${AGENCY}/${DATAFLOW_ID}/${DATAFLOW_VERSION}/${key}?${qs.toString()}`;
}

export interface BisBankingFetchResult {
  position: BisBankingPosition;
  url: string;
  csvText: string;
}

/** 1 系列 (claims または liabilities) を取得する。1 回の実行で 1 HTTP リクエスト。 */
export async function fetchBisBankingCsv(
  position: BisBankingPosition,
  lastNObservations = 2
): Promise<BisBankingFetchResult> {
  const url = bisBankingUrl(position, lastNObservations);
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/csv" },
  });
  if (!res.ok) {
    throw new Error(
      `BIS LBS API エラー: ${res.status} ${res.statusText} (${url})`
    );
  }
  const csvText = await res.text();
  return { position, url, csvText };
}

/**
 * claims/liabilities の 2 系列を取得する。1 回の実行で計 2 HTTP リクエストに限る
 * (JPX 等の「1 日 1 回」の自粛要請とは異なり BIS 利用規約に頻度の明文規定は無いが、
 * 平日 1 日 1 回のバッチ実行という呼び出し側の前提のもとで最小回数に留める)。
 */
export async function fetchBisBanking(lastNObservations = 2): Promise<{
  claims: BisBankingFetchResult;
  liabilities: BisBankingFetchResult;
}> {
  const claims = await fetchBisBankingCsv("claims", lastNObservations);
  const liabilities = await fetchBisBankingCsv("liabilities", lastNObservations);
  return { claims, liabilities };
}

/** CSV パーサが要求する列 (BIS SDMX CSV の実列。2026-09-27 実データで確認)。 */
const REQUIRED_COLUMNS = [
  "L_REP_CTY",
  "L_CP_SECTOR",
  "L_CP_COUNTRY",
  "TIME_PERIOD",
  "OBS_VALUE",
  "OBS_STATUS",
  "UNIT_MEASURE",
  "UNIT_MULT",
] as const;

export interface BisBankingRawRow {
  position: BisBankingPosition;
  reportingCountry: string;
  counterpartySector: string;
  counterpartyCountry: string;
  /** "YYYY-Qn" 形式 (BIS SDMX CSV の TIME_PERIOD をそのまま使う)。 */
  quarter: string;
  /**
   * 単位は UNIT_MEASURE=USD × UNIT_MULT=6 (百万米ドル) を前提に正規化した値。
   * BIS が "NaN" (未計上/未公開) を返した観測は捏造せず null にする
   * (CLAUDE.md ルール2: 欠損は欠損のまま)。
   */
  valueUsdMillion: number | null;
  /** BIS OBS_STATUS 生コード (A=正常値, B=break in series, Q=未公表 等)。 */
  obsStatus: string;
}

function splitCsvLine(line: string): string[] {
  // 2026-09-27 実データ確認: このデータフローの CSV に引用符・埋め込みカンマは
  // 存在しない (全フィールドがコード値か数値)。単純な split で十分だが、
  // 万一クォート付きフィールドが混入した場合は次の行の列数チェックで検知する。
  return line.split(",");
}

/**
 * (2) 取得物 (CSV テキスト) から型付きレコードを返す純関数パーサ。
 * 様式が想定と違えば throw する (CLAUDE.md ルール2)。
 */
export function parseBisBankingCsv(
  csvText: string,
  position: BisBankingPosition
): BisBankingRawRow[] {
  const lines = csvText.split(/\r\n|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error("BIS LBS CSV: 空の応答です");
  }
  const header = splitCsvLine(lines[0]);
  const colIndex = new Map<string, number>();
  header.forEach((name, i) => colIndex.set(name, i));

  for (const required of REQUIRED_COLUMNS) {
    if (!colIndex.has(required)) {
      throw new Error(
        `BIS LBS CSV: 想定した列 "${required}" がヘッダに見つかりません。` +
          `様式が変わった可能性があります。ヘッダ: ${lines[0]}`
      );
    }
  }

  const idxRepCty = colIndex.get("L_REP_CTY")!;
  const idxCpSector = colIndex.get("L_CP_SECTOR")!;
  const idxCpCountry = colIndex.get("L_CP_COUNTRY")!;
  const idxTimePeriod = colIndex.get("TIME_PERIOD")!;
  const idxObsValue = colIndex.get("OBS_VALUE")!;
  const idxObsStatus = colIndex.get("OBS_STATUS")!;
  const idxUnitMeasure = colIndex.get("UNIT_MEASURE")!;
  const idxUnitMult = colIndex.get("UNIT_MULT")!;

  const rows: BisBankingRawRow[] = [];
  for (let lineNo = 1; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    const cols = splitCsvLine(raw);
    if (cols.length !== header.length) {
      throw new Error(
        `BIS LBS CSV: ${lineNo + 1} 行目の列数 (${cols.length}) がヘッダ` +
          ` (${header.length} 列) と一致しません。様式が変わった可能性が` +
          `あります: ${raw}`
      );
    }

    const unitMeasure = cols[idxUnitMeasure];
    const unitMultRaw = cols[idxUnitMult];
    // この関数の数値正規化 (valueUsdMillion) は UNIT_MEASURE=USD かつ
    // UNIT_MULT=6 (百万米ドル) を前提にしている。BIS が別単位/別倍率で
    // 返してきたら、黙って誤ったスケールで扱うのではなく throw する。
    if (unitMeasure !== "USD" || unitMultRaw !== "6") {
      throw new Error(
        `BIS LBS CSV: ${lineNo + 1} 行目の単位が想定外です ` +
          `(UNIT_MEASURE=${unitMeasure}, UNIT_MULT=${unitMultRaw})。` +
          `USD/6 (百万米ドル) 前提のパーサを見直す必要があります。`
      );
    }

    const obsValueRaw = cols[idxObsValue];
    let valueUsdMillion: number | null;
    if (obsValueRaw === "NaN" || obsValueRaw === "") {
      // BIS が明示的に「値なし」を返したケース。0 で埋めず null にする。
      valueUsdMillion = null;
    } else {
      const parsed = Number(obsValueRaw);
      if (!Number.isFinite(parsed)) {
        throw new Error(
          `BIS LBS CSV: ${lineNo + 1} 行目の OBS_VALUE が数値として解釈でき` +
            `ません: "${obsValueRaw}"`
        );
      }
      valueUsdMillion = parsed;
    }

    const quarter = cols[idxTimePeriod];
    if (!/^\d{4}-Q[1-4]$/.test(quarter)) {
      throw new Error(
        `BIS LBS CSV: ${lineNo + 1} 行目の TIME_PERIOD が "YYYY-Qn" 形式では` +
          `ありません: "${quarter}"`
      );
    }

    rows.push({
      position,
      reportingCountry: cols[idxRepCty],
      counterpartySector: cols[idxCpSector],
      counterpartyCountry: cols[idxCpCountry],
      quarter,
      valueUsdMillion,
      obsStatus: cols[idxObsStatus],
    });
  }

  if (rows.length === 0) {
    throw new Error("BIS LBS CSV: データ行が 0 件です");
  }
  return rows;
}

/**
 * (3-a) 取得済み行から「実在する最新四半期」を求める。
 * 全世界合計行 (L_CP_COUNTRY=5J, 全部門合算) を錨 (アンカー) にする —
 * 個別国は途中で報告を止めている場合があり (例: 消滅した国・地域コード)、
 * 錨無しで「行に含まれる最大の四半期」を取ると、たまたま残っている
 * 過去だけの国の四半期に引きずられない。
 */
export function latestQuarterFromRows(rows: BisBankingRawRow[]): string {
  const anchors = rows.filter(
    (r) =>
      r.counterpartyCountry === ALL_COUNTRIES_CODE &&
      r.counterpartySector === "A" &&
      r.valueUsdMillion !== null
  );
  if (anchors.length === 0) {
    throw new Error(
      "BIS LBS: 全世界合計行 (L_CP_COUNTRY=5J, L_CP_SECTOR=A) が見つかりません。" +
        "クエリのキーか様式が変わった可能性があります。"
    );
  }
  // "YYYY-Qn" は辞書式順序が時系列順序と一致する (年 4 桁 + 四半期 1 桁固定)。
  return anchors.map((r) => r.quarter).sort().at(-1)!;
}

/**
 * (3-b) 「まだ公表されていない」の判定。
 *
 * BIS の公表ラグを推測で埋め込むのではなく、暦上「直近に終わった四半期」
 * (進行中の四半期は当然まだ存在しない) を計算し、それに実際のデータが
 * 追いついているかどうかを突き合わせる、という事実ベースの判定にする
 * (CLAUDE.md ルール2: 推測で埋めない)。
 *
 * 2026-09-27 の実機確認: `mostRecentEndedQuarter("2026-09-27")` は
 * "2026-Q2" (4-6月期、6/30 に終了済み) になるが、BIS 側の実際の最新は
 * "2026-Q1" だった (2026-Q2 を明示的にクエリすると 404/該当なし)。
 * つまり `isCaughtUp: false` が実データと整合する — これは異常ではなく
 * BIS の通常の公表ラグ (四半期末から約1四半期) の帰結であり、呼び出し側は
 * これを「取込をスキップしてよい」判定に使う。
 */
export function mostRecentEndedQuarter(asOf: Date): string {
  const year = asOf.getUTCFullYear();
  const currentQuarter = Math.floor(asOf.getUTCMonth() / 3) + 1; // 1-4 (進行中)
  const endedQuarterNumber = currentQuarter - 1;
  if (endedQuarterNumber >= 1) {
    return `${year}-Q${endedQuarterNumber}`;
  }
  return `${year - 1}-Q4`;
}

export interface BisBankingPublicationStatus {
  /** BIS が実際に公表済みの最新四半期 (取得データから求めた事実)。 */
  latestAvailableQuarter: string;
  /** 暦上、直近に終わった四半期 (公表ラグを考慮しない基準値)。 */
  mostRecentEndedQuarter: string;
  /** 暦上の直近四半期まで公表が追いついているか。false でもエラーではない (通常の公表ラグ)。 */
  isCaughtUp: boolean;
}

export function resolvePublicationStatus(
  rows: BisBankingRawRow[],
  asOf: Date
): BisBankingPublicationStatus {
  const latestAvailableQuarter = latestQuarterFromRows(rows);
  const ended = mostRecentEndedQuarter(asOf);
  return {
    latestAvailableQuarter,
    mostRecentEndedQuarter: ended,
    isCaughtUp: latestAvailableQuarter >= ended,
  };
}

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

export type MoneyflowRequirement = "R1" | "R2" | "R3" | "R4";

/** 計画書 (notion-velvet-goose.md) が定義する「何を測るか」の分類。 */
export type MoneyflowFlowType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowIndicatorDefinition {
  key: string;
  displayName: string;
  requirements: MoneyflowRequirement[];
  flowType: MoneyflowFlowType;
  /** 何を測るか (簡潔に)。 */
  whatItMeasures: string;
  /** 平易な日本語で1〜3文、可能なら具体例つき (CLAUDE.md ルール7 準拠の説明文)。 */
  plainExplanation: string;
  /** 財務的に正確な定義 (噛み砕きと引き換えに誤らせない)。 */
  preciseDefinition: string;
  unit: string;
  sourceUrl: string;
  termsOfUse: string;
  frequency: string;
  limitations: string;
}

const COMMON_TERMS_OF_USE =
  "BIS「Terms of permitted use of BIS statistics」(2026-09-27 " +
  "https://data.bis.org/help/legal で確認) により、出典 (BIS) を明記すれば" +
  "商用利用を含め無償・無許諾で再利用可能。ただし (a) 翻訳時は公式訳でない旨の" +
  "明記が必要、(b) BIS の推奨・提携を示唆する使い方は不可、(c) 商用製品への" +
  "組込みで追加課金してはならない、(d) 投資助言と解釈されうる記載をしてはい" +
  "けない、との条件付き。API 自体は as-is 提供で、BIS は予告なく IP 単位の" +
  "アクセス制限・停止を留保している (kabulab は個人利用の平日1回程度の低頻" +
  "度バッチのみを想定)。";

export const BIS_BANKING_INDICATORS: MoneyflowIndicatorDefinition[] = [
  {
    key: INDICATOR_KEY_BY_POSITION.claims,
    displayName: "対外与信残高（日本所在銀行→相手国、BIS所在地ベース）",
    requirements: ["R4"],
    flowType: "holdings_stock",
    whatItMeasures:
      "日本国内に所在する銀行 (内外資問わず) が、海外の相手国・地域に対して" +
      "持つ、越境 (クロスボーダー) 与信の残高。",
    plainExplanation:
      "「日本にある銀行が海外にいくら貸しているか」の残高 (ある四半期末時点の" +
      "スナップショット)。その期間に新たに貸した額(フロー)ではなく、これまで" +
      "積み上がった貸出・債券保有等の合計であることに注意。例えば対米与信" +
      "残高が2兆3,793億ドルなら、日本所在の銀行が米国向けに合計で約2.4兆ドル" +
      "分の資産(貸出・保有証券等)を積み上げている状態を意味する。",
    preciseDefinition:
      "BIS Locational Banking Statistics (所在地ベース国際銀行統計、" +
      "dataflow BIS:WS_LBS_D_PUB) の Total claims (L_POSITION=C) のうち " +
      "Cross-border (L_POS_TYPE=N) 部分。全通貨・全商品・相手方全部門を" +
      "合算した、日本所在の報告銀行 (L_REP_CTY=JP) が持つ対外クロスボーダー" +
      "資産残高 (米ドル建て、四半期末時点、報告銀行の国籍は問わない集計)。",
    unit: "USD_million",
    sourceUrl:
      "https://data.bis.org/ (dataflow BIS:WS_LBS_D_PUB(1.0), Locational banking)",
    termsOfUse: COMMON_TERMS_OF_USE,
    frequency: "quarterly",
    limitations:
      "(1) 残高 (ストック) であり、その期間中に実際に動いた資金フローその" +
      "ものではない(為替変動・評価替え・報告対象銀行の入れ替えの影響を含む。" +
      "真のフローに近づけるには BIS 自身が計算する adjusted change 系列が" +
      "別途必要で、本指標はそれを含まない)。(2) 相手国は所在地(法人登記地)" +
      "ベースの計上であり、資金の最終使用地(ultimate risk basis、BIS の" +
      "Consolidated Banking Statistics が別途扱う概念)とは一致しない。" +
      "(3) 相手部門は全部門合算のため、銀行間取引と実体経済向け与信が混在" +
      "する。(4) 公表は四半期末から約1四半期(3〜4か月)遅れる。(5) 一部の" +
      "相手国・地域は報告が薄い/欠測(NaN)のことがあり、その場合は当該国の" +
      "行を作らない(0で埋めない)。",
  },
  {
    key: INDICATOR_KEY_BY_POSITION.liabilities,
    displayName: "対外負債残高（日本所在銀行→相手国、BIS所在地ベース）",
    requirements: ["R4"],
    flowType: "holdings_stock",
    whatItMeasures:
      "日本国内に所在する銀行 (内外資問わず) が、海外の相手国・地域に対して" +
      "負う、越境 (クロスボーダー) 負債の残高。",
    plainExplanation:
      "「日本にある銀行が海外からいくら借りている(預かっている)か」の残高。" +
      "上の与信残高と対になる指標で、海外から日本の銀行システムへ流れ込んで" +
      "いる資金の積み上がり具合を表す。与信残高から負債残高を引くと、日本" +
      "所在銀行が海外に対して純粋にどれだけ資金を出し越し(または受け入れ" +
      "越し)ているかの目安になる(ただし為替変動等を含む近似値)。",
    preciseDefinition:
      "BIS Locational Banking Statistics の Total liabilities " +
      "(L_POSITION=L) のうち Cross-border (L_POS_TYPE=N) 部分。全通貨・" +
      "全商品・相手方全部門を合算した、日本所在の報告銀行 (L_REP_CTY=JP) が" +
      "負う対外クロスボーダー負債残高 (米ドル建て、四半期末時点)。",
    unit: "USD_million",
    sourceUrl:
      "https://data.bis.org/ (dataflow BIS:WS_LBS_D_PUB(1.0), Locational banking)",
    termsOfUse: COMMON_TERMS_OF_USE,
    frequency: "quarterly",
    limitations:
      "対外与信残高 (bis_lbs_cross_border_claims_jp) と同じ限界を持つ" +
      "(残高であり真のフローではない、所在地ベースで最終リスクベースでは" +
      "ない、全部門合算、公表ラグ約1四半期、一部相手国は欠測)。",
  },
];

// ---------------------------------------------------------------------------
// 縦長レコード (資金フロー｜観測ログ 相当) への変換
// ---------------------------------------------------------------------------

export interface MoneyflowObservation {
  /** "YYYY-Qn" 形式の対象期間。 */
  period: string;
  indicatorKey: string;
  /** 区分。この取得元では BIS の相手国・地域コード (CL_BIS_IF_REF_AREA)。 */
  category: string;
  value: number;
  unit: string;
  /** 近似フラグ。真のフローではなく残高ベースの近似であることを示す。 */
  isApproximate: boolean;
  /** 推定フラグ。この指標は BIS 公表値そのもので、kabulab 側での推定加工は無い。 */
  isEstimated: boolean;
}

/**
 * 取得済み行を「期間・指標キー・区分・値・単位・近似か・推定か」の縦長形式に
 * 変換する純関数。
 *
 * - 全世界合計行 (L_CP_COUNTRY=5J) は「国別」の内訳ではないので除外する。
 * - 欠測 (valueUsdMillion === null) の行は作らない (0 で埋めない。ルール2)。
 */
export function toMoneyflowObservations(
  rows: BisBankingRawRow[]
): MoneyflowObservation[] {
  const out: MoneyflowObservation[] = [];
  for (const row of rows) {
    if (row.counterpartyCountry === ALL_COUNTRIES_CODE) continue;
    if (row.valueUsdMillion === null) continue;
    out.push({
      period: row.quarter,
      indicatorKey: INDICATOR_KEY_BY_POSITION[row.position],
      category: row.counterpartyCountry,
      value: row.valueUsdMillion,
      unit: "USD_million",
      // ストック(残高)ベースの近似指標であり、真の資金フローそのものでは
      // ない(計画書 docs/moneyflow.md の「R4 世界の概況」節: 「すべて残高で、
      // 真のフローではない」と同じ扱い)。
      isApproximate: true,
      // BIS が直接公表する値そのものであり、kabulab 側で統計的に推定した
      // 値ではない。
      isEstimated: false,
    });
  }
  return out;
}
