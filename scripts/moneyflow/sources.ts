/**
 * moneyflow 取込 CLI (`scripts/moneyflow/ingest.ts`) に登録する Phase 2〜5 の
 * 取得元 (`MoneyflowSourceSpec`) の一覧。並び順が既定の実行順になる
 * (公表頻度の高いもの → 低いもの。同じ頻度なら要件 R2→R3→R4 の順)。
 *
 * 各 spec の実装は `services/moneyflow/lib/adapters/<key>.ts`。
 * 取得元の一覧・頻度・行数は docs/moneyflow.md「Phase 2〜5 取得元」節。
 */
import type { MoneyflowSourceSpec } from "../../services/moneyflow/lib/source-spec.js";
import { bisBankingSpec } from "../../services/moneyflow/lib/adapters/bis-banking.js";
import { bojFlowOfFundsSpec } from "../../services/moneyflow/lib/adapters/boj-flow-of-funds.js";
import { bopRegionalSpec } from "../../services/moneyflow/lib/adapters/bop-regional.js";
import { cftcCotJpySpec } from "../../services/moneyflow/lib/adapters/cftc-cot-jpy.js";
import { coingeckoGlobalSpec } from "../../services/moneyflow/lib/adapters/coingecko-global.js";
import { ffajOtcFxSpec } from "../../services/moneyflow/lib/adapters/ffaj-otc-fx.js";
import { globalIndicesSpec } from "../../services/moneyflow/lib/adapters/global-indices.js";
import {
  imajFundFlowsReitSpec,
  imajFundFlowsSpec,
} from "../../services/moneyflow/lib/adapters/imaj-fund-flows.js";
import { imfCpisSpec } from "../../services/moneyflow/lib/adapters/imf-cpis.js";
import {
  jpxDerivativesInvestorFuturesOiSpec,
  jpxDerivativesInvestorWeeklySpec,
} from "../../services/moneyflow/lib/adapters/jpx-derivatives-investor.js";
import {
  JPX_INVESTOR_EQUITY_MONTHLY_SPEC,
  JPX_INVESTOR_EQUITY_WEEKLY_SPEC,
} from "../../services/moneyflow/lib/adapters/jpx-investor-equity.js";
import {
  jpxInvestorEtfSpec,
  jpxInvestorReitSpec,
} from "../../services/moneyflow/lib/adapters/jpx-investor-etf-reit.js";
import { jsdaBondsSpec } from "../../services/moneyflow/lib/adapters/jsda-bonds.js";
import { marginSectorSpec } from "../../services/moneyflow/lib/adapters/jpx-margin-sector.js";
import { jvceaCryptoSpec } from "../../services/moneyflow/lib/adapters/jvcea-crypto.js";
import {
  mofPortfolioFlowsMonthlySpec,
  mofPortfolioFlowsWeeklySpec,
} from "../../services/moneyflow/lib/adapters/mof-portfolio-flows.js";
import {
  tfxClick365CfdAnnualSpec,
  tfxClick365CfdSpec,
  tfxClick365FxAnnualSpec,
  tfxClick365FxSpec,
} from "../../services/moneyflow/lib/adapters/tfx-click365.js";
import { worldbankMarketcapSpec } from "../../services/moneyflow/lib/adapters/worldbank-marketcap.js";

export const SPEC_SOURCES: readonly MoneyflowSourceSpec[] = [
  // 日次
  coingeckoGlobalSpec,
  marginSectorSpec,
  // 週次
  JPX_INVESTOR_EQUITY_WEEKLY_SPEC,
  mofPortfolioFlowsWeeklySpec,
  jpxDerivativesInvestorWeeklySpec,
  jpxDerivativesInvestorFuturesOiSpec,
  cftcCotJpySpec,
  globalIndicesSpec,
  // 月次
  JPX_INVESTOR_EQUITY_MONTHLY_SPEC,
  jpxInvestorEtfSpec,
  jpxInvestorReitSpec,
  mofPortfolioFlowsMonthlySpec,
  imajFundFlowsSpec,
  imajFundFlowsReitSpec,
  jsdaBondsSpec,
  ffajOtcFxSpec,
  tfxClick365FxSpec,
  tfxClick365CfdSpec,
  jvceaCryptoSpec,
  // 四半期・半期・年次
  bopRegionalSpec,
  bojFlowOfFundsSpec,
  bisBankingSpec,
  imfCpisSpec,
  tfxClick365FxAnnualSpec,
  tfxClick365CfdAnnualSpec,
  worldbankMarketcapSpec,
];
