# Brick에 기여하기

Brick은 MIT 라이선스 오픈소스입니다. 이슈, PR, 플러그인/테마 제작 모두 환영합니다.

## 개발 환경

요구사항: **Node.js 20.11+**, **pnpm 9**, **PostgreSQL 16+** (또는 Docker)

```bash
git clone https://github.com/uulab/brick.git
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

플러그인/렌더 파이프라인을 건드렸다면 로컬에서 최소 시나리오를 확인하세요:
설치 마법사 → 로그인 → 플러그인 활성화 → 페이지 생성/발행 → 공개 렌더.

## 커밋 / PR

- 커밋 메시지는 "무엇을"이 아니라 "왜"가 드러나게.
- PR 하나 = 하나의 관심사. 스키마 마이그레이션은 별도 커밋 권장.
- 이슈 없는 대형 PR보다, 방향을 논의하는 이슈를 먼저 열어주세요.

## 플러그인/테마 제작

코어에 기여하지 않아도 생태계에 기여할 수 있습니다:
- [플러그인 개발 가이드](docs/plugin-development.md)
- [테마 개발 가이드](docs/theme-development.md)
