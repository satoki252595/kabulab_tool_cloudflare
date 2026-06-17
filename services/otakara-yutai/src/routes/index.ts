import { Hono } from "hono";
import { genreRoutes } from "./genres.js";
import { stockRoutes } from "./stocks.js";
import { adminRoutes } from "./admin.js";
import type { AppEnv } from "../types.js";

/** 全ルートを統合するルーター */
const routes = new Hono<AppEnv>();

routes.route("/genres", genreRoutes);
routes.route("/stocks", stockRoutes);
routes.route("/admin", adminRoutes);

export { routes };
