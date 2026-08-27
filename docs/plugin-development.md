# 플러그인 개발 가이드

Brick 플러그인은 **사전 빌드된 JavaScript + manifest + SQL 마이그레이션**을 ZIP으로 배포합니다.
서버는 절대 빌드하지 않습니다 — 관리자 화면에서 ZIP을 올리면 곧바로 실행됩니다.

## 구조

```
my-plugin/
├── brick.plugin.json     # manifest (필수)
├── dist/index.js         # 진입점 — 사전 빌드된 ESM (필수)
└── migrations/           # 플러그인 소유 테이블 (선택)
    └── 0001_init.sql
```

## manifest — brick.plugin.json

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "displayName": "내 플러그인",
  "description": "설명",
  "brickVersion": ">=0.0.1",
  "entry": "dist/index.js",
  "migrations": "migrations"
}
```

- `name`: 소문자/숫자/하이픈만. 전역 고유해야 하며 라우트/블록/테이블 네임스페이스가 됩니다.
- `entry`: dynamic import되는 ESM 파일. `activate(ctx)` 함수를 default export 해야 합니다.

## 진입점

```ts
import { definePlugin } from "@brick/plugin-sdk";

export default definePlugin((ctx) => {
  // REST API: /api/plugins/my-plugin/items/:id 로 마운트됨
  ctx.registerRoute("GET", "/items/:id", async (req) => {
    // req.params.id, req.query, req.body, req.user(세션 사용자 | null)
    return { id: req.params.id };
  });

  // 페이지 빌더 블록 — 서버 렌더(HTML 반환)이므로 검색엔진에 그대로 노출됩니다
  ctx.registerBlock({
    name: "my-block",            // 자동으로 "my-plugin/my-block"으로 네임스페이스됨
    displayName: "내 블록",
    propsSchema: { type: "object", properties: { text: { type: "string", title: "내용" } } },
    render: async (props) => `<p>${String(props.text ?? "")}</p>`,
  });

  // 훅: 코어/다른 플러그인의 이벤트 구독
  ctx.hooks.onAction("board.post.created", "my-plugin", async (payload) => { /* ... */ });

  // 관리자 메뉴
  ctx.registerAdminMenu({ label: "내 플러그인", path: "/admin/plugins/my-plugin" });

  return {
    deactivate: async () => { /* 타이머/구독 정리 */ },
  };
});
```

## 관리 화면 만들기 — 코드 없이

플러그인은 React 코드를 배포할 수 없습니다(Next.js는 빌드 타임에 라우트가 정해짐).
대신 **무엇을 편집할 수 있는지 선언**하면 코어 관리자가 목록·생성·수정·삭제 화면을
런타임에 만들어줍니다.

```ts
ctx.registerAdminResource({
  name: "items",              // /admin/x/my-plugin/items 로 접근
  title: "아이템",             // 사이드바·목록 제목
  itemLabel: "아이템",
  basePath: "/items",         // registerRoute로 등록한 REST 경로
  fields: [
    { name: "name",  label: "이름",   type: "text",  required: true, inList: true },
    { name: "price", label: "가격",   type: "money", inList: true },
    { name: "status", label: "상태",  type: "select", inList: true,
      options: [{ value: "on", label: "판매중" }, { value: "off", label: "중지" }] },
    { name: "body",  label: "설명",   type: "richtext" },
    { name: "hits",  label: "조회수", type: "number", readOnly: true, inList: true },
  ],
  can: { create: true, update: true, delete: false },
});
```

코어 관리자는 다음 규약으로 이 리소스의 API를 호출합니다 — `registerRoute`로 모두 등록해야 합니다:

| 메서드 | 경로 | 반환 |
|---|---|---|
| GET | `<basePath>?page=N` | `{ items, total, page, pageSize }` 또는 배열 |
| POST | `<basePath>` | 생성 |
| PUT | `<basePath>/:id` | 수정 |
| DELETE | `<basePath>/:id` | 삭제 |

### 필드 타입

`text` · `textarea` · `richtext` · `number` · `money`(원 단위 표시) ·
`boolean` · `select` · `date` · `image`(미디어 URL + 미리보기)

`inList: true` 인 필드만 목록에 표시되고, `readOnly: true` 는 폼에서 제외됩니다.

레퍼런스: [plugins/brick-shop/src/admin-resources.ts](../plugins/brick-shop/src/admin-resources.ts) —
쇼핑몰이 이 방식으로 관리 화면 4개(주문·상품·분류·쿠폰)를 만듭니다.

## 트랜잭션 — 돈과 재고를 다룬다면 필수

`ctx.db.execute(sql\`BEGIN\`)` 를 **쓰면 안 됩니다.** 커넥션 풀에서 매 호출이
다른 커넥션을 받을 수 있어 트랜잭션이 성립하지 않습니다(조용히 깨집니다).

```ts
await ctx.db.transaction(async (tx) => {
  // 콜백 전체가 하나의 커넥션·하나의 트랜잭션에서 실행된다.
  // 예외를 던지면 전부 롤백된다.
  const { rows } = await tx.execute(sql`
    UPDATE items SET stock = stock - ${qty}
    WHERE id = ${id} AND stock >= ${qty}
    RETURNING id
  `);
  if (!rows.length) throw new HttpError(409, "재고가 부족합니다.");
  await tx.execute(sql`INSERT INTO orders ... `);
});
```

동시성이 있는 감소 연산은 **조회 후 차감이 아니라 조건부 UPDATE**로 해야 합니다.
위 예시의 `WHERE stock >= qty` + `RETURNING` 패턴이 그것입니다.

### PluginContext가 제공하는 것

| 항목 | 설명 |
|---|---|
| `ctx.db` | DB 핸들 — `execute()` 와 `transaction()` |
| `ctx.settings` | `plugin:<name>:` 네임스페이스가 적용된 설정 저장소 |
| `ctx.cache` / `ctx.queue` / `ctx.storage` | Provider 추상화 — Redis/S3 유무와 무관하게 동일 API |
| `ctx.hooks` | action/filter 버스 |

### 에러 → HTTP 상태코드

라우트 핸들러에서 `{ status: number }` 속성을 가진 에러를 던지면 해당 상태코드로 응답합니다:

```ts
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
if (!req.user) throw new HttpError(401, "login required");
```

## 마이그레이션

- `migrations/*.sql` 파일이 파일명 순으로, 플러그인 **활성화 시점**에 1회씩 적용됩니다 (`plugin_migrations` 테이블로 멱등 보장).
- 테이블 이름에 반드시 플러그인 접두사를 붙이세요: `myplugin_items`.
- 기존 마이그레이션 파일은 수정하지 말고 새 파일을 추가하세요.

## 규칙 (중요)

1. **프로세스/포트를 직접 열지 마세요.** 모든 플러그인은 Brick 런타임 프로세스 안에서 실행됩니다.
2. **DB 커넥션을 직접 만들지 마세요.** `ctx.db`를 사용하세요.
3. **사용자 입력은 이스케이프하세요.** 블록 render가 반환한 HTML은 그대로 페이지에 삽입됩니다.
4. **원자성이 필요하면 `ctx.db.transaction()`을 쓰세요.** `execute("BEGIN")`은 동작하지 않습니다.
5. 네임스페이스 밖(다른 플러그인/코어 테이블)을 직접 수정하지 마세요. 훅으로 요청하세요.

## 배포

```bash
cd my-plugin
npm run build            # dist/ 생성 (Brick 서버가 아닌 개발자 머신에서)
zip -r my-plugin.zip brick.plugin.json dist migrations
```

관리자 → 플러그인 → 업로드 → 활성화. 끝.

레퍼런스 구현:
- [plugins/brick-board](../plugins/brick-board) — 게시판 (기본 패턴)
- [plugins/brick-shop](../plugins/brick-shop) — 쇼핑몰 (관리자 리소스, 트랜잭션, 재고 동시성)

---

## 개인정보를 저장한다면 (필수)

플러그인이 회원과 연결된 데이터를 저장하면 **삭제 방법을 등록해야 합니다.**
등록하지 않으면 회원이 탈퇴한 뒤에도 그 데이터가 남아 **위법 상태**가 됩니다.
코어는 여러분의 테이블 이름을 알 수 없으므로 대신 지워줄 수 없습니다 (ADR-38).

```ts
ctx.registerDataEraser({
  label: "내 플러그인",
  order: 50,                       // 작을수록 먼저 (기본 100)
  async erase({ tx, userId, deletePosts }) {
    // 반드시 넘어온 tx 를 쓴다 — ctx.db 는 트랜잭션 밖으로 나간다
    const { rows } = await tx.execute(sql`
      DELETE FROM my_table WHERE user_id = ${userId}::uuid RETURNING id
    `);
    return rows.length ? [`기록 ${rows.length}건 삭제`] : [];
  },
  // 되돌릴 수 없는 손실은 반드시 미리 알린다
  async describe({ userId }) {
    return [{ label: "내 기록", detail: "N건이 삭제되며 복구할 수 없습니다." }];
  },
});
```

**지킬 것 세 가지**

1. **넘어온 `tx` 를 쓴다.** `ctx.db` 를 쓰면 트랜잭션 밖으로 나가고,
   "데이터는 지웠는데 계정 익명화가 실패해 되돌아간" 상태가 가능해집니다.
2. **예외를 삼키지 않는다.** 실패하면 탈퇴 전체가 되돌아가는 것이 맞습니다 —
   지우지 못한 것을 지웠다고 말하지 않기 위해서입니다. 훅(action)과 반대입니다.
3. **지울지 익명화할지 판단한다.** 법정 보존 의무가 있는 데이터(거래 기록)는
   지우면 안 됩니다. 그 판단은 도메인을 아는 여러분이 해야 합니다.
   판단 기준은 [회원 생애주기 문서](members.md)에 정리해두었습니다.

동작 확인은 `scripts/smoke-member.sh` 를 참고하세요 — "파기했다"는 응답을 믿지 않고
DB의 실제 행을 들여다봅니다.
