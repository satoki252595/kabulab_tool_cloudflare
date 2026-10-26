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

export type BenefitConditionStructure = {
  rule: "one-of-list-v1";
  /** 正規化前の保存description全文SHA。公開DTOに商品ラベルや原文は含めない。 */
  sourceSha256: string;
} & ({ status: "literal_parsed"; ast: { take: 1; options: { ordinal: number; listedYen: number; notation: "相当" | "分" }[] } }
  | { status: "unparsed"; ast: null; reason: "malformed_heading" | "additional_condition" | "unsupported_grammar" });

export type BenefitHoldingStructure = {
  status: "literal_parsed";
  rule: "single-holding-period-v1";
  sourceSha256: string;
  applicability: "unverified";
  ast: { holdingPeriod: "半年以上"; benefit: { kind: "coupon"; listedYen: number; notation: "相当" } }
    | { holdingPeriod: "1年以上"; benefit: { kind: "admission_tickets"; quantity: number; unit: "枚" } };
};

/** 掲載の2期間と名簿定義。株数・名義・本人への適用や権利日は確定しない。 */
export type BenefitRecordTierStructure = {
  status: "literal_parsed";
  rule: "holding-record-tiers-v1";
  sourceSha256: string;
  applicability: "unverified";
  ast: {
    benefitKind: "quo_card";
    tiers: [
      { ordinal: 1; holdingPeriod: string; listedYen: number; notation: "相当" | "分" },
      { ordinal: 2; holdingPeriod: string; listedYen: number; notation: "相当" | "分" },
    ];
    registryDefinition: { continuousHoldingPeriod: string; minimumEntries: number; entryMeaning: "listed_or_recorded" };
    shipment: { month: number; part: "上旬" | "中旬" | "下旬"; frequency: "annual"; status: "planned" };
  };
};

/** 行に明記された期間と円額だけ。残りの条件や重複期間の優先順位を推定しない。 */
export type BenefitTierLiterals = {
  status: "literal_extracted";
  rule: "holding-tier-lines-v1";
  sourceSha256: string;
  applicability: "unverified";
  ast: {
    tiers: { ordinal: number; holdingPeriod: string; listedYen: number; notation: "相当" | "分" }[];
    combinationClauses: { scope: "coupon_use"; counterpart: "other_discount" | "other_coupon"; allowed: boolean }[];
    registry?: BenefitRegistryStructure;
    remainingConditionLines: number;
  };
};

export type BenefitRegistryDate = { month: number; day: number | "month_end" };
export type BenefitRegistryClause =
  | { kind: "holding_definition"; holdingPeriod: string; minimumConsecutiveRecords: number; recordObject: "unspecified" }
  | { kind: "registry_requirement"; identity: "shareholder_number"; recordDates: BenefitRegistryDate[];
    recurrence: "annual" | "unprovided"; minimumConsecutiveRecords: number; minimumShares: number | null; entryMeaning: "recorded" | "listed" }
  | { kind: "same_name_holding"; identity: "registered_name"; recordDates: BenefitRegistryDate[]; holdingPeriod: string; recurrence: "annual" };

export type BenefitRegistryStructure = {
  status: "literal_extracted";
  rule: "holding-registry-clauses-v1";
  sourceSha256: string;
  applicability: "unverified";
  ast: { clauses: BenefitRegistryClause[]; remainingSectionLines: number; remainingDescriptionLines: number };
};

