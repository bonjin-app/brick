# Brick

> 설치형 오픈소스 CMS — Next.js + NestJS + PostgreSQL.
> 그누보드/워드프레스의 **"설치·업데이트·확장이 쉽다"**를 현대 스택으로 재현한다.

## 철학

**"설치에 필요한 기술을 사용자에게 노출하지 않는다."**

| | 그누보드/WordPress | Brick |
|---|---|---|
| 설치 | FTP 업로드 | `docker compose up -d` 한 번 |
| 확장 | plugin.zip 업로드 | plugin.zip / theme.zip 업로드 (동일 UX) |
| 업데이트 | 파일 교체 | `docker compose pull && up -d` |
| DB | MySQL | PostgreSQL (JSONB, FTS, SKIP LOCKED) |
| SEO | 서버 렌더 | Next.js SSR/ISR |

## 설치 (사용자)

```bash
curl -O https://raw.githubusercontent.com/uulab/brick/main/docker-compose.yml
docker compose up -d
```

`http://localhost:3000` 접속 → 설치 마법사에서 사이트명/관리자 계정만 입력하면 끝.

## 아키텍처

```
                 사용자 / 검색엔진
                        │  :3000 (유일한 공개 포트)
                 ┌──────▼──────┐
                 │   Next.js   │  SSR/ISR, /api/* → 내부 rewrite
                 └──────┬──────┘
                        │  :3001 (내부 전용)
                 ┌──────▼──────┐
                 │   NestJS    │  Brick Runtime
                 │  ┌────────┐ │
                 │  │ Core   │ │  HookBus · Provider · PluginLoader
                 │  │ Plugins│ │  같은 프로세스에서 실행 (분리 금지)
                 │  │ Themes │ │  빌드 없는 런타임 템플릿
                 │  └────────┘ │
                 └──────┬──────┘
                        │
                  PostgreSQL      ← 유일한 필수 의존성
              (Redis/S3는 선택 — 없으면 PG 기반 기본 구현)
```

핵심 설계 결정은 [docs/architecture.md](docs/architecture.md) 참고.

## 현재 구현된 것 (v0.0.x)

- ✅ 설치 마법사 (사이트명 + 관리자 계정만 입력)
- ✅ 세션 인증 (argon2, httpOnly 쿠키, DB에는 토큰 해시만 저장)
- ✅ 관리자 셸 — 대시보드 / 페이지 / 플러그인 / 테마
- ✅ **페이지 빌더** — 블록 트리 편집, propsSchema 기반 속성 UI, SEO 설정
- ✅ 공개 사이트 SSR — 테마가 `<html>`부터 문서 전체 소유, 완성 HTML 응답
- ✅ **플러그인 시스템** — ZIP 업로드 → 활성화 → 재시작 없이 라우트/블록 동작
- ✅ **테마 시스템** — 빌드 없는 런타임 템플릿, ZIP 업로드 즉시 적용
- ✅ 코어 블록 (제목/문단/HTML/이미지/다단/여백) + 플러그인 블록
- ✅ 태그 기반 렌더 캐시 (PostgreSQL, Redis 불필요) — 페이지/테마/플러그인 변경 시 자동 무효화
- ✅ 게시판 플러그인(brick-board) — 다중 게시판, 글/댓글/조회수/권한
- 🚧 메뉴 편집, 미디어 라이브러리, 회원 가입, 검색, i18n

## 문서

- [아키텍처 결정 기록 (ADR)](docs/architecture.md)
- [플러그인 개발 가이드](docs/plugin-development.md)
- [테마 개발 가이드](docs/theme-development.md)
- [기여 가이드](CONTRIBUTING.md)

## 개발

요구사항: Node.js 20.11+, pnpm 9, PostgreSQL 16+ (또는 Docker)

```bash
pnpm install
cp .env.example .env      # DATABASE_URL 설정
pnpm build                # 패키지 빌드
pnpm dev                  # web(:3000) + api(:3001) 동시 실행
```

## 저장소 구조

```
apps/
  web/          Next.js — 공개 사이트 + 관리자 (유일한 공개 진입점)
  api/          NestJS — Brick Runtime (내부 전용)
packages/
  core/         HookBus, PluginContext, Provider 인터페이스
  database/     Drizzle 스키마 + 코어 마이그레이션
  shared/       공통 타입, plugin/theme manifest 스키마
  plugin-sdk/   플러그인 개발자 공개 표면 (definePlugin)
  theme-sdk/    런타임 템플릿 엔진
plugins/
  brick-board/  게시판 플러그인 (레퍼런스 구현)
themes/
  default/      기본 테마 (빌드 없는 런타임 템플릿 레퍼런스)
docker/         Dockerfile, entrypoint
```

## 확장 개발

**플러그인** — 사전 빌드된 JS + manifest + 마이그레이션을 ZIP으로 배포:

```ts
import { definePlugin } from "@brick/plugin-sdk";

export default definePlugin((ctx) => {
  ctx.registerRoute("GET", "/hello", async () => ({ hello: "brick" }));
  ctx.registerBlock({ name: "greeting", displayName: "인사말",
    render: async () => "<p>안녕하세요</p>" });
  ctx.hooks.onAction("post.created", "my-plugin", async (post) => { /* ... */ });
  return {};
});
```

**테마** — 빌드가 필요 없다. `templates/*.html` + `brick.theme.json`을 ZIP으로 업로드하면 즉시 적용된다.

## 라이선스

[MIT](LICENSE)
