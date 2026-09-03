# 설치 가이드

## 요구사항

Brick은 **Node 런타임이 있는 환경**이 필요합니다.

| 방식 | 요구사항 | 추천 대상 |
|---|---|---|
| Docker (권장) | Docker 20+ · Docker Compose v2 | 대부분의 경우 |
| **배포본 업로드 (FTP)** | Node.js 20.11+ 지원 호스팅 · PostgreSQL 14+ | 파일을 올려서 쓰고 싶을 때 |
| 소스 빌드 | Node.js 20.11+ · pnpm 9 · PostgreSQL 14+ | 개발 |

최소 사양: **RAM 1GB, 디스크 2GB** (Brick + PostgreSQL 기준).

> ⚠️ **순수 PHP 호스팅(FTP만 제공, Node 없음)에서는 동작하지 않습니다.**
> Node.js 실행이 가능한 호스팅이어야 합니다. cPanel/Plesk의 "Node.js App" 기능,
> 또는 VPS가 해당됩니다.

---

## 방법 1 — Docker (권장)

```bash
# 1. compose 파일 받기
curl -O https://raw.githubusercontent.com/bonjin-app/brick/main/docker-compose.yml

# 2. 시크릿 생성 (필수)
{
  echo "BRICK_SECRET=$(openssl rand -base64 32)"
  echo "POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')"
} > .env

# 3. 실행
docker compose up -d

이미지는 릴리스마다 `ghcr.io/bonjin-app/brick:X.Y.Z` 와 `:latest` 로 발행됩니다. 운영에서는 `.env` 에
`BRICK_IMAGE_TAG=0.2.0` 처럼 버전을 고정해 두고, 업데이트할 때 값을 올리는 것을 권장합니다 —
`latest` 를 따라가면 `docker compose pull` 시점에 어떤 버전이 올지 미리 알 수 없습니다.
```

브라우저에서 `http://localhost:3000` 을 열면 설치 마법사가 나타납니다.
사이트 이름과 관리자 계정만 입력하면 끝입니다 — **DB 접속 정보는 묻지 않습니다** (compose가 이미 주입).

### 상태 확인

```bash
docker compose ps          # 컨테이너 상태
docker compose logs -f brick   # 로그
curl localhost:3000/api/install/status
```

---

## 방법 2 — 배포본 업로드 (FTP/SFTP)

**파일을 올리고 브라우저에서 설치**하는 방식입니다.

## 사이트 유형 (스타터)

설치 화면에서 사이트 유형을 고르면 기본 구성이 함께 만들어집니다 — 설치가
끝나면 **이미 돌아가는 사이트**가 있습니다.

| 유형 | 만들어지는 것 |
|---|---|
| **커뮤니티** | 홈(최신글 모아보기) · 소개 · 공지사항/자유게시판/질문답변 · 헤더 메뉴 |
| **쇼핑몰** | 홈(상품 목록+공지) · 소개 · 이용 안내(교환·반품 뼈대) · 공지사항 · 쇼핑몰 메뉴 |
| **회사 홈페이지** | 홈 · 회사 소개 · 서비스 · 공지사항 · 1:1 문의 페이지 |
| **빈 사이트** | 아무것도 만들지 않습니다 |

만들어진 것은 전부 **일반 페이지·게시판·메뉴**입니다. 관리자 → 페이지 /
메뉴 에서 그대로 수정·삭제할 수 있고, 특별 취급되는 것이 없습니다.
자리표시 문구를 자기 내용으로 바꾸는 것이 설치 후 첫 할 일입니다.
빌드도 `npm install` 도 필요 없습니다 — 배포본에 모두 포함되어 있습니다.

### 1. 배포본 받기

