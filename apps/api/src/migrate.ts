import { runMigrations } from "./config/migrator.js";

/** `node dist/migrate.js` — 수동/CI 실행용. 부팅 시에는 자동으로 실행된다. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const result = await runMigrations(url, process.env.BRICK_MIGRATIONS_DIR ?? "migrations");
  if (result.alreadyUpToDate) console.log("[migrate] already up to date");
  else result.applied.forEach((f) => console.log(`[migrate] applied ${f}`));
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