export type PublicBenefitFacts = ({ version: 1 } | { version: 2; conditionStructure: BenefitConditionStructure }
  | { version: 3; conditionStructure: BenefitHoldingStructure } | { version: 4; conditionStructure: BenefitRecordTierStructure }
  | { version: 5; conditionStructure: BenefitTierLiterals }
  | { version: 6; conditionStructure: { status: "literal_extracted"; rule: "initial-event-no-holding-period-v1"; sourceSha256: string;
      applicability: "unverified"; ast: { recordDate: "2026-09-30"; minimumRegistryShares: 200; holdingPeriod: "not_required" } } }
  | { version: 7; conditionStructure: { status: "literal_extracted"; rule: "kawasaki-holding-period-transition-v1"; sourceSha256: string;
      applicability: "unverified"; ast: { beforeHoldingPeriod: "not_stated"; fromRecordDate: "2027-02-28"; afterHoldingPeriods: ["半年以上", "3年以上"] } } }) & {
  sourceGroup: string;
  /** 掲載表記の検出。必要条件・適用対象を確認済みという意味ではない。 */
  holding: boolean;
  /** 掲載中の期間表記。v3/v4の全文対応を除き特典との対応は未確定。本人・株数条件は未確認。 */
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
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function assertBenefitRegistryStructure(value: unknown, sourceSha256: string): asserts value is BenefitRegistryStructure {
  const structure = record(value, ["status", "rule", "sourceSha256", "applicability", "ast"]);
  const ast = record(structure.ast, ["clauses", "remainingSectionLines", "remainingDescriptionLines"]);
  if (structure.status !== "literal_extracted" || structure.rule !== "holding-registry-clauses-v1" || structure.sourceSha256 !== sourceSha256 ||
      structure.applicability !== "unverified" || !Array.isArray(ast.clauses) || ast.clauses.length === 0 || ast.clauses.length > 32 ||
      ![ast.remainingSectionLines, ast.remainingDescriptionLines].every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0) ||
      (ast.remainingSectionLines as number) > (ast.remainingDescriptionLines as number)) throw new Error("掲載名簿条件の構造が不正です");
  for (const value of ast.clauses) {
    const kind = typeof value === "object" && value !== null && "kind" in value ? value.kind : undefined;
    if (kind === "holding_definition") {
      const clause = record(value, ["kind", "holdingPeriod", "minimumConsecutiveRecords", "recordObject"]);
      if (typeof clause.holdingPeriod !== "string" || !/^(?:[1-9][0-9]*年|半年|[1-9][0-9]*か月)以上$/.test(clause.holdingPeriod) ||
          !positiveInteger(clause.minimumConsecutiveRecords) || clause.recordObject !== "unspecified") throw new Error("継続回数の掲載定義が不正です");
      continue;
    }
    const named = kind === "same_name_holding";
    const clause = record(value, named ? ["kind", "identity", "recordDates", "holdingPeriod", "recurrence"] :
      ["kind", "identity", "recordDates", "recurrence", "minimumConsecutiveRecords", "minimumShares", "entryMeaning"]);
    if (!Array.isArray(clause.recordDates) || clause.recordDates.length !== (named ? 1 : 2)) throw new Error("掲載基準日の件数が不正です");
    for (const value of clause.recordDates) {
      const date = record(value, ["month", "day"]);
      if (!positiveInteger(date.month) || date.month > 12 ||
          (date.day !== "month_end" && (!positiveInteger(date.day) || date.day > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][date.month - 1]!))) throw new Error("掲載基準日が不正です");
      if (named && date.day !== "month_end") throw new Error("掲載同名義の基準日が不正です");
    }
    if (new Set(clause.recordDates.map(value => { const date = record(value, ["month", "day"]); return JSON.stringify([date.month, date.day]); })).size !== clause.recordDates.length) throw new Error("掲載基準日が重複しています");
    if (named) {
      if (clause.identity !== "registered_name" || clause.recurrence !== "annual" || typeof clause.holdingPeriod !== "string" ||
          !/^(?:[1-9][0-9]*年|半年|[1-9][0-9]*か月)以上$/.test(clause.holdingPeriod)) throw new Error("掲載同名義条件が不正です");
    } else if (kind !== "registry_requirement" || clause.identity !== "shareholder_number" || !positiveInteger(clause.minimumConsecutiveRecords) ||
        (clause.minimumShares === null ? clause.recurrence !== "annual" || clause.entryMeaning !== "recorded"
          : !positiveInteger(clause.minimumShares) || clause.recurrence !== "unprovided" || clause.entryMeaning !== "listed") ||
        clause.recordDates.some(value => { const date = record(value, ["month", "day"]); return (date.day === "month_end") !== (clause.minimumShares !== null); })) throw new Error("掲載株主番号・名簿条件が不正です");
  }
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
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  const version = typeof raw === "object" && raw !== null && "version" in raw ? raw.version : undefined;
  const facts = record(raw,
    ["version", "sourceGroup", "holding", "holdingPeriods", "choice", "lottery", "application", "combination", "valueStatus", "qualifiedAmount", "valueReasons", "source", ...(version === 2 || version === 3 || version === 4 || version === 5 || version === 6 || version === 7 ? ["conditionStructure"] : [])]);
  const source = record(facts.source, ["listingUrl", "fetchedAt", "batchFetchedAt", "officialStatus", "officialUrl", "verifiedAt"]);
  if ((facts.version !== 1 && facts.version !== 2 && facts.version !== 3 && facts.version !== 4 && facts.version !== 5 && facts.version !== 6 && facts.version !== 7) || typeof facts.sourceGroup !== "string" || !/^[0-9a-f]{16}$/.test(facts.sourceGroup) ||
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
  if (facts.version === 2) {
    const structure = record(facts.conditionStructure, ["status", "rule", "sourceSha256", "ast", ...(
      typeof facts.conditionStructure === "object" && facts.conditionStructure !== null && "status" in facts.conditionStructure && facts.conditionStructure.status === "unparsed" ? ["reason"] : [])]);
    if (structure.rule !== "one-of-list-v1" || typeof structure.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(structure.sourceSha256)) throw new Error("条件構造の根拠が不正です");
    if (structure.status === "unparsed") {
      if (structure.ast !== null || !["malformed_heading", "additional_condition", "unsupported_grammar"].includes(structure.reason as string)) throw new Error("未解析条件の理由が不正です");
    } else if (structure.status === "literal_parsed") {
      const ast = record(structure.ast, ["take", "options"]);
      if (ast.take !== 1 || !Array.isArray(ast.options) || ast.options.length < 2 || ast.options.length > 8 ||
          facts.choice !== true || facts.holding !== false || facts.lottery !== false || facts.application !== false ||
          facts.combination !== "unverified" || facts.valueStatus !== "unresolved" || facts.qualifiedAmount !== null) throw new Error("選択条件の適用範囲が不正です");
      for (const [index, value] of ast.options.entries()) {
        const option = record(value, ["ordinal", "listedYen", "notation"]);
        if (option.ordinal !== index + 1 || typeof option.listedYen !== "number" || !Number.isSafeInteger(option.listedYen) || option.listedYen <= 0 ||
            !["相当", "分"].includes(option.notation as string)) throw new Error("掲載選択肢の値が不正です");
      }
    } else throw new Error("条件構造の状態が不正です");
  }
  if (facts.version === 3) {
    const structure = record(facts.conditionStructure, ["status", "rule", "sourceSha256", "applicability", "ast"]);
    const ast = record(structure.ast, ["holdingPeriod", "benefit"]);
    if (structure.status !== "literal_parsed" || structure.rule !== "single-holding-period-v1" ||
        typeof structure.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(structure.sourceSha256) || structure.applicability !== "unverified" ||
        facts.holding !== true || facts.choice !== false || facts.lottery !== false || facts.application !== false ||
        facts.combination !== "unverified" || JSON.stringify(facts.holdingPeriods) !== JSON.stringify([ast.holdingPeriod])) throw new Error("掲載保有期間の適用範囲が不正です");
    if (typeof ast.benefit !== "object" || ast.benefit === null || !("kind" in ast.benefit)) throw new Error("掲載特典の構造が不正です");
    if (ast.benefit.kind === "coupon") {
      const benefit = record(ast.benefit, ["kind", "listedYen", "notation"]);
      if (ast.holdingPeriod !== "半年以上" || benefit.notation !== "相当" || typeof benefit.listedYen !== "number" || !Number.isSafeInteger(benefit.listedYen) || benefit.listedYen <= 0 ||
          (facts.qualifiedAmount !== null && facts.qualifiedAmount !== benefit.listedYen)) throw new Error("掲載期間と円額の対応が不正です");
    } else if (ast.benefit.kind === "admission_tickets") {
      const benefit = record(ast.benefit, ["kind", "quantity", "unit"]);
      if (ast.holdingPeriod !== "1年以上" || benefit.unit !== "枚" || typeof benefit.quantity !== "number" || !Number.isSafeInteger(benefit.quantity) || benefit.quantity <= 0 ||
          facts.qualifiedAmount !== null || facts.valueStatus !== "unresolved") throw new Error("掲載期間と枚数の対応が不正です");
    } else throw new Error("掲載特典の種類が未対応です");
  }
  if (facts.version === 4) {
    const structure = record(facts.conditionStructure, ["status", "rule", "sourceSha256", "applicability", "ast"]);
    const ast = record(structure.ast, ["benefitKind", "tiers", "registryDefinition", "shipment"]);
    if (structure.status !== "literal_parsed" || structure.rule !== "holding-record-tiers-v1" ||
        typeof structure.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(structure.sourceSha256) || structure.applicability !== "unverified" ||
        ast.benefitKind !== "quo_card" || !Array.isArray(ast.tiers) || ast.tiers.length !== 2 ||
        facts.holding !== true || facts.choice !== false || facts.lottery !== false || facts.application !== false ||
        facts.combination !== "unverified" || facts.valueStatus !== "unresolved" || facts.qualifiedAmount !== null ||
        JSON.stringify(facts.valueReasons) !== JSON.stringify(["ambiguous_condition_tiers"])) throw new Error("掲載2期間の適用範囲が不正です");
    const below = record(ast.tiers[0], ["ordinal", "holdingPeriod", "listedYen", "notation"]);
    const above = record(ast.tiers[1], ["ordinal", "holdingPeriod", "listedYen", "notation"]);
    const period = typeof below.holdingPeriod === "string" ? /^([1-9][0-9]*)年未満$/.exec(below.holdingPeriod) : null;
    if (period === null || !Number.isSafeInteger(Number(period[1])) || above.holdingPeriod !== `${period[1]}年以上` ||
        below.ordinal !== 1 || above.ordinal !== 2 || below.listedYen === above.listedYen || below.notation !== above.notation ||
        ![below, above].every(tier => typeof tier.listedYen === "number" && Number.isSafeInteger(tier.listedYen) && tier.listedYen > 0 && ["相当", "分"].includes(tier.notation as string)) ||
        JSON.stringify(facts.holdingPeriods) !== JSON.stringify([below.holdingPeriod, above.holdingPeriod])) throw new Error("掲載2期間と円額の対応が不正です");
    const definition = record(ast.registryDefinition, ["continuousHoldingPeriod", "minimumEntries", "entryMeaning"]);
    const shipment = record(ast.shipment, ["month", "part", "frequency", "status"]);
    if (definition.continuousHoldingPeriod !== above.holdingPeriod || definition.entryMeaning !== "listed_or_recorded" ||
        typeof definition.minimumEntries !== "number" || !Number.isSafeInteger(definition.minimumEntries) || definition.minimumEntries <= 0 ||
        typeof shipment.month !== "number" || !Number.isInteger(shipment.month) || shipment.month < 1 || shipment.month > 12 ||
        !["上旬", "中旬", "下旬"].includes(shipment.part as string) || shipment.frequency !== "annual" || shipment.status !== "planned") throw new Error("名簿定義・発送予定が不正です");
  }
  if (facts.version === 5) {
    const structure = record(facts.conditionStructure, ["status", "rule", "sourceSha256", "applicability", "ast"]);
    const astValue = structure.ast;
    const hasRegistry = typeof astValue === "object" && astValue !== null && Object.hasOwn(astValue, "registry");
    const ast = record(astValue, ["tiers", "combinationClauses", "remainingConditionLines", ...(hasRegistry ? ["registry"] : [])]);
    if (structure.status !== "literal_extracted" || structure.rule !== "holding-tier-lines-v1" ||
        typeof structure.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(structure.sourceSha256) || structure.applicability !== "unverified" ||
        !Array.isArray(ast.tiers) || ast.tiers.length > 32 || (ast.tiers.length > 0 && facts.holding !== true) ||
        !Array.isArray(ast.combinationClauses) || ast.combinationClauses.length > 32 || (ast.tiers.length + ast.combinationClauses.length === 0 && !hasRegistry) ||
        typeof ast.remainingConditionLines !== "number" || !Number.isSafeInteger(ast.remainingConditionLines) || ast.remainingConditionLines < 0) throw new Error("掲載期間行の構造が不正です");
    for (const [index, value] of ast.tiers.entries()) {
      const tier = record(value, ["ordinal", "holdingPeriod", "listedYen", "notation"]);
      if (tier.ordinal !== index + 1 || typeof tier.holdingPeriod !== "string" || !facts.holdingPeriods.includes(tier.holdingPeriod) ||
          typeof tier.listedYen !== "number" || !Number.isSafeInteger(tier.listedYen) || tier.listedYen <= 0 ||
          !["相当", "分"].includes(tier.notation as string)) throw new Error("掲載期間行と円額の対応が不正です");
    }
    if (hasRegistry) {
      assertBenefitRegistryStructure(ast.registry, structure.sourceSha256 as string);
      if (facts.holding !== true) throw new Error("名簿条件と保有記載が一致しません");
    }
    for (const value of ast.combinationClauses) {
      const clause = record(value, ["scope", "counterpart", "allowed"]);
      if (clause.scope !== "coupon_use" || !["other_discount", "other_coupon"].includes(clause.counterpart as string) || typeof clause.allowed !== "boolean") throw new Error("券利用時の併用条件が不正です");
    }
  }
  if (facts.version === 6) {
    const structure = record(facts.conditionStructure, ["status", "rule", "sourceSha256", "applicability", "ast"]);
    const ast = record(structure.ast, ["recordDate", "minimumRegistryShares", "holdingPeriod"]);
    if (structure.status !== "literal_extracted" || structure.rule !== "initial-event-no-holding-period-v1" ||
        typeof structure.sourceSha256 !== "string" || !["51526c6d54f3796fc3cc76cc422a5622215cc17aa0857eb460f12cfd408dbc54", "335537d00f3bd5acb80b730c5042af98e16defead0f94e3cbe9c0b6285a98f73", "f705b2ae0ecae5f3f72a784cb4683bd5451922d942f4a1a38e15159b548fae3f"].includes(structure.sourceSha256) || structure.applicability !== "unverified" ||
        ast.recordDate !== "2026-09-30" || ast.minimumRegistryShares !== 200 || ast.holdingPeriod !== "not_required" ||
        facts.holding !== false || facts.holdingPeriods.length !== 0 || facts.lottery !== false || facts.application !== false ||
        facts.combination !== "unverified" || facts.valueStatus !== "unresolved" || facts.qualifiedAmount !== null ||
        source.listingUrl !== "https://minkabu.jp/stock/8336/yutai" || source.officialStatus !== "verified" || source.officialUrl !== "https://www.musashinobank.co.jp/ir/stock/benefits.html") throw new Error("初回単発の保有期間条件が不正です");
  }
  if (facts.version === 7) {
    const structure = record(facts.conditionStructure, ["status", "rule", "sourceSha256", "applicability", "ast"]);
    const ast = record(structure.ast, ["beforeHoldingPeriod", "fromRecordDate", "afterHoldingPeriods"]);
    if (structure.status !== "literal_extracted" || structure.rule !== "kawasaki-holding-period-transition-v1" ||
        typeof structure.sourceSha256 !== "string" || !["35f44c0d3fda10849092331a4435378e07aaeafb849a2fee17c96d5109607b0f", "5229034fc6002dacee2b1b2d7df2392755c2d6bbd74bb5a1e0eef112ec1eab48"].includes(structure.sourceSha256) ||
        structure.applicability !== "unverified" || ast.beforeHoldingPeriod !== "not_stated" || ast.fromRecordDate !== "2027-02-28" ||
        JSON.stringify(ast.afterHoldingPeriods) !== JSON.stringify(["半年以上", "3年以上"]) ||
        facts.holding !== true || JSON.stringify(facts.holdingPeriods) !== JSON.stringify(ast.afterHoldingPeriods) ||
        facts.choice !== false || facts.lottery !== false || facts.application !== false || facts.combination !== "unverified" ||
        facts.valueStatus !== "unresolved" || facts.qualifiedAmount !== null || source.listingUrl !== "https://minkabu.jp/stock/3045/yutai" ||
        source.officialStatus !== "verified" || source.officialUrl !== "https://kawasaki-corp.co.jp/2928/") throw new Error("拡充前後の保有期間条件が不正です");
  }
  if (code !== undefined && source.listingUrl !== `https://minkabu.jp/stock/${code}/yutai`) {
    throw new Error("公開条件の銘柄と掲載出典が一致しません");
  }
  return facts as PublicBenefitFacts;
}
