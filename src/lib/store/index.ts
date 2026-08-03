import type { Store } from "../types";
import { sqliteStore } from "./sqlite";
import { pgStore } from "./postgres";

/**
 * Postgres when DATABASE_URL is set (hosted/serverless deployments — Vercel's
 * filesystem doesn't persist), local SQLite otherwise (zero-config dev).
 */
export const store: Store = process.env.DATABASE_URL ? pgStore : sqliteStore;
