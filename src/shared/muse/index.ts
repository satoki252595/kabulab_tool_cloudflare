/**
 * muse (ローカル CLI, Meta muse-spark-1.3-contributor) クライアントの公開窓口。
 * jev の代替判定モデルとして使う呼び出し側はここから import する。
 */
export { museEnv } from "./env.js";
export {
  MUSE_MODEL,
  MUSE_REASONING_EFFORT,
  MuseUnavailableError,
  createMuseClient,
} from "./client.js";
export type { CreateMuseClientOptions } from "./client.js";
