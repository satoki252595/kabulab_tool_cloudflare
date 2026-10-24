/** Operator-only one-time transition. Never executed by Actions or the monthly scheduler. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fencePublishingInitializationFromMac, initializePublishingFromMac } from "../biztag-local/runtime.js";

export function initializationMode(args: string[]): { kind: "normal" } | { kind: "fence"; failedLogSha256: string } {
  if (args.length === 1 && args[0] === "--initialize-from-accepted-mac") return { kind: "normal" };
  if (args.length === 2 && args[0] === "--fence-unconfirmed-initialization" && /^--failed-log-sha256=[a-f0-9]{64}$/.test(args[1])) {
    return { kind: "fence", failedLogSha256: args[1].slice("--failed-log-sha256=".length) };
  }
  throw new Error("通常移行か失敗ログSHA付きの明示fence引数が必要です");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = initializationMode(process.argv.slice(2));
    if (mode.kind === "normal") {
      await initializePublishingFromMac();
      console.info("[mechanical-publishing] shared_writer_initialized old_journals_unchanged");
    } else {
      await fencePublishingInitializationFromMac(mode.failedLogSha256);
      console.info("[mechanical-publishing] shared_writer_fenced old_unknown_preserved");
    }
  } catch {
    console.error("[mechanical-publishing] initialization_stopped_no_retry"); process.exitCode = 1;
  }
}
