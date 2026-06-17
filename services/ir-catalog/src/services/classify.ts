/**
 * 適時開示タイトルの **決定論的** タグ分類 (ルール1/2)。
 *
 * - タイトルに含まれる語だけで判定する。本文は取得しない (サイト負荷回避 +
 *   全量取得が現実的)。
 * - どの規則にも当てはまらない開示は **タグを付けない** (`[]`)。それっぽい
 *   タグを推測して埋めない (ルール1)。UI/Notion では「未分類」と正直に出す。
 * - 「配当予想の修正」「業績予想の修正」は **方向 (増配/減配・上方/下方)
 *   がタイトルに明示されているときだけ** 方向タグを付ける。明示が無ければ
 *   中立タグに留め、勝手に方向を決めない (ルール2)。
 *
 * 色は UI のチップ表示と Notion multi_select の両方で使う単一定義。
 */

export type NotionColor =
  | "default"
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

export interface TagDef {
  /** 表示ラベル (= タグ ID。日本語) */
  label: string;
  /** Notion multi_select の色 */
  notionColor: NotionColor;
  /** UI チップの枠/文字色 (Editorial Swiss: 2px ソリッド枠・グロー無し) */
  ink: string;
  /** UI チップの淡い背景 */
  fill: string;
  /** 投資初心者向けの平易な解説 (ルール7。1〜3文) */
  tip: string;
  /** 配当/業績/自社株買い等の高シグナル開示か (Notion 高シグナル DB 対象) */
  highSignal: boolean;
  /** タイトル判定 (決定論的) */
  match: (title: string) => boolean;
}

const has =
  (...words: string[]) =>
  (t: string): boolean =>
    words.some((w) => t.includes(w));

/**
 * タグ定義。配列順がそのまま primaryTag の優先順位 (上にあるものが優先)。
 * highSignal を意図的に上位へ並べ、色分けが投資判断に効く開示を優先表示する。
 */
