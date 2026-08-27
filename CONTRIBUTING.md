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

**개인정보를 저장하는 플러그인은 `registerDataEraser` 를 등록하세요.** 없으면
회원이 탈퇴한 뒤에도 데이터가 남아 위법 상태가 됩니다. 코어는 플러그인 테이블
이름을 모르므로 대신 지워줄 수 없습니다 (ADR-38).

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
