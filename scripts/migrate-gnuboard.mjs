#!/usr/bin/env node
/**
 * 그누보드5 덤프 이전 CLI.
 *
 * 관리자 화면에서도 할 수 있지만(관리자 → 이전), 덤프가 64MB를 넘으면
 * HTTP 본문으로 보낼 수 없다. 십만 건짜리 게시판은 흔하다.
 * 그래서 서버에서 직접 실행하는 경로를 둔다.
 *
 * 사용법:
 *   # 리허설 — 아무것도 쓰지 않고 무엇이 옮겨질지 본다
 *   DATABASE_URL=... node scripts/migrate-gnuboard.mjs --dump backup.sql
 *
 *   # 실제 이전
 *   DATABASE_URL=... node scripts/migrate-gnuboard.mjs --dump backup.sql --run
 *
 *   # 레벨 경계 조정 · 게시판 선택
 *   ... --run --admin-from 9 --manager-from 6 --boards notice,free
 *
 * 반드시 리허설을 먼저 보세요. 이전은 되돌리기 어렵습니다.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const dumpPath = arg("dump");
if (!dumpPath) {
  console.error("사용법: node scripts/migrate-gnuboard.mjs --dump <파일> [--run]");
  console.error("자세한 내용: docs/migrate-gnuboard.md");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL 환경변수가 필요합니다.");
  process.exit(1);
}

// 빌드된 API 코드를 재사용한다 — 이전 로직을 두 벌 두면 반드시 어긋난다
const dist = resolve(ROOT, "apps/api/dist/modules/migrate");
const { MigrateService } = await import(`${dist}/migrate.service.js`).catch(() => {
  console.error("apps/api 를 먼저 빌드하세요: pnpm build");
  process.exit(1);
});
const { drizzle } = await import(resolve(ROOT, "apps/api/node_modules/drizzle-orm/node-postgres/index.js"));
const pgmod = await import(resolve(ROOT, "apps/api/node_modules/pg/lib/index.js"));

const pool = new pgmod.default.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// PluginLoaderService 는 경고 문구를 만드는 데만 쓰인다.
// CLI 에서는 플러그인을 로드하지 않으므로 빈 목록을 넘긴다 —
// 대신 테이블 존재 확인(to_regclass)이 실제 판단을 한다.
const service = new MigrateService(db, { dataErasers: [], sitemapSources: [] });

const dump = readFileSync(resolve(process.cwd(), dumpPath), "utf8");
const levelMapping = {
  adminFrom: Number(arg("admin-from", 10)),
  managerFrom: Number(arg("manager-from", 8)),
};

try {
  if (!flag("run")) {
    console.log("▶ 리허설 (아무것도 쓰지 않습니다)\n");
    const r = await service.analyze(dump, levelMapping);
    console.log(`접두어: ${r.prefix}  (테이블 ${r.tableCount}개)`);
    console.log(`\n회원 ${r.members.total}명`);
    console.log(`  이메일 있음 ${r.members.withEmail} · 없음 ${r.members.withoutEmail}`);
    for (const l of r.levels) {
      console.log(`  레벨 ${String(l.level).padStart(2)} → ${l.role.padEnd(7)} ${l.count}명`);
    }
    if (r.members.conflicts.length) {
      console.log(`  이메일 충돌 ${r.members.conflicts.length}건: ${r.members.conflicts.slice(0, 5).join(", ")}`);
    }
    console.log(`\n게시판 ${r.boards.length}개`);
    for (const b of r.boards) {
      console.log(
        `  ${b.table.padEnd(16)} → /${b.slug.padEnd(16)} ` +
        `글 ${String(b.posts).padStart(6)} · 댓글 ${String(b.comments).padStart(6)} ` +
        `· 읽기 ${b.readRole}/쓰기 ${b.writeRole}${b.hasData ? "" : "  (글 테이블 없음)"}`,
      );
    }
    console.log(`\n포인트: ${r.points.members}명 · 합계 ${r.points.total.toLocaleString("ko-KR")}점`);

    if (r.shop) {
      console.log(`\n영카트 (쇼핑몰)`);
      console.log(`  분류 ${r.shop.categories}개`);
      console.log(
        `  상품 ${r.shop.products}개 (판매중 ${r.shop.productStatus.selling} · ` +
        `품절 ${r.shop.productStatus.soldout} · 숨김 ${r.shop.productStatus.hidden})`,
      );
      console.log(`  옵션 ${r.shop.options}개`);
      console.log(`  주문 ${r.shop.orders}건 · 항목 ${r.shop.orderItems}개`);
      for (const st of r.shop.orderStatus) {
        console.log(`    ${st.from.padEnd(10)} → ${st.to.padEnd(10)} ${st.count}건`);
      }
      console.log(`  매출 ${r.shop.revenue.toLocaleString("ko-KR")}원 (취소·반품 제외)`);
    }
    if (r.skipped.length) {
      console.log("\n옮기지 않는 것:");
      for (const s of r.skipped) console.log(`  - ${s}`);
    }
    if (r.warnings.length) {
      console.log("\n⚠ 확인해주세요:");
      for (const w of r.warnings) console.log(`  - ${w}`);
    }
    console.log("\n실제로 옮기려면 --run 을 붙이세요.");
  } else {
    console.log("▶ 이전을 시작합니다\n");
    const r = await service.run(dump, {
      prefix: arg("prefix", ""),
      levelMapping,
      boards: (arg("boards", "") || "").split(",").map((x) => x.trim()).filter(Boolean),
      members: !flag("no-members"),
      points: !flag("no-points"),
      shop: !flag("no-shop"),
      strictEmail: false,
    });
    console.log(`회원   생성 ${r.members.created} · 건너뜀 ${r.members.skipped}`);
    console.log(`게시판 생성 ${r.boards.created} · 건너뜀 ${r.boards.skipped}`);
    console.log(`글     ${r.posts.created}`);
    console.log(`댓글   ${r.comments.created}`);
    console.log(`포인트 ${r.points.granted}명 · ${r.points.total.toLocaleString("ko-KR")}점`);
    if (r.shop.products || r.shop.orders) {
      console.log(
        `상품   ${r.shop.products} · 옵션 ${r.shop.options} · 분류 ${r.shop.categories}`,
      );
      console.log(`주문   ${r.shop.orders} · 항목 ${r.shop.orderItems}`);
    }
    if (r.warnings.length) {
      console.log("\n⚠ 확인해주세요:");
      for (const w of r.warnings) console.log(`  - ${w}`);
    }
    console.log(`\n완료 (${(r.durationMs / 1000).toFixed(1)}초)`);
    console.log("회원은 **그누보드에서 쓰던 비밀번호로 그대로 로그인**합니다.");
  }
} catch (err) {
  console.error(`\n실패: ${err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