export const TAGS: readonly TagDef[] = [
  {
    label: "上方修正",
    notionColor: "green",
    ink: "#1a7f37",
    fill: "#e6f4ea",
    tip: "会社が出した売上や利益の見通しを、前より良い数字に引き上げること。業績が想定より好調なサインとされる。",
    highSignal: true,
    match: (t) => has("上方修正", "上振れ")(t) && !t.includes("下方修正"),
  },
  {
    label: "下方修正",
    notionColor: "red",
    ink: "#b42318",
    fill: "#fde8e6",
    tip: "会社が出した売上や利益の見通しを、前より悪い数字に引き下げること。業績が想定より不調なサインとされる。",
    highSignal: true,
    match: has("下方修正", "下振れ"),
  },
  {
    label: "増配",
    notionColor: "green",
    ink: "#1a7f37",
    fill: "#e6f4ea",
    tip: "1株あたりの配当金を前回計画より増やすこと。株主への利益還元を厚くする動きで、自信の表れとされることが多い。",
    highSignal: true,
    match: (t) => t.includes("増配"),
  },
  {
    label: "減配・無配",
    notionColor: "red",
    ink: "#b42318",
    fill: "#fde8e6",
    tip: "1株あたりの配当金を前回計画より減らす(減配)、または配当を出さない(無配)こと。業績悪化や方針転換のサインになり得る。",
    highSignal: true,
    match: has("減配", "無配"),
  },
  {
    label: "配当政策の変更",
    notionColor: "blue",
    ink: "#1849a9",
    fill: "#e7eefb",
    tip: "「利益の何%を配当に回すか」など、配当の決め方そのものを見直すこと。累進配当(減らさない方針)の導入なども含む。金額1回分の増減(増配)とは別物。",
    highSignal: true,
    match: (t) =>
      (has("配当方針", "配当政策", "株主還元方針", "累進配当", "配当性向", "株主還元の方針")(t) &&
        has("変更", "見直し", "改定", "導入", "決定", "方針", "策定")(t)) ||
      t.includes("株主還元方針"),
  },
  {
    label: "自社株買い",
    notionColor: "purple",
    ink: "#6b21a8",
    fill: "#f1e9fb",
    tip: "会社が自分の株を市場などから買い戻すこと。1株あたりの価値を高める株主還元策の一つとされる。",
    highSignal: true,
    match: (t) =>
      has("自己株式の取得", "自社株買い", "自己株式取得")(t) ||
      (t.includes("自己株式") && has("立会外買付", "ToSTNeT", "取得状況")(t)),
  },
  {
    label: "自己株式の消却",
    notionColor: "purple",
    ink: "#6b21a8",
    fill: "#f1e9fb",
    tip: "会社が買い戻して持っている自社株を消す(無効にする)こと。発行済み株式が減り、1株あたりの価値が高まる方向に働く。",
    highSignal: true,
    match: (t) => t.includes("自己株式の消却") || t.includes("自己株式消却"),
  },
  {
    label: "配当(決定・予想)",
    notionColor: "yellow",
    ink: "#8a6d00",
    fill: "#fbf3d6",
    tip: "配当金の予想や金額の決定に関する開示。増配・減配の明示がないもの。金額が前回計画と比べて増えたか減ったかは本文で要確認。",
    highSignal: false,
    match: (t) =>
      has("配当予想", "剰余金の配当", "配当の予想", "配当金", "復配", "記念配当", "特別配当")(t),
  },
  {
    label: "業績予想の修正",
    notionColor: "orange",
    ink: "#9a3412",
    fill: "#fbeadf",
    tip: "売上や利益の見通しを変更する開示で、上方/下方が表題に明示されていないもの。良い方向か悪い方向かは本文で要確認。",
    highSignal: false,
    match: (t) =>
      has("業績予想", "通期予想", "連結業績予想")(t) &&
      has("修正", "変更")(t) &&
      !has("上方修正", "下方修正")(t),
  },
  {
    label: "決算短信",
    notionColor: "gray",
    ink: "#475467",
    fill: "#eef0f3",
    tip: "四半期や通期の決算速報。売上・利益の実績がまとまった、IRの中で最も基本的な定期開示。",
    highSignal: false,
    match: (t) => t.includes("決算短信"),
  },
  {
    label: "特別損益",
    notionColor: "red",
    ink: "#b42318",
    fill: "#fde8e6",
    tip: "本業以外で一時的に発生した大きな損失(特別損失)や利益(特別利益)。減損損失もここ。利益の見え方が一時的に大きく動く。",
    highSignal: false,
    match: has("特別損失", "特別利益", "特損", "減損損失", "減損の計上"),
  },
  {
    label: "株式分割・併合",
    notionColor: "blue",
    ink: "#1849a9",
    fill: "#e7eefb",
    tip: "1株を複数株に分ける(分割)、または複数株を1株にまとめる(併合)こと。1株の値段は変わるが、保有資産の総額自体は理論上変わらない。",
    highSignal: false,
    match: has("株式分割", "株式併合"),
  },
  {
    label: "エクイティファイナンス",
    notionColor: "brown",
    ink: "#7a5c1e",
    fill: "#f4ecdd",
    tip: "新しい株や新株予約権・転換社債などを発行して資金を集めること。発行株数が増え、既存株主の持ち分が薄まる(希薄化)場合がある。",
    highSignal: false,
    match: has(
      "公募増資",
      "第三者割当",
      "新株式発行",
      "募集株式",
      "新株予約権",
      "転換社債",
      "ライツ・オファリング",
      "売出し",
      "株式売出"
    ),
  },
  {
    label: "自己株式の処分",
    notionColor: "purple",
    ink: "#6b21a8",
    fill: "#f1e9fb",
    tip: "会社が持っている自社株を、第三者割当や報酬目的などで外に出すこと。新規発行に近く、株数が実質的に増える方向に働くことがある。",
    highSignal: false,
    match: (t) => t.includes("自己株式の処分"),
  },
  {
    label: "M&A・資本提携",
    notionColor: "pink",
    ink: "#a8327e",
    fill: "#fbe7f3",
    tip: "他社の買収・子会社化・合併、資本業務提携、株式公開買付け(TOB)など、会社の支配や資本関係が動く開示。",
    highSignal: false,
    match: has(
      "株式取得",
      "子会社化",
      "合併",
      "事業譲渡",
      "資本業務提携",
      "資本提携",
      "公開買付",
      "ＴＯＢ",
      "TOB",
      "株式交換",
      "株式移転",
      "連結子会社"
    ),
  },
  {
    label: "月次・速報",
    notionColor: "gray",
    ink: "#475467",
    fill: "#eef0f3",
    tip: "毎月の売上高など、決算より早く出る簡易な業績速報。トレンドを早めに掴むために使われる。",
    highSignal: false,
    match: (t) =>
      t.includes("月次") || (t.includes("売上高") && has("速報", "概況")(t)),
  },
  {
    label: "重要事象(調査等)",
    notionColor: "red",
    ink: "#b42318",
    fill: "#fde8e6",
    tip: "不適切な会計や不正の調査、第三者委員会の設置、行政処分など、信頼性に関わる重大な開示。投資判断に大きく影響し得る。",
    highSignal: false,
    match: has(
      "特別調査委員会",
      "第三者委員会",
      "不適切",
      "不正",
      "行政処分",
      "課徴金",
      "業務改善命令",
      "内部統制の不備"
    ),
  },
  {
    label: "上場・市場区分",
    notionColor: "blue",
    ink: "#1849a9",
    fill: "#e7eefb",
    tip: "新規上場、上場廃止、プライム/スタンダード等の市場区分変更、監理・整理銘柄指定など、上場ステータスに関する開示。",
    highSignal: false,
    match: has(
      "新規上場",
      "上場廃止",
      "市場区分の変更",
      "市場変更",
      "監理銘柄",
      "整理銘柄",
      "上場維持基準"
    ),
  },
  {
    label: "人事・組織",
    notionColor: "default",
    ink: "#344054",
    fill: "#eef0f3",
    tip: "代表取締役や役員の異動、組織変更などの開示。経営体制の変化を表す。",
    highSignal: false,
    match: has(
      "代表取締役",
      "役員人事",
      "役員の異動",
      "人事異動",
      "組織変更",
      "経営体制"
    ),
  },
  {
    label: "訂正・取消",
    notionColor: "gray",
    ink: "#475467",
    fill: "#eef0f3",
    tip: "過去に出した開示の内容を訂正・取り消す開示。元の開示と必ずセットで読む必要がある。",
    highSignal: false,
    match: (t) => has("訂正", "取消", "取り消し")(t),
  },
] as const;

