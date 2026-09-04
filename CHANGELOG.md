# 변경 이력

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를, 버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다.
릴리스마다 GitHub Releases 에 배포본(`brick-X.Y.Z.tar.gz`)·체크섬·Docker 이미지(`ghcr.io/bonjin-app/brick:X.Y.Z`)가 함께 나옵니다.
업그레이드 절차는 [docs/upgrade.md](docs/upgrade.md).

## [Unreleased]

### 변경
- Docker 이미지가 약 1/3 작아진다 — `chown -R /app` 레이어가 복사한 파일 전부를 중복 저장하고 있었다(54.6MB).
  각 `COPY --chown` 으로 처음부터 소유자를 맞춘다. CI 가 이미지 크기와 큰 레이어를 로그에 남긴다
- 갤러리·웹진 목록의 서버 썸네일(400×400)에 `width/height`·`decoding="async"` 를 적어 목록이 그려질 때 칸이 밀리지 않게(CLS)

## [0.2.2] - 2026-09-04

### 변경
- 업로드 파일(`/uploads/*`)은 키가 UUID 라 덮어쓰이지 않으므로 `max-age=31536000, immutable`(전에는 하루).
  정적 파일 전부에 ETag·Last-Modified 를 내고 조건부 요청(If-None-Match·If-Modified-Since)에 304 로 답한다

### 추가
- **업로드 이미지 최적화** — 원본을 2400px 이내로 줄이고 EXIF(촬영 위치 포함)를 지우며 목록용 정사각
  WebP 썸네일을 만든다. 미디어 목록에 치수·썸네일, 프로필 이미지는 256px WebP.
  플러그인 계약 `ctx.images`(optimize·thumbnail) — 게시판 인라인 이미지(1600px)·첨부 이미지(2000px)에 적용.
  sharp 가 없는 환경에서는 원본을 그대로 저장한다(업로드는 막지 않는다)
- 갤러리·웹진 목록의 썸네일이 첨부 **원본**을 가리키던 것 → 첨부마다 400px WebP 썸네일(`board_attachments.thumb_key`),
  에디터가 넣는 인라인 이미지는 `data-thumb`·치수·`loading="lazy"` 를 함께 남긴다(새니타이저가 URL 검사 후 허용)
- 사진만 있는 글도 등록된다 — 갤러리 게시판에서 "내용을 입력해주세요"로 막히던 것(서버·에디터 양쪽)
- **공유 미리보기 이미지 올리기** — 설정에서 아무 사진을 고르면 서버가 정확히 1200×630 JPEG 로 잘라 저장하고
  `site.og_image` 에 즉시 반영한다(이전 파일은 지움). 비율이 맞지 않으면 카카오톡·페이스북이 제멋대로 자르기 때문
- 썸네일 백필 도구 `node api/dist/backfill-thumbs.js` — 업그레이드한 사이트의 옛 이미지에 썸네일·치수를 채운다 — 미디어와 게시판 첨부 모두(원본은 건드리지 않음, 멱등, `--dry`)

## [0.2.1] - 2026-09-04

### 추가
- **Docker 이미지가 linux/arm64 도 담는다** — Apple Silicon·AWS Graviton·Oracle Ampere·라즈베리파이에서
  에뮬레이션 없이 동작. 두 아키텍처를 각자 네이티브 러너에서 빌드해 하나의 매니페스트로 합친다
- 이미지에 SBOM(패키지 목록)·provenance(빌드 출처) 첨부 — `docker buildx imagetools inspect` 로 확인
- 사이트 설정 **공유 미리보기 이미지**(`site.og_image`) → 테마가 `og:image`·`twitter:card` 를 낸다(절대 URL 로 변환)
- CI 가 **docker compose 로** 이미지를 띄워 설치 마법사·첫 화면·버전 보고까지 검증(문서의 설치 경로 그대로) — 위 헬스체크 버그를 이것이 잡았다
- 이메일 인증 메일에 HTML 본문(버튼) — 비밀번호 재설정 메일과 같은 모양