[Releases](https://github.com/bonjin-app/brick/releases)에서 `brick-x.y.z.tar.gz` 를 내려받아 압축을 풉니다.

직접 만들려면:

```bash
git clone https://github.com/bonjin-app/brick.git && cd brick
pnpm install && bash scripts/build-release.sh
# → dist-release/brick-<버전>.tar.gz
```

### 2. 업로드

압축을 푼 `brick/` 안의 내용을 서버에 올립니다. 구조는 이렇습니다:

```
server.js          ← 실행 진입점 (이것만 실행하면 됩니다)
node_modules/      ← 의존성 (이미 포함)
api/               ← 백엔드 (빌드 완료)
web/               ← 프론트엔드 (빌드 완료)
plugins/           ← 게시판 · 쇼핑몰 · 결제
themes/            ← 기본 테마
data/              ← 설정 파일이 여기 생성됩니다 (쓰기 권한 필요)
uploads/           ← 업로드 파일 (쓰기 권한 필요)
```

**`data`, `uploads`, `plugins`, `themes` 에 쓰기 권한을 주세요.**
FTP 클라이언트에서 권한을 755(또는 707)로 변경할 수 있습니다.

### 3. 실행

| 환경 | 방법 |
|---|---|
| cPanel | Setup Node.js App → Application startup file에 `server.js` → Create |
| Plesk | Node.js → Application Startup File `server.js` → Enable |
| VPS 직접 | `node server.js` 또는 `pm2 start server.js --name brick` |

포트를 지정하려면 `PORT=8080 node server.js`.

### 4. 브라우저에서 설치

사이트에 접속하면 설치 화면이 나타납니다.

1. **데이터베이스** — 호스팅에서 발급받은 PostgreSQL 정보 입력 → 연결 테스트 → 저장
2. **재시작** — 호스팅 패널의 Restart 버튼 (또는 프로세스 재실행)
3. **사이트 정보** — 사이트명, 관리자 계정 입력 → 완료

DB 정보는 `data/brick.config.json` 에 저장되며, 세션 시크릿은 **자동 생성**됩니다
(직접 만들 필요 없습니다). 이 파일은 0600 권한으로 생성됩니다.

> PostgreSQL 데이터베이스는 **미리 만들어져 있어야** 합니다.
> 호스팅 관리 화면에서 DB와 사용자를 먼저 생성하세요.
> 무료 PostgreSQL이 필요하면 Neon, Supabase, Railway 등을 쓸 수 있습니다.

---

## 방법 3 — 소스에서 실행 (개발)

```bash
git clone https://github.com/bonjin-app/brick.git
cd brick
pnpm install
pnpm build

cp .env.example .env
# .env 에서 DATABASE_URL 과 BRICK_SECRET 을 설정하세요

# API (내부) — 부팅 시 마이그레이션을 자동 적용합니다
node apps/api/dist/main.js &

# Web (공개)
cd apps/web && node_modules/.bin/next start -p 3000
```

프로덕션에서는 `pm2`, `systemd` 등 프로세스 관리자로 두 프로세스를 관리하세요.

---

## 리버스 프록시 (프로덕션 필수)

HTTPS를 위해 Nginx/Caddy를 앞에 두고, `BRICK_TRUST_PROXY=true` 를 설정하세요
(설정하지 않으면 요청 제한이 모든 사용자를 같은 IP로 취급합니다).

### Nginx 예시

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # 업로드 최대 크기 — BRICK_MAX_UPLOAD_MB 와 맞추세요
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

### Caddy 예시

```
example.com {
    reverse_proxy 127.0.0.1:3000
}
```

---

## 환경변수

| 변수 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | PostgreSQL 연결 문자열 |
| `BRICK_SECRET` | ✅ (프로덕션) | — | 쿠키 서명 키. `openssl rand -base64 32` |
| `NODE_ENV` | | `development` | `production` 이면 보안 검증이 강화됩니다 |
| `PORT` | | `3000` | 공개 웹 포트 |
| `BRICK_API_PORT` | | `3001` | 내부 API 포트 (외부 노출 금지) |
| `BRICK_TRUST_PROXY` | | `false` | 프록시 뒤에 있으면 `true` |
| `BRICK_MAX_UPLOAD_MB` | | `50` | 업로드 최대 크기 |
| `BRICK_AUTO_MIGRATE` | | `true` | 부팅 시 자동 마이그레이션 |
| `BRICK_PLUGINS_DIR` | | `plugins` | 플러그인 디렉터리 |
| `BRICK_THEMES_DIR` | | `themes` | 테마 디렉터리 |
| `BRICK_UPLOADS_DIR` | | `uploads` | 업로드 디렉터리 |
| `REDIS_URL` | | — | 설정 시 Redis 캐시/큐 사용 (선택) |

`NODE_ENV=production` 인데 `BRICK_SECRET` 이 비었거나 약한 값이면 **부팅을 거부합니다.**
잘못된 설정으로 조용히 뜨는 것보다 안전하기 때문입니다.

### 설정 파일

환경변수를 쓸 수 없는 환경(FTP 호스팅)을 위해 설정 파일도 지원합니다.

- 위치: `data/brick.config.json` (`BRICK_CONFIG_PATH` 로 변경 가능)
- 내용: `databaseUrl`, `secret`, `siteUrl`
- 생성: 웹 설치 마법사가 자동으로 만듭니다 (권한 0600)
- **우선순위: 환경변수 > 설정 파일** — Docker/k8s에서는 환경변수가 이기므로
  컨테이너를 다시 만들어도 옛 설정 파일이 방해하지 않습니다

`DATABASE_URL` 과 설정 파일이 **모두 없으면** Brick은 실패하지 않고
**설치 모드**로 뜹니다 — 브라우저에서 DB 정보를 입력할 수 있게 하기 위함입니다.
이 상태에서 `/readyz` 는 503을 반환합니다 (아직 트래픽을 받을 상태가 아니므로).

---

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `BRICK_SECRET must be set...` | `.env` 에 `BRICK_SECRET` 을 생성해 넣으세요 |
| `Brick API에 연결할 수 없습니다` | API 프로세스가 죽었습니다. `docker compose logs brick` 확인 |
| 설치 마법사가 계속 나온다 | `install.state` 가 저장되지 않음 — DB 쓰기 권한 확인 |
| 업로드가 413 실패 | 프록시의 `client_max_body_size` 와 `BRICK_MAX_UPLOAD_MB` 를 함께 올리세요 |
| 플러그인이 "files are missing" | 볼륨이 마운트되지 않았습니다. `docker compose config` 확인 |
| 설치 화면에서 "설정 파일을 쓸 수 없습니다" | `data` 디렉터리에 쓰기 권한을 주세요 (755 또는 707) |
| 재시작 후에도 설치 화면이 나온다 | 프로세스가 실제로 재시작되지 않았습니다. 패널에서 Stop → Start |
| `EADDRINUSE` 로 시작 실패 | 이전 프로세스가 포트를 잡고 있습니다. 런처가 자동 정리하지만, 안 되면 패널에서 완전히 중지 후 시작 |
| 플러그인 활성화가 500 | 배포본이 손상되었을 수 있습니다. `node_modules` 가 루트에 있는지 확인하세요 |
| 한글 검색이 안 된다 | DB 로케일 문제. 아래 [운영 가이드](operations.md#한국어-검색) 참고 |

관련 문서: [업그레이드](upgrade.md) · [운영](operations.md) · [보안](security.md)
