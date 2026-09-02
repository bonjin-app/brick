# 플러그인 개발 가이드

Brick 플러그인은 **사전 빌드된 JavaScript + manifest + SQL 마이그레이션**을 ZIP으로 배포합니다.
서버는 절대 빌드하지 않습니다 — 관리자 화면에서 ZIP을 올리면 곧바로 실행됩니다.

## 시작은 템플릿으로

```bash
npm create brick-plugin my-plugin
```

빈 껍데기가 아니라 **동작하는 방명록**이 생성됩니다 — 라우트·블록·관리
화면·마이그레이션·개인정보 파기까지, 이 문서의 계약 전부를 한 번씩 씁니다.
지우면서 바꿔 나가세요. 생성된 README 에 빌드→ZIP→업로드 절차가 있습니다.

의존성 규칙: `@brick/plugin-sdk` · `drizzle-orm` · `uuidv7` 은 Brick 이 함께
설치하므로 **번들하지 마세요** (특히 drizzle-orm — 다른 사본의 `sql` 객체는
서버가 알아보지 못합니다). 그 외의 의존성은 dist 에 번들해야 합니다.

## 다국어 (ctx.t)

블록·라우트가 그리는 **공개 문자열**은 하드코딩하지 말고 카탈로그에 두세요:

```
my-plugin/
├── locales/
│   ├── ko.json    # { "entries.empty": "아직 글이 없습니다." }
│   └── en.json    # { "entries.empty": "No entries yet." }
```

```ts
ctx.t("entries.empty")            // 사이트 언어(site.locale)의 문구
ctx.t("hello", { name: "홍" })    // "{name}" 치환
ctx.locale                        // 현재 사이트 언어 ("ko" | "en")
```

요청 언어에 키가 없으면 ko → 키 자체 순서로 폴백하고 서버 로그에 남습니다 —
번역이 빠지면 빠진 것이 보입니다. 템플릿(`npm create brick-plugin`)이 이
구조를 그대로 시연합니다.

**관리 화면의 선언 라벨**(registerAdminResource 의 title/label/help/
placeholder/options, 관리 메뉴 label)은 ctx.t 를 쓰지 않습니다 — 선언은
활성화 때 한 번 고정되어 언어 변경을 따라갈 수 없기 때문입니다. 대신
gettext 방식입니다: **선언에 쓴 원문이 곧 카탈로그 키**이고, 서버가 서빙
시점에 번역합니다. `locales/en.json` 에 원문을 키로 추가하면 됩니다:

```json
{ "주문": "Orders", "주문번호": "Order no." }
```

번역이 없는 라벨은 원문이 그대로 나갑니다 (선언 코드는 바꿀 것이 없습니다).

## 헤더에 링크 놓기 (registerHeaderAction)

손님이 **모든 화면에서 한 번에 닿아야 하는 곳**이 있다면 헤더에 등록하세요.
쇼핑몰의 장바구니가 그렇습니다 — 담기는 상품 상세에서 되지만, 담은 다음에
갈 곳이 헤더에 없으면 주소를 외워야 합니다.

```ts
ctx.registerHeaderAction({ label: "장바구니", path: "/shop/cart", order: 10 });
ctx.registerHeaderAction({ label: "쪽지함", path: "/memo", requiresLogin: true });
```

- `label` 은 관리 라벨과 같은 gettext 방식입니다(원문이 번역 키).
- `requiresLogin` 이면 비로그인 손님에게는 나오지 않습니다.
- **숫자 배지(장바구니 개수, 안 읽은 쪽지)는 여기 담지 마세요.** 비로그인
  렌더는 캐시되므로 남의 값이 새어 나갑니다. 배지는 블록이 클라이언트에서
  채웁니다.
- 좁은 화면에서는 기본 테마가 **첫 항목만** 남깁니다 — 헤더가 두 줄이 되면
  안 되므로. 중요한 것에 작은 `order` 를 주세요.

## 화면 제목 (ctx.setSeo)

블록 하나가 URL 로 여러 화면을 전환한다면(목록/상세/작성) **화면 제목을
직접 알려주세요.** 안 하면 그 페이지의 제목이 모든 화면에 쓰입니다 — 글
상세의 브라우저 탭·공유 미리보기·검색 결과가 전부 "게시판"이 됩니다.

