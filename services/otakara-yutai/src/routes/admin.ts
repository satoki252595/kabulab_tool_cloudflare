import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  csvImportBodySchema,
  jsonImportBodySchema,
} from "../validators/yutai-scraper.js";
import { parseYutaiCSV } from "../services/yutai-data-provider.js";
import { importYutaiData } from "../services/yutai-scraper.js";
import type { AppEnv } from "../types.js";
import type { ImportResult } from "../services/yutai-scraper.js";

/**
 * 管理者ルート
 * 優待データのインポートを行うエンドポイント
 */
export const adminRoutes = new Hono<AppEnv>();

/** 最後のインポート結果を保持する（インメモリ） */
let lastImportResult: (ImportResult & { importedAt: string }) | null = null;

/**
 * POST /admin/import/csv
 * CSVデータをインポートする
 */
adminRoutes.post(
  "/import/csv",
  zValidator("json", csvImportBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "Validation Error",
          message: result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(", "),
        },
        400,
      );
    }
  }),
  async (c) => {
    const { csv } = c.req.valid("json");
    const db = c.get("db");

    const data = parseYutaiCSV(csv);

    if (data.length === 0) {
      return c.json(
        {
          error: "Import Error",
          message: "CSVデータにインポート可能なデータがありません",
        },
        400,
      );
    }

    const result = await importYutaiData(db, data);

    lastImportResult = {
      ...result,
      importedAt: new Date().toISOString(),
    };

    return c.json(result, 201);
  },
);

/**
 * POST /admin/import/json
 * JSONデータをインポートする
 */
adminRoutes.post(
  "/import/json",
  zValidator("json", jsonImportBodySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "Validation Error",
          message: result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(", "),
        },
        400,
      );
    }
  }),
  async (c) => {
    const { data } = c.req.valid("json");
    const db = c.get("db");

    const result = await importYutaiData(db, data);

    lastImportResult = {
      ...result,
      importedAt: new Date().toISOString(),
    };

    return c.json(result, 201);
  },
);

/**
 * GET /admin/import/status
 * 最後のインポート結果を返す
 */
adminRoutes.get("/import/status", (c) => {
  if (!lastImportResult) {
    return c.json(
      {
        error: "Not Found",
        message: "まだインポートが実行されていません",
      },
      404,
    );
  }

  return c.json(lastImportResult);
});
