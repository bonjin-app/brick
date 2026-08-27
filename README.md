<p align="center">
  <img src=".github/assets/banner.svg" alt="Brick — 설치형 오픈소스 CMS" width="100%" />
</p>

<p align="center">
  <strong>설치는 그누보드처럼 쉽게, 속은 현대적으로.</strong><br />
  Docker 한 줄, 또는 FTP 업로드로 설치하는 오픈소스 CMS · Next.js + NestJS + PostgreSQL
</p>

<p align="center">
  <a href="https://bonjin-app.github.io/brick/">홈페이지</a> ·
  <a href="docs/installation.md">설치</a> ·
  <a href="docs/plugin-development.md">플러그인 개발</a> ·
  <a href="docs/theme-development.md">테마 개발</a> ·
  <a href="docs/architecture.md">아키텍처</a>
</p>

<p align="center">
  <a href="https://github.com/bonjin-app/brick/actions/workflows/ci.yml">
    <img src="https://github.com/bonjin-app/brick/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/bonjin-app/brick/releases">
    <img src="https://img.shields.io/github/v/release/bonjin-app/brick?include_prereleases&label=release&color=ff6b4a" alt="release" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.11-339933.svg" alt="Node 20.11+" />
  <img src="https://img.shields.io/badge/PostgreSQL-16%2B-336791.svg" alt="PostgreSQL 16+" />
  <img src="https://img.shields.io/badge/E2E-587%20passing-2ea043.svg" alt="스모크 테스트 587개" />
  <img src="https://img.shields.io/badge/status-alpha-orange.svg" alt="alpha" />
</p>

---

## 왜 Brick인가

그누보드와 워드프레스가 오래 살아남은 이유는 PHP가 좋아서가 아니라 **파일을 올리면 그냥 돌아갔기** 때문입니다.
현대 스택은 강력하지만 설치가 어려워졌습니다. Brick은 그 편의성을 되찾으면서 현대적인 기반을 갖추려는 프로젝트입니다.

**철학: 설치에 필요한 기술을 사용자에게 노출하지 않는다.**

| | 그누보드 / 제로보드 | WordPress | **Brick** |
|---|---|---|---|
| 언어 | PHP | PHP | **TypeScript** |
| DB | MySQL | MySQL | **PostgreSQL** |
| 설치 | FTP 업로드 | FTP 업로드 | **Docker 한 줄 · 또는 FTP 업로드 + 웹 설치** |
| 업데이트 | 파일 수동 교체 | 관리자 클릭 | **`pull && up` (자동 마이그레이션)** |
| 플러그인 | 제한적 | ZIP 업로드 | **ZIP 업로드** |
| 테마 | 스킨(PHP) | 테마(PHP) | **런타임 템플릿 (빌드 없음)** |
| 게시판 | ✅ (핵심 기능) | 플러그인 | **✅ 첨부·권한·답변형·비밀글** |
| 포인트 | ✅ | 플러그인 | **✅ 원장 기반·만료·쇼핑몰 연동** |
| 캡차 | ✅ | 플러그인 | **✅ 코어 내장 (키 불필요)** |
| 쪽지 | ✅ | ✗ | **✅ 차단·포인트 연동** |
| 스크랩 | ✅ | ✗ | **✅** |
| 페이지 빌더 | 없음 | Gutenberg | **코어 기본 제공** |
| 쇼핑몰 | 영카트(별도) | WooCommerce | **플러그인 기본 동봉** |
| 상품 후기 | 영카트 ✅ | 플러그인 | **✅ 구매 검증·판매자 답변** |
| 방문자 집계 | ✅ (IP 저장) | 플러그인 | **✅ IP를 해시로만 저장** |
| 팝업/배너 | ✅ | 플러그인 | **✅ 경로·기간·클릭 집계** |
| 소셜 로그인 | 플러그인 | 플러그인 | **✅ 코어 내장 (5종 + 사내 SSO)** |
| SSR / SEO | 기본 | 기본 | **Next.js SSR + ISR** |
| 타입 안전성 | 없음 | 없음 | **전 구간 strict** |

> ⚠️ Brick은 **순수 PHP 호스팅(Node 없음)** 에서는 동작하지 않습니다.
> Docker, 또는 Node.js를 지원하는 호스팅(cPanel/Plesk의 "Node.js App", VPS)이 필요합니다.
> 그 환경이라면 **FTP로 올려서 브라우저에서 설치**하는 방식이 동작합니다 → [설치 가이드](docs/installation.md)

---

## 설치