```ts
ctx.registerBlock({
  name: "board",
  render: async (props, ctx) => {
    const post = await loadPost(ctx.pathTail);
    ctx.setSeo?.({
      title: post.title,
      description: excerpt(post.content),  // 공유 미리보기 문구
      ownHeading: true,                    // 이 화면의 h1 은 내가 그린다
    });
    return `<h1>${escapeHtml(post.title)}</h1>…`;
  },
});
```

- **`ownHeading` 은 "누가 화면 제목을 그리는가"입니다** — 문서 제목과 별개
  문제입니다. 생략하면 테마가 그 제목을 h1 으로 그려 주고(장바구니·주문서처럼
  자기 제목을 그리지 않는 화면), `true` 면 테마는 그리지 않습니다(이미 그렸으니).
  잘못 주면 제목이 두 번 나오거나 h1 없는 문서가 됩니다 — 화면을 보면 압니다.
- 운영자가 페이지 SEO 를 직접 적었다면 **그것이 이깁니다.** 자동 추론이
  사람이 적은 값을 덮으면 안 됩니다.
- 권한이 없어 내용을 감춘 화면(비밀글)에서는 **부르지 마세요** — 제목과 요약이
  캐시와 검색엔진에 남습니다.

## 대시보드 카드 (registerDashboardCard)

관리자 첫 화면에 "오늘의 숫자"를 올립니다. 등록하지 않으면 운영자는
그 숫자를 보러 매번 관리 화면으로 들어가야 합니다.

```ts
ctx.registerDashboardCard({
  title: "오늘 주문",                       // 원문이 번역 키 (en.json 에 추가)
  order: 20,                               // 작을수록 먼저
  link: "/admin/x/my-plugin/orders",       // 누르면 이동 (선택)
  load: async () => ({                     // 요청 시점에 실행
    value: 12,
    sub: ctx.t("dash.awaiting", { n: 3 }), // 동적 문구는 ctx.t
  }),
});
```

`load` 가 던지거나 3초를 넘기면 그 카드만 오류로 표시됩니다 — 다른
카드와 대시보드는 그대로 나갑니다. "오늘"을 세는 쿼리는 사이트
시간대(SDK 가 재수출하는 `SITE_TZ` 상수)로 날짜를 잘라야 리포트와
숫자가 맞고, **컬럼이 아니라 상수 쪽을 변환**해야 인덱스를 탑니다:

```sql
created_at >= (date_trunc('day', now() AT TIME ZONE ${SITE_TZ}) AT TIME ZONE ${SITE_TZ})
```

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
  // REST API: /api/plugins/my-plugin/items/:id 로 마운트됨.
  // 마지막 인자(docs)는 선택 — /api/docs 의 API 문서에 한 줄 요약으로 실립니다.
  // 없어도 경로·메서드는 자동으로 문서에 실립니다.
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

### 일괄 작업 (bulkActions)

목록에서 여러 행을 골라 한 번에 처리해야 한다면(선택 삭제·이동·상태 변경)
`bulkActions` 를 선언하세요. 코어 관리 화면이 체크박스 열과 작업 막대를 그리고
`POST <basePath>/bulk` 로 `{ action, ids, params }` 를 보냅니다.

```ts
ctx.registerAdminResource({
  name: "posts", title: "게시글 관리", itemLabel: "게시글", basePath: "/admin/posts",
  fields: [...],
  bulkActions: [
    { code: "delete", label: "선택 삭제", destructive: true, confirm: "되돌릴 수 없습니다. 삭제할까요?" },
    { code: "move", label: "게시판 이동",
      input: { name: "board", label: "대상 게시판", optionsFrom: "/admin/boards/options" } },
  ],
});
ctx.registerRoute("POST", "/admin/posts/bulk", async (req) => {
  requireManager(req);                         // 권한은 라우트가 검사한다
  const { action, ids, params } = req.body as { action: string; ids: string[]; params?: Record<string, unknown> };
  // … 트랜잭션 안에서 처리하고 { ok: true, affected } 를 돌려준다
});
```

