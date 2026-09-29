# Brick — AI 코딩 에이전트를 위한 저장소 안내

Brick 은 설치형 오픈소스 CMS 입니다 (Next.js + NestJS/Fastify + PostgreSQL, pnpm 모노레포).
이 문서는 Claude Code · Codex · Cursor 같은 에이전트가 **이 저장소를 고칠 때 지켜야 할 것**을 모았습니다.
사람에게도 같은 내용이 맞습니다. 자세한 설명은 `docs/` 에 있고, 여기서는 길만 안내합니다.

## 지도

| 경로 | 무엇 |
|---|---|
| `apps/api` | NestJS API (:3001). 모듈은 `src/modules/*` |
| `apps/web` | Next.js 관리 화면 (:3000) |
| `packages/core` | 코어 계약 — 훅(HookBus), 플러그인 컨텍스트, 공용 도우미(`publicUrl` 등) |
| `packages/plugin-sdk` | 플러그인이 import 하는 표면. `@brick/core` 의 도우미를 다시 내보낸다 |
| `packages/database` | Drizzle 스키마와 코어 마이그레이션 |
| `plugins/brick-*` | 게시판·쇼핑몰·포인트·1:1문의 등. 플러그인 하나가 라우트·블록·화면·훅을 모두 등록한다 |
| `themes/*` | 서버 렌더 테마. `src/style.css` 를 고치면 `assets/style.css` 도 컴파일해 커밋해야 한다 |
| `scripts/smoke-*.sh` | 실제 PostgreSQL + 실제 서버로 도는 E2E 스모크 (수트 46개) |
| `scripts/brick-mcp.mjs` | 돌고 있는 사이트를 읽는 MCP 서버 (읽기 전용 토큰, `docs/mcp.md`) |
| `scripts/check-*.mjs` | 서버 없이 도는 정적 검사 (CI 가 전부 돌린다) |

새 플러그인은 `npm create brick-plugin my-plugin` 이 동작하는 예제로 시작한다 → `docs/plugin-development.md`.
구조 결정은 `docs/architecture.md` 의 ADR, 진행과 남은 일은 `docs/roadmap.md`.

## 명령

```bash
pnpm install --frozen-lockfile
pnpm build            # 타입 검사 포함. 종료 코드를 반드시 확인한다 (아래 함정 참고)
pnpm build:themes     # themes/*/src 를 고쳤다면
pnpm db:dev           # 개발용 임베디드 PostgreSQL
DATABASE_URL=postgresql://… bash scripts/smoke-board.sh   # 스모크 한 수트
node scripts/check-doc-counts.mjs                          # 문서 숫자 검사
```

스모크는 **:3001 에 자기 API 를 띄우고 DB 를 초기화한다.** 개발 서버를 켜 둔 채 돌리지 않는다.
스모크가 도는 동안 스크립트 파일을 고치거나 `dist` 를 빌드하지 않는다 (bash 는 스크립트를 조금씩 읽는다).

## 지켜야 할 규칙

1. **돈과 권한은 한 곳에서 계산한다.** 같은 규칙을 두 곳에 적으면 언젠가 어긋난다. 이미 모아 둔 곳을 쓴다:
   - 사용자·운영자가 넣은 주소 → `publicUrl` / `publicUrls` / `toAbsoluteUrl` (`packages/core/src/url.ts`). 정규식을 새로 쓰지 않는다.
   - 주문에서 돌려준 돈 → `plugins/brick-shop/src/refunds.ts` 의 `orderRefundsJoin`.
   - 주문 상태가 바뀐 뒤의 일(안내·결제완료 알림·현금영수증 취소) → `order-lifecycle.ts`.
   - 포인트 돌려주기·거두기 → `restoreOrderPoints`. 게시글 삭제 → `deletePosts`. 비밀글 열람 → `access.ts`.