```bash
# 1. compose 파일 받기
curl -O https://raw.githubusercontent.com/bonjin-app/brick/main/docker-compose.yml

# 2. 시크릿 생성 (필수)
echo "BRICK_SECRET=$(openssl rand -base64 32)" > .env

# 3. 실행
docker compose up -d
```

`http://localhost:3000` 접속 → 설치 마법사에서 **사이트 이름과 관리자 계정만** 입력하면 끝입니다.
DB 접속 정보는 묻지 않습니다 — compose가 이미 주입했습니다.

### FTP로 설치하기 (그누보드 방식)

빌드도 `npm install` 도 필요 없는 배포본을 올리고 브라우저에서 설치합니다.

```bash
# 배포본 만들기 (또는 Releases에서 내려받기)
bash scripts/build-release.sh
# → dist-release/brick-<버전>.tar.gz
```

압축을 풀어 서버에 올린 뒤 `server.js` 를 실행하고, 브라우저에서 DB 정보를 입력하면 끝입니다.
`data`, `uploads` 에 쓰기 권한만 주면 됩니다.

자세한 내용은 [설치 가이드](docs/installation.md)를 참고하세요.

### 업데이트

```bash
docker compose pull && docker compose up -d
```

DB 마이그레이션은 컨테이너가 부팅할 때 스스로 적용합니다. 외울 명령이 없습니다.
자세한 내용: [업그레이드 가이드](docs/upgrade.md)

---

## 구조

사용자에게는 **앱 컨테이너 하나와 PostgreSQL 하나**로 보입니다.

```
              사용자 / 검색엔진
                     │  :3000  (유일한 공개 포트)
              ┌──────▼──────┐
              │   Next.js   │  SSR · ISR · 관리자 UI
              └──────┬──────┘
                     │  :3001  (내부 전용)
              ┌──────▼──────────────────────┐
              │      Brick Runtime          │
              │   NestJS · 단일 프로세스     │
              │  ┌───────────────────────┐  │
              │  │ Core    HookBus       │  │
              │  │ Plugins 동적 로드      │  │
              │  │ Themes  런타임 템플릿  │  │
              │  └───────────────────────┘  │
              └──────┬──────────────────────┘
                     │
                PostgreSQL     ← 유일한 필수 의존성
         (Redis · S3는 선택 — 없으면 PG 기반 기본 구현)
```

핵심 설계 결정 36건은 [docs/architecture.md](docs/architecture.md)에 ADR로 기록되어 있습니다.

---

## 기능

### 동작하는 것

- **설치 마법사** — 사이트명 + 관리자 계정만 입력
- **인증** — argon2id, 세션(DB에는 토큰 해시만), 브루트포스 방어
- **회원** — 가입 / 프로필 / 권한 관리(관리자·운영자·회원) / 계정 정지
- **페이지 빌더** — 블록 트리 편집, 속성 UI 자동 생성, SEO 설정
- **코어 블록** — 제목 · 문단 · HTML · 이미지 · 다단 레이아웃 · 여백
- **미디어 라이브러리** — 업로드(확장자 화이트리스트) / 목록 / 삭제
- **메뉴 편집** — 헤더 내비게이션, 테마에 자동 반영
- **검색** — 페이지 전문 검색 (발췌문 포함)
- **플러그인 시스템** — ZIP 업로드 → 활성화 → **재시작 없이** 라우트·블록 동작
- **테마 시스템** — 빌드 없는 런타임 템플릿, ZIP 업로드 **즉시 적용**
- **게시판 플러그인** — 다중 게시판 / 등급별 권한 / 분류 / **답변형(계층)** / 비밀글 /
  **첨부파일**(권한·카운트) / 추천·비추천 / **비회원 글쓰기** / 검색 / 도배 방지 / RSS
- **게시판 화면 일체** — 목록·상세·글쓰기·수정을 **페이지 하나로** (위지윅 에디터 포함)
- **저장형 XSS 방어** — 사용자 HTML을 허용 목록으로 새니타이즈 (20개 벡터 검증)
- **캡차** — 자체 SVG, API 키 불필요. 1회용 토큰·위조 방어. 비회원 글쓰기·가입에 적용
- **쪽지 플러그인** — 받은/보낸함, 차단, 도배 방지, 포인트 차감. 관리자도 내용을 볼 수 없다
- **스크랩** — 게시글 북마크 (그누보드의 스크랩)
- **쇼핑몰 플러그인** — 상품·옵션·재고 / 장바구니(회원·비회원) / 주문·상태머신 / 쿠폰 / 배송비 / 매출 통계
- **상품 후기** — **구매한 사람만** 작성(주문 검증), 별점·사진, 판매자 답변, 표시/숨김, 평점 자동 집계
- **상품 문의** — 공개/비밀 문의(비밀글은 서버에서 가림), 판매자 답변, 답변 상태
- **상품 이미지 갤러리** — 대표 + 추가 이미지 20장, JSON-LD 평점(AggregateRating)까지 SEO 반영
- **결제** — PG 추상화 + 토스페이먼츠 플러그인, 금액 위조·중복 승인 방어, 부분 환불
- **비밀번호 재설정** — 메일 발송(SMTP), 단회성 토큰, 이메일 열거 방지
- **소셜 로그인** — 구글 · 카카오 · 네이버 · GitHub + 사내 SSO(표준 OIDC).
  로그인 CSRF·계정 탈취 방어, 계정 연결/해제, 관리 화면에서 키 설정