- `input.optionsFrom` 은 플러그인 라우트 경로입니다 — `[{ value, label }]` 을 돌려주세요.
- **배열 파라미터 주의**: `sql\`ANY(${ids}::uuid[])\`` 는 동작하지 않습니다(drizzle 이 배열을
  파라미터 나열로 풉니다). PG 배열 리터럴 문자열 `{"a","b"}` 로 만들어 하나의 파라미터로
  넘기세요(brick-board 의 `pgArray` 참고).

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

## 공개 URL을 만든다면

게시글·상품처럼 **공개 주소를 만드는** 플러그인은 사이트맵에 등록하세요.
코어는 `pages` 테이블만 알기 때문에, 등록하지 않으면 검색엔진이 그 주소를
찾지 못합니다 (ADR-40).

```ts
ctx.registerSitemapSource({
  label: "내 콘텐츠",
  count: async () => /* 전체 개수 */,
  page: async ({ offset, limit }) => /* 그 구간의 URL */,
});
```

**정렬을 안정적으로.** `created_at, id` 처럼 변하지 않는 순서를 쓰세요 —
페이지를 나눠 읽는 동안 순서가 바뀌면 어떤 URL은 두 번 나오고 어떤 URL은 빠집니다.

**비공개 콘텐츠를 빼세요.** 권한이 필요한 주소가 사이트맵에 들어가면
검색 결과에 노출되고, 그 자체가 유출입니다.

자세한 내용은 [문의·FAQ·SEO 문서](helpdesk.md)에 있습니다.


## 원클릭 업데이트 배포하기

사용자가 관리자 화면에서 버튼 하나로 새 버전을 받게 하려면:

### 1. 키 만들기 (한 번만)

```bash
node scripts/sign-extension.mjs keygen --out my-key
```

`my-key.private.pem` 은 **비밀**입니다. 잃으면 기존 사용자에게 업데이트를
보낼 수 없습니다 (사용자가 새 ZIP 을 직접 올려야 합니다).

### 2. 매니페스트에 넣기

```json
{
  "name": "my-plugin",
  "publisherKey": "<my-key.public.txt 내용>",
  "updates": "https://example.com/my-plugin.update.json"
}
```

`updates` 는 **https** 여야 합니다.

### 3. 새 버전을 서명해서 올리기

```bash
node scripts/sign-extension.mjs sign \
  --zip my-plugin-1.2.0.zip \
  --key my-key.private.pem \
  --url https://example.com/my-plugin-1.2.0.zip \
  --notes "버그 수정" \
  --out my-plugin.update.json
```

ZIP 과 `my-plugin.update.json` 을 서버에 올리면 끝입니다. 사용자의
"업데이트 확인"이 그 JSON 을 읽습니다.

### 지켜지는 것

- 사용자가 **처음 설치할 때** 공개키가 고정됩니다. 이후 다른 키로 서명한
  ZIP 은 서버가 뚫려도 설치되지 않습니다.
- 버전은 semver 숫자 비교입니다. 낮은 버전은 업데이트로 제시되지 않습니다.
- ZIP 은 50MB 상한입니다.

## 레지스트리에 올리기

레지스트리는 중앙 서버가 아니라 **정적 JSON** 입니다. 운영자의 관리 화면이
그 목록을 읽고, 항목이 가리키는 업데이트 매니페스트(위 절의 그 JSON)로
설치합니다 — 설치와 업데이트가 같은 서명 검증을 지납니다.

공식 레지스트리(`docs-site/registry.json`)에 등재하려면 저장소에 PR 로
항목을 추가하세요:

```json
{
  "kind": "plugin",
  "name": "my-plugin",
  "displayName": "내 플러그인",
  "description": "한 줄 소개",
  "version": "1.0.0",
  "updates": "https://내서버/my-plugin.update.json",
  "publisherKey": "<my-key.public.txt 의 내용>",
  "homepage": "https://github.com/me/my-plugin"
}
```

레지스트리는 목록일 뿐 신뢰의 근거가 아닙니다 — 설치를 결정하는 것은
매니페스트의 서명입니다. 회사 내부 레지스트리를 쓰려면 같은 형식의 JSON 을
아무 곳(https)에나 올리고 관리자 설정의 `extensions.registry_url` 을
바꾸면 됩니다.
