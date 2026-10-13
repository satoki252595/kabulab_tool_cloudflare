import { isAbsolute } from "node:path";

function requiredPath(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === "" || !isAbsolute(value)) {
    throw new Error(`環境変数 ${key} に絶対パスを設定してください。.env を確認してください。`);
  }
  return value;
}

export const clefEnv = {
  python: () => requiredPath("CLEF_PYTHON"),
  modelPath: () => requiredPath("CLEF_MODEL_PATH"),
};
