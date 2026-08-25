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

### PluginContext가 제공하는 것

| 항목 | 설명 |
|---|---|
| `ctx.db` | Drizzle DB 핸들 (`db.execute(sql\`...\`)`) |
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
4. 네임스페이스 밖(다른 플러그인/코어 테이블)을 직접 수정하지 마세요. 훅으로 요청하세요.

## 배포

```bash
cd my-plugin
npm run build            # dist/ 생성 (Brick 서버가 아닌 개발자 머신에서)
zip -r my-plugin.zip brick.plugin.json dist migrations
```

관리자 → 플러그인 → 업로드 → 활성화. 끝.

레퍼런스 구현: [plugins/brick-board](../plugins/brick-board)