- **방문자 집계** — 오늘·어제·최고·전체 + 유입 경로. **IP를 원문으로 저장하지 않는다**
- **팝업 · 배너** — 노출 경로·기간, 다시 보지 않기, 노출·클릭 집계, 본문 새니타이즈
- **감사 로그** — 관리 동작을 행위자·IP와 함께 기록 (180일 보관)
- **포인트 플러그인** — 그누보드 포인트 + 영카트 적립금을 하나로.
  가입·글쓰기·댓글·후기·구매 적립, 쇼핑몰 결제 시 사용, FIFO 소비·만료, 원장 감사 추적
- **플러그인 관리 화면 자동 생성** — 필드 스키마만 선언하면 코어가 CRUD UI를 만든다 (빌드 불필요)
- **렌더 캐시** — 태그 기반 자동 무효화 (Redis 불필요)
- **자동 마이그레이션** — 부팅 시 스키마 자동 최신화
- **웹 설치 마법사** — DB 정보 입력 → 설정 파일 자동 생성 (환경변수 불필요)
- **빌드 없는 배포본** — FTP로 올려서 `node server.js` 만으로 실행
- **백업 / 복원 CLI** — pg_dump 기반
- **헬스체크** — `/healthz` · `/readyz`

### 예정

위시리스트 · 반품/교환 워크플로 · 현금영수증 · 정기결제 · 2FA · 이메일 인증 ·
그누보드 데이터 이전 도구 · OpenAPI 문서 · 플러그인 레지스트리

---

## 확장 만들기

**플러그인** — 사전 빌드된 JS + manifest + SQL 마이그레이션을 ZIP으로 배포합니다. 서버는 빌드하지 않습니다.

```ts
import { definePlugin } from "@brick/plugin-sdk";

export default definePlugin((ctx) => {
  // REST API → /api/plugins/my-plugin/items/:id
  ctx.registerRoute("GET", "/items/:id", async (req) => ({ id: req.params.id }));

  // 페이지 빌더 블록 (서버 렌더 → 검색엔진에 그대로 노출)
  ctx.registerBlock({
    name: "greeting",
    displayName: "인사말",
    propsSchema: { type: "object", properties: { name: { type: "string", title: "이름" } } },
    render: async (props) => `<p>안녕하세요, ${props.name}님</p>`,
  });

  // 코어 이벤트 구독
  ctx.hooks.onAction("board.post.created", "my-plugin", async (post) => { /* ... */ });

  return {};
});
```

**테마** — 빌드가 필요 없습니다. 템플릿 문법은 4개뿐입니다.

```html
<!doctype html>
<html lang="ko">
<head>
  <title>{{ pageTitle }}</title>
  <style>{{{ themeTokens }}}</style>
</head>
<body>
  <nav>{{#each menu}}<a href="{{ url }}">{{ label }}</a>{{/each}}</nav>
  <main>{{{ content }}}</main>
</body>
</html>
```

가이드: [플러그인 개발](docs/plugin-development.md) · [테마 개발](docs/theme-development.md)

---

## 개발

요구사항: Node.js 20.11+ · pnpm 9 · PostgreSQL 16+ (또는 Docker)

```bash
git clone https://github.com/bonjin-app/brick.git
cd brick
pnpm install
cp .env.example .env      # DATABASE_URL, BRICK_SECRET 설정
pnpm build
pnpm dev                  # web(:3000) + api(:3001)
```

E2E 스모크 테스트 — 실제 PostgreSQL과 실제 서버 프로세스로 검증합니다 (총 587개 항목):

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-test.sh
```

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-board.sh
```

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-point.sh
```

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-memo.sh
```

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-shop.sh
```

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-site.sh
```

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-social.sh
```

```bash
DATABASE_URL=postgresql://brick:brick@localhost:5432/brick bash scripts/smoke-security.sh
```

### 저장소 구조

```
apps/
  web/            Next.js — 공개 사이트(Route Handler SSR) + 관리자(React)
  api/            NestJS — Brick Runtime (내부 전용)
