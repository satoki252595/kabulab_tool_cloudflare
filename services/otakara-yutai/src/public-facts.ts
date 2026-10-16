export const VALUE_REASON_LABELS = {
  qualified_company_per_grant: "掲載額の条件を確認済み",
  ambiguous_qualified_amounts: "複数の金額候補があり未確定",
  no_source_yen_amount: "掲載文に円額の記載なし",
  addon: "追加特典を含む全額が未確定",
  ambiguous_condition_tiers: "株数・保有期間別の金額対応が未確定",
  annual: "年間額を1回分へ換算できない",
  approx: "概算額のため未評価",
  choice: "選択肢を合算できないため未評価",
  discount: "割引の利用額が未確定",
  foreign: "外貨額の円換算が未確認",
  lottery: "抽選の当選を前提に評価しない",
  malformed_headed_contract: "掲載条件の構造が未確認",
  mixed_share_context: "株数条件が混在して未確定",
  multi_face_components: "複数特典の金額対応が未確定",
  multi_month_amounts: "権利月ごとの金額対応が未確定",
  "no-value": "金額が未取得",
  no_per_grant_face: "1回の受取額を確認できない",
  resale: "売却相場を優待額に代用しない",
  unit_partial: "単価だけでは全受取額を確認できない",
  unsupported_yen_notation: "金額表記を確実に解析できない",
} as const;

export type PublicBenefitFacts = {
  version: 1;
  sourceGroup: string;
  /** 掲載表記の検出。必要条件・適用対象を確認済みという意味ではない。 */
  holding: boolean;
  /** 掲載中の期間表記。株数・保有条件・別の利用期間との対応は未確定。 */
  holdingPeriods: string[];
  /** 選択・抽選に関する掲載表記の検出。対象の確定ではない。 */
  choice: boolean;
  lottery: boolean;
  /** 申込・応募表記の検出。希望者限定等を全員必須へ読み替えない。 */
  application: boolean;
  /** 併用可否の掲載表記。券の利用と特典の同時受取を区別した確認は未実施。 */
  combination: "allowed" | "not_allowed" | "unverified";
  valueStatus: "source_amount_qualified" | "unresolved";
  qualifiedAmount: number | null;
  valueReasons: (keyof typeof VALUE_REASON_LABELS)[];
  source: {
    listingUrl: string;
    fetchedAt: string | null;
    batchFetchedAt: string | null;
    officialStatus: "not_verified" | "verified";
    officialUrl: string | null;
    verifiedAt: string | null;
  };
};

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("公開条件DTOのキーが不正です");
  }
  return value as Record<string, unknown>;
}
const iso = (v: unknown): boolean => v === null || (typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const https = (v: unknown): boolean => {
  if (typeof v !== "string") return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.hostname !== "minkabu.jp" && !url.hostname.endsWith(".minkabu.jp");
  } catch { return false; }
};

/** strict DTOだけを返し、未知キーや壊れたJSONを公開しない。掲載文は一切含めない。 */
export function parsePublicBenefitFacts(value: unknown, code?: string): PublicBenefitFacts | null {
  if (value === null) return null;
  const facts = record(typeof value === "string" ? JSON.parse(value) : value,
    ["version", "sourceGroup", "holding", "holdingPeriods", "choice", "lottery", "application", "combination", "valueStatus", "qualifiedAmount", "valueReasons", "source"]);
  const source = record(facts.source, ["listingUrl", "fetchedAt", "batchFetchedAt", "officialStatus", "officialUrl", "verifiedAt"]);
  if (facts.version !== 1 || typeof facts.sourceGroup !== "string" || !/^[0-9a-f]{16}$/.test(facts.sourceGroup) ||
      [facts.holding, facts.choice, facts.lottery, facts.application].some(v => typeof v !== "boolean") ||
      !Array.isArray(facts.holdingPeriods) || facts.holdingPeriods.some(v => typeof v !== "string" || !/^(?:[0-9]+|半)(?:年|か月)(?:以上|未満|以下|超)$/.test(v)) ||
      (facts.holding === false && facts.holdingPeriods.length > 0) ||
      !["allowed", "not_allowed", "unverified"].includes(facts.combination as string) ||
      !["source_amount_qualified", "unresolved"].includes(facts.valueStatus as string) ||
      (facts.qualifiedAmount !== null && (typeof facts.qualifiedAmount !== "number" || !Number.isSafeInteger(facts.qualifiedAmount) || facts.qualifiedAmount <= 0)) ||
      (facts.valueStatus === "unresolved" && facts.qualifiedAmount !== null) ||
      (facts.valueStatus === "source_amount_qualified" && facts.qualifiedAmount === null) ||
      !Array.isArray(facts.valueReasons) || facts.valueReasons.length === 0 || facts.valueReasons.some(v => typeof v !== "string" || !Object.hasOwn(VALUE_REASON_LABELS, v)) ||
      (facts.valueStatus === "source_amount_qualified" ? facts.valueReasons.length !== 1 || facts.valueReasons[0] !== "qualified_company_per_grant"
        : facts.valueReasons.includes("qualified_company_per_grant")) ||
      typeof source.listingUrl !== "string" || !/^https:\/\/minkabu\.jp\/stock\/[0-9]{3}[0-9A-Z]\/yutai$/.test(source.listingUrl) ||
      !iso(source.fetchedAt) || !iso(source.batchFetchedAt) || !iso(source.verifiedAt) ||
      (source.officialStatus === "verified" ? !https(source.officialUrl) || source.verifiedAt === null
        : source.officialStatus !== "not_verified" || source.officialUrl !== null || source.verifiedAt !== null)) {
    throw new Error("公開条件DTOの値が不正です");
  }
  if (code !== undefined && source.listingUrl !== `https://minkabu.jp/stock/${code}/yutai`) {
    throw new Error("公開条件の銘柄と掲載出典が一致しません");
  }
  return facts as PublicBenefitFacts;
}
