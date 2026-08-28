#!/usr/bin/env node
/**
 * create-brick-plugin — Brick 플러그인 개발 템플릿 생성기.
 *
 *   npm create brick-plugin my-plugin
 *   npx create-brick-plugin my-plugin --display "내 플러그인"
 *
 * 만들어지는 것은 **동작하는 예제**다 — 빈 껍데기가 아니다. 방명록 하나가
 * 라우트·블록·관리 화면·마이그레이션·개인정보 파기까지 Brick 플러그인의
 * 모든 계약을 한 번씩 쓴다. 지우면서 배우는 것이 빈 파일을 채우는 것보다
 * 빠르다.
 *
 * 의존성 규칙 (README 에도 있다):
 *  - @brick/plugin-sdk · drizzle-orm · uuidv7 은 Brick 이 함께 설치하므로
 *    번들하지 않는다. 특히 **drizzle-orm 을 번들하면 안 된다** — 서버와 다른
 *    사본의 sql 객체는 서버가 알아보지 못한다.
 *  - 그 외의 의존성은 dist 에 번들해야 한다 (서버는 npm install 을 하지 않는다).
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// ── 인자 파싱 (의존성 없이) ─────────────────────────
const args = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  } else {
    positional.push(args[i]);
  }
}

const name = positional[0];
const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
if (!name || !NAME_RE.test(name)) {
  console.error(`사용법: create-brick-plugin <이름> [--display "표시 이름"] [--dir <경로>]

이름은 영문 소문자로 시작, 소문자/숫자/하이픈 2~41자입니다. (예: my-guestbook)
플러그인 주소(/api/plugins/<이름>/...)와 설치 폴더 이름이 됩니다.`);
  process.exit(1);
}

const display = typeof flags.display === "string" ? flags.display : name;
const targetDir = resolve(typeof flags.dir === "string" ? flags.dir : ".", name);
if (existsSync(targetDir)) {
  console.error(`이미 존재하는 경로입니다: ${targetDir}`);
  process.exit(1);
}

/** 테이블 접두사 — SQL 식별자에 하이픈은 못 쓴다 */
const table = name.replace(/-/g, "_");

/**
 * Brick 모노레포 안에서 실행되면 workspace 프로토콜을 쓴다 —
 * plugins/ 아래에 만들면 pnpm 워크스페이스가 바로 인식한다.
 * 밖이면 npm 레지스트리 버전을 쓴다 (SDK 가 공개된 뒤 유효하다).
 */