packages/
  core/           HookBus, PluginContext, Provider 인터페이스
  database/       Drizzle 스키마 + 코어 마이그레이션
  shared/         공통 타입, plugin/theme manifest 스키마
  plugin-sdk/     플러그인 개발자 공개 표면
  theme-sdk/      런타임 템플릿 엔진
plugins/
  brick-board/    게시판 (레퍼런스 구현)
  brick-shop/     쇼핑몰 (관리자 리소스·트랜잭션·재고 동시성 레퍼런스)
  brick-point/    포인트 (플러그인 간 서비스 협력 레퍼런스)
  brick-memo/     쪽지 (사적 콘텐츠 프라이버시 레퍼런스)
  brick-pay-toss/ 토스페이먼츠 (PG를 코어 수정 없이 붙이는 레퍼런스)
themes/
  default/        기본 테마 (런타임 템플릿 레퍼런스)
docs-site/        GitHub Pages 랜딩페이지
scripts/          스모크 테스트 9종 + OIDC 스텁 + 배포본 생성(build-release.sh)
docker/           Dockerfile, entrypoint
```

---

## 문서

| 문서 | 내용 |
|---|---|
| [설치 가이드](docs/installation.md) | Docker / Node 설치, 리버스 프록시, 환경변수, 문제 해결 |
| [업그레이드 가이드](docs/upgrade.md) | 업데이트 절차, 자동 마이그레이션 원리, 롤백 |
| [운영 가이드](docs/operations.md) | 백업, 모니터링, 성능, 한국어 검색, 스케일링 |
| [게시판](docs/board.md) | 권한·분류·답변형·첨부파일, 그누보드와의 차이 |
| [포인트](docs/point.md) | 적립 정책, 원장 설계, 플러그인 간 협력 방법 |
| [쪽지](docs/memo.md) | 프라이버시 설계, 차단, 포인트 차감, 스크랩 |
| [쇼핑몰](docs/commerce.md) | 상품·주문·재고·쿠폰·후기·문의, 커머스 설계 원칙 |
| [소셜 로그인](docs/social-login.md) | 구글·카카오·네이버·GitHub·사내 SSO 설정과 보안 |
| [방문자·팝업](docs/site-ops.md) | 접속자 집계, 팝업·배너, 개인정보 처리 |
| [결제](docs/payments.md) | PG 설정, 결제 흐름, 위조·중복 방어, 새 PG 붙이기 |
| [보안](docs/security.md) | 구현된 방어, **신뢰 모델**, 배포 체크리스트 |
| [아키텍처 (ADR)](docs/architecture.md) | 설계 결정 36건과 그 이유 |
| [플러그인 개발](docs/plugin-development.md) | manifest, API, 마이그레이션, 배포 |
| [테마 개발](docs/theme-development.md) | 템플릿 문법, 스코프, 배포 |
| [기여 가이드](CONTRIBUTING.md) | 개발 환경, 구조 규칙, PR 규칙, 테스트 함정 |
| [행동 규범](CODE_OF_CONDUCT.md) | 이슈·PR에서 지켜주셨으면 하는 것 |
| [보안 신고](SECURITY.md) | 취약점 신고 절차와 대응 약속 |

---

## 상태

**알파.** 기능은 동작하고 E2E로 검증되지만, 아직 실사용 검증이 부족합니다.
프로덕션에 올리기 전 [보안 문서](docs/security.md)의 신뢰 모델과 체크리스트를 반드시 읽어주세요.

### 어떻게 도울 수 있나요

- **써보고 막힌 곳을 알려주세요.** 설치가 안 되는 것이 가장 중요한 버그입니다 →
  [버그 신고](https://github.com/bonjin-app/brick/issues/new?template=bug_report.yml)
- **그누보드·영카트로 하던 일이 안 되는지 알려주세요.** 그게 다음에 만들 것이 됩니다 →
  [기능 제안](https://github.com/bonjin-app/brick/issues/new?template=feature_request.yml)
- **플러그인이나 테마를 만들어보세요.** 코어를 고치지 않고 어디까지 되는지가
  이 프로젝트의 실질적인 시험입니다 → [플러그인 개발](docs/plugin-development.md)
- **코드로 기여해주세요.** 개발 환경 준비와 테스트 함정은
  [CONTRIBUTING.md](CONTRIBUTING.md)에 정리해두었습니다.

한국어로 편하게 남겨주세요. 영어도 괜찮습니다.

## 라이선스

[MIT](LICENSE)