2. **상태를 바꾸는 작업은 트랜잭션 안에서 행을 잠그고 상태를 다시 본다.** 결제완료 직후 취소처럼 API 로 재현되지 않는 경합이 실제로 있었다.
3. **훅 구독자는 멱등이어야 한다.** 알린 쪽이 `doActionOrThrow` 로 다시 알릴 수 있다 (`shop.order.paid` → 구매 적립은 주문번호로 한 번만).
4. **사용자에게 보이는 오류 문장은 번역 키다.** `throw new ShopError(400, "한국어 문장")` 을 쓰면 그 문장 그대로를 `locales/en.json` 의 키로 더해야 한다 (`check-error-i18n.mjs` 가 막는다). 손님 화면의 한국어는 `ctx.t` 로.
5. **DB 를 직접 만지는 SQL 은 Drizzle `sql` 템플릿.** 배열은 `ANY(${arr})` 가 아니라 `sql.join(...)`. 마이그레이션은 `plugins/*/migrations/NNNN_*.sql`, 기존 데이터를 소급해 바꾸지 않는다.
6. **서버는 절대 빌드하지 않는다.** 플러그인은 사전 빌드된 JS + manifest + SQL 로 배포된다. `@brick/plugin-sdk`·`drizzle-orm`·`uuidv7` 은 번들하지 않는다.
7. **개인정보를 쌓는 기능은 탈퇴 시 파기(`registerDataEraser`)를 함께 만든다.** 커밋 뒤에 해야 할 일은 `afterCommit` 에 맡긴다.
8. **PG·메일 등 외부 통신은 스텁으로 시험한다.** 진짜 키·계정을 코드·로그·테스트에 넣지 않는다.

## 검증하는 방법 (이 저장소가 실제로 요구하는 것)

- 고쳤다면 **재현 → 수정 → 역검증**: 새 단언에서 고친 줄만 되돌려 보고 **실패하는지** 본다. 통과하면 그 검사는 아무것도 시험하지 않는 것이다.
- 스모크·정적 검사를 늘렸다면 `README.md` 의 스모크 표 숫자와 총계를 함께 고친다 (`check-smoke-counts.mjs`, `check-doc-counts.mjs`). 새 정적 검사는 `.github/workflows/ci.yml` 에 연결한다.
- 기능을 끝냈다면 `docs/roadmap.md` 에 무엇이 문제였고 어떻게 고쳤는지, **하지 않은 것과 이유**를 적는다.
- API 로 재현되지 않는 분기(경합·커밋 뒤 실행)는 `scripts/check-plugin-units.mjs` 처럼 가짜 DB 로 직접 부른다.

## 함정 (실제로 당했다)

- `tsc` 는 오류가 나도 JS 를 내보낸다. 스모크가 통과했다고 빌드가 성공한 것이 아니다 — `pnpm build` 종료 코드로 확인한다.
- 손님용 `/api/render/page` 는 5분 캐시된다. DB 를 직접 고친 뒤 "없다" 를 단언하면 헛통과한다 — 쿼리에 `&_=$RANDOM` 을 붙인다.
- 스모크의 `$VAR` 는 zsh 에서 쪼개지지 않고, bash 3.2 는 인자 속 `{"a","b"}` 를 중괄호 확장한다. `psql_q` 는 이름 없는 식 열 둘을 하나로 합치니 `AS` 별칭을 붙인다.
- 로그인 폼에 비밀번호를 대신 입력해 화면을 검증하지 않는다. 화면 검증은 세션 쿠키 + `curl` 로 하고, 못 한 것은 못 했다고 적는다.
- 도구에게 로그인 세션을 주지 않는다. 사이트를 읽게 하려면 읽기 전용 API 토큰(`docs/mcp.md`)을 쓴다 — 토큰 허용목록에 개인정보 경로나 쓰기를 더하지 않는다.
- `pnpm.overrides` 는 CI 의 pnpm 9.15.4 에서 `package.json` 에서 읽힌다 (`pnpm-workspace.yaml` 과 둘 다 맞춘다).

## 하지 않는 것

- 확장 종류(모듈·애드온·위젯)를 늘리지 않는다. 플러그인 하나로 충분하도록 설계했다.
- 확인하지 못한 경쟁 제품의 기능을 "없다" 고 쓰지 않는다 (`docs/benchmark.md`).
- 기여 규칙과 커밋 관례는 `CONTRIBUTING.md`, 보안 신고는 `SECURITY.md`.
