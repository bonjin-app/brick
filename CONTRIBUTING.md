# Brick에 기여하기

Brick은 MIT 라이선스 오픈소스입니다. 이슈, PR, 플러그인/테마 제작 모두 환영합니다.

## 개발 환경

요구사항: **Node.js 20.11+**, **pnpm 9**, **PostgreSQL 16+** (또는 Docker)

```bash
git clone https://github.com/bonjin-app/brick.git
cd brick
pnpm install
cp .env.example .env        # DATABASE_URL 수정
pnpm build
pnpm dev                    # web(:3000) + api(:3001)
```

DB가 없다면 Docker로:

```bash
docker run -d --name brick-pg -e POSTGRES_USER=brick -e POSTGRES_PASSWORD=brick \
  -e POSTGRES_DB=brick -p 5432:5432 postgres:17-alpine
```

## 저장소 구조와 규칙

| 위치 | 역할 | 규칙 |
|---|---|---|
| `packages/core` | HookBus, Provider 인터페이스, PluginContext | **여기가 공개 계약** — 하위호환 파괴는 major 버전에서만 |
| `packages/database` | Drizzle 코어 스키마 | 스키마 변경 = `migrations/*.sql` 추가 (기존 파일 수정 금지) |
| `apps/api` | NestJS 런타임 | Provider 구현은 반드시 core 인터페이스 뒤에 |
| `apps/web` | Next.js 공개 사이트 + 관리자 | 공개 사이트는 Route Handler(SSR HTML), 관리자는 React |
| `plugins/`, `themes/` | 레퍼런스 확장 | 새 기능은 가능하면 코어가 아닌 플러그인으로 |

아키텍처 결정을 바꾸는 PR은 [docs/architecture.md](docs/architecture.md)의 해당 ADR 수정을 포함해야 합니다.

## 코드 스타일

- TypeScript strict. `any` 대신 정확한 타입 또는 `unknown`.
- ESM 전용(`type: "module"`), 상대 import는 `.js` 확장자 명시.
- 사용자에게 보이는 문자열(관리자 UI, 에러 메시지)은 한국어를 기본으로 하되 i18n 도입 전까지 코드 주석은 한국어/영어 모두 허용.

## 테스트 / 검증

```bash
pnpm build          # 전체 빌드 (타입 검사 포함)
pnpm typecheck
```

E2E 스모크 테스트 — 실제 PostgreSQL과 실제 서버 프로세스로 검증합니다.

```bash
export DATABASE_URL=postgresql://brick:brick@localhost:5432/brick

bash scripts/smoke-test.sh      # 코어 (설치·인증·페이지·미디어·메뉴·검색)
bash scripts/smoke-board.sh     # 게시판 (권한·답변형·첨부·비밀글·추천)
bash scripts/smoke-point.sh     # 포인트 (원장 무결성·멱등·원자성·FIFO·만료)
bash scripts/smoke-memo.sh      # 쪽지·스크랩 (프라이버시·차단·각자삭제)
bash scripts/smoke-shop.sh      # 커머스 (상품·재고 동시성·주문·쿠폰)
bash scripts/smoke-security.sh  # 보안·결제 (금액 위조·멱등성·재설정·감사)
bash scripts/smoke-release.sh   # 배포본 FTP 설치 경로
```

CI(GitHub Actions)가 PR마다 전부 실행합니다:
빌드 → 마이그레이션(멱등성 포함) → 스모크 7종 → `pnpm deploy` 번들 → Docker 이미지 빌드.

동작을 추가/변경했다면 해당 스모크 스크립트에 검증 항목을 추가해주세요.

### 스모크 스크립트 작성 시 주의

지금까지 실제로 겪은 함정입니다:

- `curl -d` 에 중첩 따옴표로 JSON을 넣으면 깨집니다.
  `printf` 로 파일을 만들고 `--data-binary @file` 을 쓰세요.
- 서버를 백그라운드로 띄운 스크립트에서 인수 없는 `wait` 는 **서버까지 기다려 멈춥니다.**
  자식 PID를 모아 개별로 `wait` 하세요.
