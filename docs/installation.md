# 설치 가이드

## 요구사항

Brick은 **Node 런타임이 있는 환경**이 필요합니다. 일반 PHP 호스팅(FTP 전용)에서는 동작하지 않습니다.

| 방식 | 요구사항 | 추천 대상 |
|---|---|---|
| Docker (권장) | Docker 20+ · Docker Compose v2 | 대부분의 경우 |
| Node 직접 실행 | Node.js 20.11+ · PostgreSQL 16+ | Node 호스팅, 개발 |
| 셀프호스팅 패널 | Coolify / EasyPanel 등 | GUI로 관리하고 싶을 때 |

최소 사양: **RAM 1GB, 디스크 2GB** (Brick + PostgreSQL 기준).

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

## 방법 2 — Node 직접 실행

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

---

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `BRICK_SECRET must be set...` | `.env` 에 `BRICK_SECRET` 을 생성해 넣으세요 |
| `Brick API에 연결할 수 없습니다` | API 프로세스가 죽었습니다. `docker compose logs brick` 확인 |
| 설치 마법사가 계속 나온다 | `install.state` 가 저장되지 않음 — DB 쓰기 권한 확인 |
| 업로드가 413 실패 | 프록시의 `client_max_body_size` 와 `BRICK_MAX_UPLOAD_MB` 를 함께 올리세요 |
| 플러그인이 "files are missing" | 볼륨이 마운트되지 않았습니다. `docker compose config` 확인 |
| 한글 검색이 안 된다 | DB 로케일 문제. 아래 [운영 가이드](operations.md#한국어-검색) 참고 |

관련 문서: [업그레이드](upgrade.md) · [운영](operations.md) · [보안](security.md)
