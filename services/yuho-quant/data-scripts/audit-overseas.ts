/** 旧全市場・上流取得付き監査は廃止。有限の保存原本監査へ明示誘導する。 */
console.error("overseas_audit_retired_use_saved_prepare_or_inspect: 旧 audit:overseas は廃止済みです。固定cohortと通信上限を指定し、pnpm backfill:overseas --saved-mode=prepare または --saved-mode=inspect を使用してください。引数は docs/test-logs/overseas-saved-cohort-20261017.md を参照してください。");
process.exitCode = 1;