- `pkill -f "…/server.js"` 는 실제 커맨드라인(`node server.js`)과 어긋나 매칭되지 않습니다.
  실행 시 `$!` 로 PID를 잡아두세요.
- 배포본 테스트는 `env -u DATABASE_URL …` 로 환경변수를 차단해야 설치 모드를 재현합니다.

### 코드에서 하지 말아야 할 것

지금까지 실제로 사고가 났던 패턴입니다.

**오류를 문자열로 판별하지 마세요.**

```ts
// ✗ 드라이버·ORM 버전이 바뀌면 조용히 깨집니다
if (String(err).includes("duplicate key")) { ... }

// ✓ SQLSTATE 는 PostgreSQL 표준입니다
import { isUniqueViolation } from "@brick/plugin-sdk";
if (isUniqueViolation(err, "shop_coupons_code")) { ... }
```

drizzle 0.45 가 오류를 `cause` 로 감싸기 시작하자 여덟 곳이 한꺼번에 500이 됐습니다
(ADR-37). 조용히 깨지는 것이 가장 나쁩니다 — 테스트가 없었다면 사용자가 먼저 봤습니다.

**이미 적용된 마이그레이션 파일을 고치지 마세요.** 운영 중인 설치본은 그 파일을
이미 실행했고 다시 실행하지 않습니다. 새 번호의 파일을 추가하세요.

**동봉 목록을 하드코딩하지 마세요.** 플러그인 목록이 Dockerfile · 배포 스크립트 ·
스모크에 따로 적혀 있어서 셋 다 달라졌고, Docker 설치본에는 쇼핑몰이 없었습니다.
`scripts/collect-plugins.sh` 가 유일한 출처입니다.

**`= ANY(${배열})` 을 쓰지 마세요.** drizzle 이 JS 배열을 PostgreSQL 배열 리터럴로
직렬화하지 않아 `malformed array literal` 이 납니다. `sql.join` 으로 IN 목록을
명시적으로 만드세요.

```ts
// ✗ 런타임에 깨집니다
sql`WHERE slug = ANY(${slugs})`

// ✓
sql`WHERE slug IN (${sql.join(slugs.map((s) => sql`${s}`), sql`, `)})`
```

**재귀 CTE 는 비재귀 항에서 컬럼 타입이 결정됩니다.** 문자열을 이어붙이며
내려갈 때 `name AS path` 로 시작하면 `varchar(n)` 이 되고, 재귀 항의 concat 결과
(`text`)와 타입이 달라 `has type character varying(n) ... but type text overall`
로 실패합니다. 시작 항에서 캐스팅하세요.

```sql
-- ✗ 실행 시 실패
SELECT id, name AS path FROM categories WHERE parent_id IS NULL
-- ✓
SELECT id, name::text AS path FROM categories WHERE parent_id IS NULL
```

**날짜 문자열을 `Date.parse` 로 검증하지 마세요.** JS 는 넘치는 날짜를 다음 달로
굴립니다 — `Date.parse("2026-02-30T00:00:00Z")` 는 NaN 이 아니라 3월 2일입니다.
검증을 통과한 뒤 PostgreSQL 이 던져서 400 이 아니라 500 이 납니다. 되돌려 찍어
같은 문자열이 나오는지 확인하세요 (ADR-51).

**기간 집계는 시간대를 정해서 자르세요.** UTC 로 `date_trunc` 하면 한국에서
오전 9시 이전 결제가 전날로 밀립니다. `BRICK_TIMEZONE`(기본 `Asia/Seoul`)을
쓰세요 (ADR-51).

**컬럼을 추가했으면 관리 리소스 필드와 저장 쿼리도 확인하세요.** `parent_id` ·
`category_id` 가 스키마에는 있는데 폼 필드와 INSERT/UPDATE 에는 없어서, 운영자가
분류 계층을 만들 수도 상품에 분류를 지정할 수도 없었습니다. 스키마에 있는 것이
기능이 있다는 뜻은 아닙니다 (ADR-52).

