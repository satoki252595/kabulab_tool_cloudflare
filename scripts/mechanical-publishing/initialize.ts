/** Operator-only one-time transition. Never executed by Actions or the monthly scheduler. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initializePublishingFromMac } from "../biztag-local/runtime.js";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).join(" ") !== "--initialize-from-accepted-mac") throw new Error("明示移行引数が必要です");
    await initializePublishingFromMac();
    console.info("[mechanical-publishing] shared_writer_initialized old_journals_unchanged");
  } catch {
    console.error("[mechanical-publishing] initialization_stopped_no_retry"); process.exitCode = 1;
  }
}
