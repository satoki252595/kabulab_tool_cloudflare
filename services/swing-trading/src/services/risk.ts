/**
 * リスク管理計算機 — Notion ガイド「リスク管理&資金管理編」の純粋実装
 *
 * 2%ルールに基づくポジションサイズ計算と、保有ポジションのヒート計算を提供する。
 * DB アクセス無し。ルートから `POST /api/risk/calc` で呼ばれる。
 */

/** ポジションサイズ計算機への入力 */
export interface PositionSizeInput {
  /** 口座資金 (円) */
  accountYen: number;
  /** 1 トレードあたりの許容リスク比率 (0.01=1%, 0.02=2%) */
  riskPct: number;
  /** エントリー予定価格 (円/株) */
  entryPrice: number;
  /** ロスカット価格 (円/株) */
  stopLoss: number;
  /** 第 1 利確目標価格 (円/株) — オプション */
  target1?: number;
}

/** ポジションサイズ計算機の出力 */
export interface PositionSizeResult {
  /** 最大許容損失額 (円) = accountYen × riskPct */
  maxRiskYen: number;
  /** 1 株あたり損失幅 (円) = |entryPrice - stopLoss| */
  riskPerShare: number;
  /** 推奨株数 (単元 100 株で切り下げ) */
  shares: number;
  /** 実際のポジション金額 (円) = shares × entryPrice */
  positionValue: number;
  /** 実際のロスカット損失額 (円) = shares × riskPerShare */
  actualRiskYen: number;
  /** リスクリワード比 — target1 指定時のみ */
  riskRewardRatio: number | null;
  /** 必要資金が口座残高を超えるか */
  exceedsAccount: boolean;
  /** 警告メッセージ (入力不正 / RR 不足など) */
  warnings: string[];
}

/**
 * Notion ガイドのポジションサイジング計算:
 *
 *   ポジションサイズ (株数) = リスク許容額 ÷ 1株あたりのリスク幅
 *   リスク許容額         = 口座資金 × リスク%
 *   1株あたりリスク幅    = エントリー価格 − ロスカット価格
 *
 *   例) 口座 500 万、エントリー 2,000 円、ロスカ 1,940 円 (2% ルール)
 *       リスク許容額 = 10 万円、リスク幅 = 60 円 → 10 万 ÷ 60 = 1,666 株
 *       単元 100 株切り下げで **1,600 株**
 *
 * @throws 入力が無効な場合 (負の値、entry = stop 等)
 */
export function calcPositionSize(input: PositionSizeInput): PositionSizeResult {
  const warnings: string[] = [];

  if (!Number.isFinite(input.accountYen) || input.accountYen <= 0) {
    throw new Error("口座資金は正の数値を入力してください");
  }
  if (!Number.isFinite(input.riskPct) || input.riskPct <= 0 || input.riskPct > 0.1) {
    throw new Error("リスク%は 0 < riskPct ≤ 10% の範囲で入力してください");
  }
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new Error("エントリー価格は正の数値を入力してください");
  }
  if (!Number.isFinite(input.stopLoss) || input.stopLoss <= 0) {
    throw new Error("ロスカット価格は正の数値を入力してください");
  }
  if (input.entryPrice === input.stopLoss) {
    throw new Error("エントリー価格とロスカット価格が同じです");
  }

  const maxRiskYen = input.accountYen * input.riskPct;
  const riskPerShare = Math.abs(input.entryPrice - input.stopLoss);
  // 100 株単元で切り下げ
  const rawShares = maxRiskYen / riskPerShare;
  const shares = Math.floor(rawShares / 100) * 100;
  const positionValue = shares * input.entryPrice;
  const actualRiskYen = shares * riskPerShare;

  let riskRewardRatio: number | null = null;
  if (input.target1 !== undefined && Number.isFinite(input.target1) && input.target1 > 0) {
    const reward = Math.abs(input.target1 - input.entryPrice);
    if (riskPerShare > 0) {
      riskRewardRatio = reward / riskPerShare;
      if (riskRewardRatio < 2) {
        warnings.push(
          `リスクリワード比 ${riskRewardRatio.toFixed(2)} は 2.0 未満です。ガイドの「RR 1:2 以上」を満たしません`
        );
      }
    }
  }

  const exceedsAccount = positionValue > input.accountYen;
  if (exceedsAccount) {
    warnings.push(
      "必要ポジション金額が口座資金を超えています。信用取引前提か、銘柄を変更してください"
    );
  }

  if (shares === 0) {
    warnings.push(
      "計算結果が 0 株です。リスク幅が大きすぎるか、口座資金/リスク%が小さすぎます"
    );
  }

  return {
    maxRiskYen,
    riskPerShare,
    shares,
    positionValue,
    actualRiskYen,
    riskRewardRatio,
    exceedsAccount,
    warnings,
  };
}

// -----------------------------------------------------------------------------
// ポートフォリオ・ヒート (参考表示用の純関数)
// -----------------------------------------------------------------------------

/**
 * ドローダウン % から推奨モードとリスク%上限を返す
 *
 * Notion ガイド「ドローダウン段階別対応」表の実装。
 * 保有ポジションの累積値は扱わない (それは手動入力 or ポートフォリオ DB が必要)。
 */
export interface DrawdownMode {
  label: "通常" | "警戒" | "防御" | "最小" | "停止";
  maxRiskPct: number;
  maxHeatPct: number;
}

export function drawdownMode(drawdownPct: number): DrawdownMode {
  if (drawdownPct < 5) return { label: "通常", maxRiskPct: 2, maxHeatPct: 6 };
  if (drawdownPct < 10) return { label: "警戒", maxRiskPct: 1.5, maxHeatPct: 4.5 };
  if (drawdownPct < 15) return { label: "防御", maxRiskPct: 1, maxHeatPct: 3 };
  if (drawdownPct < 20) return { label: "最小", maxRiskPct: 0.5, maxHeatPct: 1.5 };
  return { label: "停止", maxRiskPct: 0, maxHeatPct: 0 };
}