**검색되어야 하는 내용이 있으면 `registerSearchSource` 를 등록하세요.** 없으면
그 플러그인의 내용은 검색되지 않습니다. `count` 와 `search` 는 **같은 조건**을
써야 하고(다르면 "37건"이라 표시하고 20건만 보여줍니다), **정렬을 고정**해야
하며(안 하면 페이지를 넘길 때 같은 항목이 두 번 나옵니다), `viewer` 로 권한을
걸러야 합니다 — **검색은 권한 검사를 우회하는 가장 흔한 경로이고, 제목만 나와도
내용이 새어 나갑니다** (ADR-60).

**ILIKE 검색은 `%` `_` `\` 를 이스케이프하세요.** 안 하면 손님이 `%` 를 검색하면
전체가 나옵니다 — 검색이 아니라 전체 목록 유출입니다.

**여러 곳에서 쓰는 순수 함수는 코어에 두고 SDK 로 내보내세요.** `escapeHtml` ·
`stripHtml` · `isValidBusinessNo` 가 각각 두세 벌 있었고, `escapeHtml` 은 그중
한 벌만 null 안전해서 잘못된 블록 하나로 페이지 저장이 500 이 났습니다 (ADR-62).

**공개 URL을 만드는 플러그인은 `registerSitemapSource` 를 등록하세요.** 없으면
검색엔진이 그 주소를 찾지 못합니다 (ADR-40).

**개인정보를 저장하는 플러그인은 `registerDataEraser` 를 등록하세요.** 없으면
회원이 탈퇴한 뒤에도 데이터가 남아 위법 상태가 됩니다. 코어는 플러그인 테이블
이름을 모르므로 대신 지워줄 수 없습니다 (ADR-38).

**정리 트랩의 `wait` 에는 `|| true` 를 붙이세요.** kill 한 백그라운드 프로세스를
`wait` 하면 그 종료 코드(143 = SIGTERM)가 스크립트의 종료 코드가 되고, **뒤에서
`exit 0` 을 해도 덮이지 않습니다.** 항목이 전부 통과했는데 CI 가 실패로 봅니다.

```bash
# ✗ 전부 통과해도 CI 가 실패한다
cleanup() { kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null; }
# ✓
cleanup() { local rc=$?; kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null || true; exit "$rc"; }
```

**하네스를 고쳤으면 양방향을 확인하세요.** 항목을 일부러 실패시켜 종료 코드가
1이 되는지도 봐야 합니다 — 통과 경로만 고치고 실패 감지가 죽으면 최악입니다.

**멱등키는 "같은 요청"을 가리켜야 합니다.** 요청을 유일하게 만드는 값을 모두
넣으세요. 주문번호만 쓰면 **한 번 실패한 시도가 그 주문의 모든 재시도를
오염시키고**(PG 가 저장된 실패 응답을 재생한다), 금액만 쓰면 **같은 금액의 서로
다른 취소가 하나로 합쳐집니다**(두 번째 환불이 재생되고 돈은 사업자에게 남는다).
환불은 누적 환불액을 아는 호출자가 키를 만듭니다 (ADR-58).

**돈이 나가는 경로는 스텁으로 검증하세요.** `scripts/pg-stub.mjs` 를 띄우고
`BRICK_TOSS_API_BASE` 로 게이트웨이를 돌리면 **실제로 나간 금액**을 읽을 수
있습니다. 무통장 게이트웨이는 인자를 무시하므로 그것만으로는 아무것도 검증되지
않습니다.

**트랜잭션을 `execute("BEGIN")` 으로 열지 마세요.** 풀에서 매번 다른 커넥션이
나오므로 BEGIN 과 COMMIT 이 다른 커넥션에 갈 수 있습니다. `db.transaction()` 을
쓰세요 (ADR-13).

## 커밋 / PR

- 커밋 메시지는 "무엇을"이 아니라 "왜"가 드러나게.
- PR 하나 = 하나의 관심사. 스키마 마이그레이션은 별도 커밋 권장.
- 이슈 없는 대형 PR보다, 방향을 논의하는 이슈를 먼저 열어주세요.

## 플러그인/테마 제작

코어에 기여하지 않아도 생태계에 기여할 수 있습니다:
- [플러그인 개발 가이드](docs/plugin-development.md)
- [테마 개발 가이드](docs/theme-development.md)
