/**
 * moneyflow 取込 CLI (`scripts/moneyflow/ingest.ts`) に登録する Phase 2〜5 の
 * 取得元 (`MoneyflowSourceSpec`) の一覧。並び順が既定の実行順になる
 * (公表頻度の高いもの → 低いもの)。
 *
 * 各 spec の実装は `services/moneyflow/lib/adapters/<key>.ts`。
 */
import type { MoneyflowSourceSpec } from "../../services/moneyflow/lib/source-spec.js";

export const SPEC_SOURCES: readonly MoneyflowSourceSpec[] = [];