function insideBrickRepo(dir) {
  let cur = dir;
  for (let i = 0; i < 8; i++) {
    const ws = join(cur, "pnpm-workspace.yaml");
    if (existsSync(ws) && readFileSync(ws, "utf8").includes("plugins/*")) return true;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}
const inRepo = insideBrickRepo(targetDir);
const dep = (v) => (inRepo ? "workspace:*" : v);

// ── 템플릿 ──────────────────────────────────────────

const manifest = `{
  "name": "${name}",
  "version": "0.1.0",
  "displayName": "${display}",
  "description": "${display} — create-brick-plugin 으로 시작한 플러그인",
  "author": "",
  "brickVersion": ">=0.0.1",
  "entry": "dist/index.js",
  "migrations": "migrations"
}
`;

const pkg = `{
  "name": "brick-plugin-${name}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@brick/plugin-sdk": "${dep("^0.1.0")}",
    "drizzle-orm": "^0.45.2",
    "uuidv7": "^1.2.1"
  },
  "devDependencies": {
    "typescript": "^5.7.3"
  }
}
`;

const tsconfig = inRepo
  ? `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "tsBuildInfoFile": "dist/.tsbuildinfo" },
  "include": ["src"]
}
`
  : `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "tsBuildInfoFile": "dist/.tsbuildinfo",
    "incremental": true
  },
  "include": ["src"]
}
`;

const migration = `-- ${display} — 방명록 예제 테이블
--
-- 마이그레이션은 플러그인 활성화 때 파일명 순서로 한 번씩 적용됩니다.
-- 이미 배포한 파일은 고치지 말고 새 번호를 추가하세요 — 적용 이력은
-- 파일명으로 기록됩니다.
CREATE TABLE IF NOT EXISTS ${table}_entries (
  id uuid PRIMARY KEY,
  /** 탈퇴한 회원의 글이 남도록 SET NULL — 파기는 data eraser 가 한다 */
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name varchar(50) NOT NULL,
  message varchar(500) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${table}_entries_created_idx
  ON ${table}_entries (created_at DESC);
`;

const src = `import { definePlugin, escapeHtml, type AdminResource } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

/**
 * ${display} — 방명록 예제.
 *
 * 이 파일 하나가 Brick 플러그인의 계약을 전부 한 번씩 씁니다:
 *   라우트(registerRoute) · 블록(registerBlock) · 관리 화면(registerAdminResource)
 *   · 개인정보 파기(registerDataEraser) · 마이그레이션(migrations/)
 *
 * 규칙:
 *  - 원자성이 필요하면 ctx.db.transaction() — execute("BEGIN") 은 커넥션 풀에서
 *    조용히 깨집니다.
 *  - 사용자 입력을 HTML 에 넣을 때는 반드시 escapeHtml().
 *  - 오류는 status 있는 예외로 — 코어가 HTTP 응답으로 바꿉니다.
 */

class PluginError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const ENTRIES_RESOURCE: AdminResource = {
  name: "entries",
  title: "${display}",
  itemLabel: "글",
  basePath: "/admin/entries",
  can: { create: false, update: false, delete: true },
  description: "방명록에 남겨진 글입니다.",
  fields: [
    { name: "author_name", label: "작성자", type: "text", readOnly: true, inList: true },
    { name: "message", label: "내용", type: "textarea", readOnly: true, inList: true },
    { name: "created_at", label: "작성일", type: "date", readOnly: true, inList: true },
  ],
};

export default definePlugin(async (ctx) => {
  const db = ctx.db;

  const requireAdmin = (req: { user: { role: string } | null }) => {
    if (req.user?.role !== "admin") throw new PluginError(403, "권한이 없습니다.");
  };

  // ── 공개 라우트: /api/plugins/${name}/entries ──────
  // 마지막 인자(docs)는 선택이다 — /api/docs 의 API 문서에 한 줄 요약으로 실린다.
  ctx.registerRoute("GET", "/entries", async () => {
    const { rows } = await db.execute(sql\`
      SELECT id, author_name, message, created_at
      FROM ${table}_entries ORDER BY created_at DESC LIMIT 50
    \`);
    return { items: rows };
  }, { summary: "최근 방명록 글" });

  ctx.registerRoute("POST", "/entries", async (req) => {
    if (!req.user) throw new PluginError(401, "로그인이 필요합니다.");
    const body = req.body as { message?: unknown };
    const message = String(body?.message ?? "").trim();
    if (!message || message.length > 500) {
      throw new PluginError(400, "내용은 1~500자로 입력해주세요.");
    }
    const id = uuidv7();
    await db.execute(sql\`
      INSERT INTO ${table}_entries (id, user_id, author_name, message)
      VALUES (\${id}, \${req.user.id}::uuid, \${req.user.displayName ?? "회원"}, \${message})
    \`);
    return { id };
  });

  // ── 관리자 라우트 (선언한 리소스의 백엔드) ─────────
  ctx.registerRoute("GET", "/admin/entries", async (req) => {
    requireAdmin(req);
    const { rows } = await db.execute(sql\`
      SELECT id, author_name, message, created_at
      FROM ${table}_entries ORDER BY created_at DESC LIMIT 100
    \`);
    return { items: rows, total: rows.length };
  });

  ctx.registerRoute("DELETE", "/admin/entries/:id", async (req) => {
    requireAdmin(req);
    await db.execute(sql\`DELETE FROM ${table}_entries WHERE id = \${req.params.id}::uuid\`);
    await ctx.cache.invalidateTag("pages"); // 블록이 그린 화면을 새로 그리게
    return { ok: true };
  });

  ctx.registerAdminResource(ENTRIES_RESOURCE);

  // ── 블록: 페이지 빌더에서 "${display}" 로 보인다 ───
  ctx.registerBlock({
    name: "entries",
    displayName: "${display}",
    async render() {
      const { rows } = await db.execute(sql\`
        SELECT author_name, message, created_at
        FROM ${table}_entries ORDER BY created_at DESC LIMIT 10
      \`);
      if (!rows.length) return \`<div class="brick-empty">\${escapeHtml(ctx.t("entries.empty"))}</div>\`;
      const items = rows
        .map((r) => \`<li><strong>\${escapeHtml(String(r.author_name))}</strong> — \${escapeHtml(String(r.message))}</li>\`)
        .join("");
      return \`<ul class="${name}-entries">\${items}</ul>\`;
    },
  });

  // ── 개인정보 파기: 회원 탈퇴·파기 요청 때 코어가 부른다 ──
  ctx.registerDataEraser({
    label: "${display}",
    // 탈퇴 트랜잭션 안에서 호출된다 — 반드시 넘어온 tx 를 쓴다.
    // ctx.db 를 쓰면 트랜잭션 밖으로 나가서, 탈퇴가 롤백돼도 글만 지워진다.
    async erase({ tx, userId }) {
      const { rows } = await tx.execute(sql\`
        UPDATE ${table}_entries
        SET user_id = NULL, author_name = '탈퇴한 회원'
        WHERE user_id = \${userId}::uuid RETURNING id
      \`);
      return rows.length ? [\`방명록 \${rows.length}건 익명화\`] : [];
    },
  });

  ctx.logger.log("활성화됨");
  return {};
});
`;

const readme = `# ${display}

\`create-brick-plugin\` 으로 시작한 Brick 플러그인입니다.
방명록 예제가 라우트·블록·관리 화면·마이그레이션·개인정보 파기를 전부
한 번씩 씁니다 — 지우면서 바꿔 나가세요.

## 빌드와 설치

\`\`\`bash
npm install
npm run build
# dist/ · migrations/ · brick.plugin.json 을 ZIP 으로 묶습니다
zip -r ${name}.zip brick.plugin.json package.json migrations locales dist
\`\`\`

관리자 → 플러그인 → ZIP 업로드 → 활성화. 그러면:

- \`GET/POST /api/plugins/${name}/entries\` 라우트가 열리고
- 페이지 빌더에 **${display}** 블록이 나타나고
- 관리자 사이드바에 **${display}** 메뉴가 생기고
- \`migrations/\` 가 순서대로 적용됩니다.

## 의존성 규칙

- \`@brick/plugin-sdk\` · \`drizzle-orm\` · \`uuidv7\` 은 Brick 이 함께
  설치하므로 **번들하지 않습니다.**
- 특히 **drizzle-orm 을 번들하면 안 됩니다** — 서버와 다른 사본의 \`sql\`
  객체는 서버가 알아보지 못합니다.
- 그 외의 의존성을 쓰려면 dist 에 번들하세요(esbuild 등). 서버는 절대
  \`npm install\` 을 하지 않습니다.

## 꼭 지킬 것

- 원자성이 필요하면 \`ctx.db.transaction()\` — \`execute("BEGIN")\` 은
  커넥션 풀에서 조용히 깨집니다.
- 사용자 입력을 HTML 에 넣을 때는 반드시 \`escapeHtml()\`.
- 이미 배포한 마이그레이션 파일은 고치지 말고 새 번호를 추가하세요.
- 회원 데이터를 저장하면 \`registerDataEraser\` 로 파기 방법을 등록하세요 —
  탈퇴·파기 요청 때 코어가 호출합니다.

전체 계약은 Brick 저장소의 \`docs/plugin-development.md\` 를 보세요.
`;

const gitignore = `node_modules/
dist/
`;

// 다국어 — 블록·라우트가 그리는 공개 문자열은 locales/ 카탈로그에 둔다.
// ctx.t("entries.empty") 가 사이트 언어(site.locale)에 맞는 문구를 돌려준다.
const localeKo = `{
  "entries.empty": "아직 글이 없습니다."
}
`;
const localeEn = `{
  "entries.empty": "No entries yet."
}
`;

// ── 쓰기 ────────────────────────────────────────────
mkdirSync(join(targetDir, "src"), { recursive: true });
mkdirSync(join(targetDir, "migrations"), { recursive: true });
mkdirSync(join(targetDir, "locales"), { recursive: true });
writeFileSync(join(targetDir, "brick.plugin.json"), manifest);
writeFileSync(join(targetDir, "package.json"), pkg);
writeFileSync(join(targetDir, "tsconfig.json"), tsconfig);
writeFileSync(join(targetDir, "migrations", "0001_init.sql"), migration);
writeFileSync(join(targetDir, "src", "index.ts"), src);
writeFileSync(join(targetDir, "README.md"), readme);
writeFileSync(join(targetDir, ".gitignore"), gitignore);
writeFileSync(join(targetDir, "locales", "ko.json"), localeKo);
writeFileSync(join(targetDir, "locales", "en.json"), localeEn);

console.log(`✔ ${targetDir}

다음 단계:
  cd ${name}
  ${inRepo ? "pnpm install && pnpm build" : "npm install && npm run build"}
  zip -r ${name}.zip brick.plugin.json package.json migrations locales dist
  → 관리자 → 플러그인 → ZIP 업로드 → 활성화
${inRepo ? "\n(Brick 저장소 안입니다 — plugins/ 아래에 만들면 재부팅만으로도 로드됩니다)" : ""}`);