const LABEL_TO_DEF = new Map(TAGS.map((d) => [d.label, d] as const));

export function tagDef(label: string): TagDef | undefined {
  return LABEL_TO_DEF.get(label);
}

export interface Classification {
  /** 付与タグ (配列順 = TAGS 定義順 = 表示優先順)。0 件 = 未分類 */
  tags: string[];
  /** 色分け用の代表タグ。未分類なら null (捏造しない) */
  primaryTag: string | null;
}

/**
 * タイトルを決定論的に分類する。マッチが無ければ tags=[] / primaryTag=null
 * を返す (フォールバックで適当なタグを付けない)。
 */
export function classify(title: string): Classification {
  const t = (title ?? "").normalize("NFKC");
  const tags: string[] = [];
  for (const def of TAGS) {
    if (def.match(t)) tags.push(def.label);
  }
  const primaryTag =
    tags.find((l) => LABEL_TO_DEF.get(l)?.highSignal) ?? tags[0] ?? null;
  return { tags, primaryTag };
}

/** Notion multi_select 用に全タグの色オプションを返す */
export function notionTagOptions(): Array<{ name: string; color: NotionColor }> {
  return TAGS.map((d) => ({ name: d.label, color: d.notionColor }));
}

/** Notion 高シグナル DB へ載せる対象タグ集合 */
export const HIGH_SIGNAL_TAGS: ReadonlySet<string> = new Set(
  TAGS.filter((d) => d.highSignal).map((d) => d.label)
);

/** buffett-code の銘柄ページ URL (UI / Notion 共通) */
export function buffettCodeUrl(ticker: string): string {
  return `https://www.buffett-code.com/company/${ticker}/`;
}