### 수정
- **Docker 이미지의 헬스체크가 늘 실패하던 것** — Next standalone 은 `HOSTNAME` 환경변수를 바인딩 주소로
  쓰는데 Docker 가 그것을 컨테이너 호스트명으로 채운다. 그래서 컨테이너 안의 `127.0.0.1:3000` 이 응답하지
  않아 `HEALTHCHECK` 와 compose 의 healthcheck 가 영원히 unhealthy 였다(v0.1.0·v0.2.0 이미지 해당).
  런처와 entrypoint 가 `0.0.0.0` 을 강제한다 — 특정 인터페이스만 열려면 `BRICK_WEB_HOST`.
  리눅스 로그인 셸(HOSTNAME 이 설정됨)에서 FTP 배포본을 띄울 때도 같은 문제였다.
- fastify 5.12.1 로 고정 — trustProxy hop-count 하의 X-Forwarded-* 스푸핑과 스키마 검증 우회(2건).
  `@nestjs/platform-fastify` 가 5.11.3 을 고정하므로 overrides 로 올린다

### 변경
- Next 프록시가 텍스트 응답(서버 렌더 HTML·테마 CSS·JSON)을 br/gzip 으로 압축한다 — 홈 81KB → 약 16KB
- `?v=` 스탬프가 붙은 테마 자산은 `max-age=31536000, immutable`
- 보안 헤더에 Permissions-Policy 추가(API·Next 화면 모두); 설치 문서에 이미지 태그 고정 권장
- API 가 없거나 렌더가 실패했을 때 text/plain 한 줄 대신 다시 시도 버튼이 있는 HTML 안내 화면(외부 자산 없음, noindex)

## [0.2.0] - 2026-09-02

### 추가
- 기본 테마 전면 재설계(라이트·다크 두 벌, 프리미티브 계약, 랜딩 블록 8종, 아이콘 스프라이트) — ADR-79~83
- 두 번째 동봉 테마 **Editorial**(종이색·명조·가운데 제호) — ADR-90
- Tailwind v4 저작 툴체인(테마 CSS 컴파일·관리 화면 유틸리티) — ADR-91
- 게시판: 목록 스킨 3종, 이전/다음글, 공유·인쇄, 이미지 삽입, 자동 임시저장, 알림 메일, 게시판 그룹, 관련 링크, 일괄 작업(ADR-84~86)
- 회원: 프로필 이미지, 닉네임 변경 주기, 공개 프로필 카드, 관리자 메모, 이메일 변경(ADR-85·88)
- 모더레이션: 금지 단어·사칭 이름·가입 금지 도메인·접속 차단 IP·분류 필수(ADR-87)
- 관리 화면: 설정을 주제별 카드로, 화면 없던 설정 아홉 개, 대시보드 빠른 작업·최근 활동(ADR-89), 1024px 미만 드로어
- 대시보드 **새 버전 알림**과 배포본 **`update.mjs`**(다운로드·SHA256 검증·교체·롤백) — ADR-92
- 점검 도구 `scripts/contrast-audit.js`(대비)·`scripts/ui-audit.js`(넘침·라벨·터치 영역)

### 변경
- 관리 화면·공개 화면 모두 375px 부터 동작(모바일 표 목록은 줄로 쌓음)
- 검색 색인에서 블록 CSS 원문 제거, 발췌문은 단어 경계에서 끊음
- 이모지 아이콘을 테마 스프라이트 심볼로 교체

### 수정
- 도커 컴포즈가 가리키는 `ghcr.io/bonjin-app/brick` 이미지가 발행되지 않던 것 — 릴리스 태그마다 발행
- 비로그인 화면이 401 을 받으러 가던 헛요청 제거, 로그인 뒤 원래 화면으로 복귀(`?next=`)

## [0.1.0] - 2026-09-01

첫 공개 알파. 설치형 CMS 코어(페이지 빌더·회원·미디어·메뉴·검색·테마·플러그인), 동봉 플러그인
8종(게시판·쇼핑몰·토스결제·쪽지·포인트·설문·헬프데스크·사이트 도구), 그누보드 이전 도구,
FTP 배포본과 Docker 이미지, E2E 스모크 2,500+ 항목.

[Unreleased]: https://github.com/bonjin-app/brick/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/bonjin-app/brick/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/bonjin-app/brick/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bonjin-app/brick/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bonjin-app/brick/releases/tag/v0.1.0
