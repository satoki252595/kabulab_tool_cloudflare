import { Hono } from "hono";
import type { AppEnv } from "../types.js";

/**
 * ジャンルルート
 * GET /genres — 全ジャンル一覧を返す
 */
export const genreRoutes = new Hono<AppEnv>();

genreRoutes.get("/", async (c) => {
  const db = c.get("db");
  const genres = await db.query.yutaiGenres.findMany();

  return c.json({
    genres: genres.map((g) => ({
      id: g.id,
      name: g.name,
      slug: g.slug,
      description: g.description,
    })),
  });
});
