/** Finite source-only order repair. Saved cohort version 2/kind orders is mandatory. */
import "dotenv/config";
import assert from "node:assert/strict";
import {
  parseSavedOverseasOptions,
  runSavedOrders,
} from "./lib/saved-overseas-backfill.js";

const options = parseSavedOverseasOptions(process.argv.slice(2));
assert(
  options,
  "orders requires an explicit saved cohort and finite prepare/apply/inspect arguments",
);
await runSavedOrders(options, process.cwd());
