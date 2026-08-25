# Brick 아키텍처 결정 기록 (ADR)

이 문서는 Brick의 뼈대를 결정한 이유를 기록한다. 코드를 고치기 전에 이 문서와 충돌하는지 먼저 확인할 것.

## ADR-1. 배포 단위는 "하나의 앱 컨테이너 + PostgreSQL"

- 사용자에게 Brick은 단일 제품이다. 내부가 Next.js/NestJS 두 프로세스여도 사용자가 관리하지 않는다.
- `docker compose up -d` = 설치. `docker compose pull && up -d` = 업데이트.
- PHP 호스팅(FTP-only) 지원은 하지 않는다. Node 런타임이 없는 환경을 억지로 지원하면 아키텍처가 망가진다.

## ADR-2. Next.js(3000, 공개) → rewrite → NestJS(3001, 내부)

- Next.js를 custom server로 감싸지 않는다 — ISR/정적 최적화/스트리밍을 잃는다. SEO가 1급 목표이므로 손해.
- NestJS는 외부에 노출하지 않는다. 공개 포트는 3000 하나.
- 같은 컨테이너 안에서 두 프로세스를 entrypoint가 함께 띄운다.

## ADR-3. Brick Core는 PostgreSQL만으로 완전히 동작한다

- Cache/Queue/Lock/Storage는 전부 Provider 인터페이스(@brick/core) 뒤에 있다.
- 기본 구현: UNLOGGED 테이블 캐시, SKIP LOCKED 큐, advisory lock, 로컬 디스크 스토리지.
- REDIS_URL / STORAGE_DRIVER 설정 시에만 Redis/S3 구현으로 교체. docker-compose 기본 구성에 Redis/MinIO를 넣지 않는다.

## ADR-4. ORM은 Drizzle

- Prisma는 단일 schema.prisma를 강제한다 → 플러그인이 자기 테이블을 들고 올 수 없다.
- Drizzle은 스키마가 분산 가능한 평범한 TS 코드고, 플러그인은 순수 SQL 마이그레이션(migrations/*.sql)을 동봉한다.
- 플러그인 테이블은 `<plugin>_` 접두사, 이력은 plugin_migrations 테이블로 멱등 관리.

## ADR-5. 플러그인은 단일 프로세스 안에서 실행된다

- 플러그인마다 프로세스/포트를 주는 방식은 설치형 CMS에서 지옥이 된다. 금지.
- PluginLoader가 dynamic import로 사전 빌드된 dist/index.js를 로드한다. **서버는 절대 빌드하지 않는다.**
- 플러그인은 PluginContext를 통해서만 Brick과 상호작용한다 (hooks, routes, blocks, settings, db, cache, queue, storage).
- 비활성화 시 HookBus 등록/라우트/블록이 모두 회수된다.

## ADR-6. Theme = 빌드 없는 런타임 템플릿, React는 Block에만

가장 중요한 결정. "theme.zip 업로드 = 즉시 적용"이 성립하려면 테마가 빌드 파이프라인을 타면 안 된다.

- Theme: `templates/*.html`(최소 템플릿 문법) + 디자인 토큰 + 정적 자산. 레이아웃/스킨 담당.
- Block: React/서버 렌더 컴포넌트. Core와 Plugin이 공급하며, 빌드 대상은 이쪽뿐.
- 페이지 = 테마 레이아웃 + 블록 트리(JSONB). 블록의 render()는 항상 HTML을 반환할 수 있어야 한다(SEO).
- 템플릿 문법은 의도적으로 최소({{var}}, {{{raw}}}, #if, #each). 로직이 필요하면 Block으로 만든다.

## ADR-7. 확장 설치 UX는 WordPress와 동일하게

- 관리자 → 업로드 → plugin.zip/theme.zip → 압축 해제 → manifest 검증 → 활성화.
- 확장 디렉터리(plugins/, themes/, uploads/)는 Docker 볼륨 — 이미지 업데이트에도 유지된다.
- 활성화 상태는 DB(installed_plugins/installed_themes)에 기록되어 부팅 시 복원된다.

## ADR-8. 설치 마법사는 최소 입력

- DB 접속 정보를 묻지 않는다 — DATABASE_URL은 compose가 이미 주입했다.
- 사이트명 + 관리자 이메일/비밀번호만 입력. install.state가 installed가 되기 전에는 전 라우트가 /install로 리다이렉트.

## 로드맵 (초안)

1. **M1 — 코어 부팅**: 인증(세션), 관리자 셸, 페이지 CRUD, 테마 렌더 파이프라인 완성
2. **M2 — 확장 시스템**: ZIP 설치 API(yauzl), 플러그인/테마 관리 UI, brick-board 완성(글쓰기/댓글/첨부)
3. **M3 — 페이지 빌더**: 블록 편집 UI, 블록 캐시(태그 무효화), 메뉴 편집
4. **M4 — 운영 품질**: 백업/복원, 업데이트 마이그레이션 검증, 권한 세분화, i18n
5. **M5 — 생태계**: 플러그인 레지스트리, `create-brick-plugin` 템플릿, 문서 사이트

## ADR-9. 공개 사이트는 Next.js Route Handler가 완성 HTML을 그대로 응답한다

- catch-all을 React 페이지로 만들면 테마 HTML(완전한 문서)이 React 문서 안에 중첩되어
  `<title>`/`<meta>`가 `<body>`에 갇힌다 — SEO 1급 목표와 정면 충돌.
- 그래서 `app/[[...slug]]/route.ts`가 API의 렌더 파이프라인(`GET /api/render/page`)을 호출해
  완성 HTML을 상태코드와 함께 그대로 응답한다. 테마가 문서 전체를 소유한다(WordPress 모델).
- React는 관리자(/admin)와 설치 마법사(/install)에만 쓴다. 정적 라우트가 catch-all보다 우선한다.
- 공개 페이지 캐시는 Next(ISR)가 아니라 API 쪽 태그 캐시가 담당한다
  ("pages" / "page:<slug>" 태그, 페이지·테마·플러그인 변경 시 무효화).

## 알려진 제약

- **한국어 전문 검색**: `to_tsvector('simple', ...)`는 DB 로케일이 C면 한글을 토큰으로 인식하지
  못한다. 공식 postgres 이미지(utf8 로케일)에서는 공백 단위 토큰화가 동작하지만, 조사/어미가 붙는
  한국어 특성상 실전 검색 품질은 pg_trgm(ILIKE + GIN) 보강이 필요하다. 검색 기능 구현 시
  `plain_text`에 pg_trgm 인덱스를 추가할 것.
