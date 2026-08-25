import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
export * as schema from "./schema/index.js";
export * from "./schema/index.js";

export type BrickDb = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return drizzle(pool);
}
