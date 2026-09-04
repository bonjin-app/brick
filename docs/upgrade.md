# 업그레이드 가이드

Brick의 업데이트는 **명령 한 줄**로 끝나도록 설계했습니다.
DB 마이그레이션은 컨테이너가 부팅할 때 스스로 적용합니다 — 외울 명령이 없습니다.

## 플러그인·테마: 원클릭 업데이트

관리자 → 플러그인 → **업데이트 확인**. 새 버전이 있으면 목록에 나오고,
**업데이트** 버튼 하나로 내려받아 설치됩니다. 마이그레이션도 자동입니다.

원격 업데이트는 **서명 검증을 통과해야만** 설치됩니다:

- 처음 설치할 때 배포자의 공개키가 고정됩니다
- 이후 업데이트 ZIP 은 그 키의 서명이 있어야 합니다
- 서버가 뚫려도, 주소가 조작되어도, 다른 키로 서명한 파일은 거부됩니다
- 낮은 버전으로 되돌리는 "업데이트"도 거부됩니다

배포자 키가 바뀌었다면(키 분실 등) 새 ZIP 을 **직접 업로드**해야 합니다 —
그것이 새 키를 신뢰한다는 운영자의 명시적 결정입니다.

배포자용 서명 도구는 [플러그인 개발](plugin-development.md)을 보세요.

## Docker

```bash
# 1. (권장) 백업
docker compose exec brick node /app/api/dist/backup.js dump /app/uploads/backup.dump

# 2. 업데이트
docker compose pull && docker compose up -d
```

끝입니다. 부팅 과정에서 자동으로:

1. 새 이미지의 코어 마이그레이션이 적용됩니다 (advisory lock으로 중복 실행 방지)

이미지는 릴리스 태그마다 `ghcr.io/bonjin-app/brick:X.Y.Z` 와 `:latest` 로 발행됩니다.
특정 버전에 고정하려면 `docker-compose.yml` 의 태그를 바꾸세요.
2. 활성 플러그인이 복원됩니다
3. 마이그레이션이 실패하면 **서버가 뜨지 않습니다** — 깨진 스키마로 서비스하는 것보다 안전합니다

## 새 버전 알림

관리자 대시보드가 열릴 때 GitHub Releases 의 최신 태그를 확인해(6시간 캐시, 4초 타임아웃)
새 버전이 있으면 카드와 배너로 알립니다. 교체는 하지 않습니다 — 아래 방법 중 하나로 운영자가
합니다. 외부 접속을 원치 않으면 **설정 → 확장 → 새 버전 알림**을 끄세요(`system.update_check`).
버전은 `/api/admin/version`(관리자만)으로도 볼 수 있습니다. 공개 헬스체크에는 버전을 싣지 않습니다.

## 배포본 (FTP · Node 직접 실행): `update.mjs`

배포본에는 업데이트 도구가 들어 있습니다. **서버를 멈춘 뒤** 실행합니다.

```bash
node update.mjs --check                   # 새 버전이 있는지만 본다
node update.mjs                           # 최신 릴리스로 (내려받기 → SHA256 검증 → 교체)
node update.mjs 0.3.0                     # 특정 버전으로
node update.mjs --from brick-0.3.0.tar.gz # 미리 내려받은 파일로 (폐쇄망)
node update.mjs --rollback                # 직전 백업으로 되돌린다
```

- 앱 파일(`server.js` `api/` `web/` `node_modules/` …)만 바꿉니다. **`data/` `uploads/` 와 운영자가 설치한
  플러그인·테마는 건드리지 않습니다.** 동봉 플러그인·테마는 같은 이름만 갱신합니다.
- 이전 파일은 `backup/v<이전버전>-<시각>/` 에 남고, `--rollback` 이 그것을 되돌립니다.
  DB 마이그레이션은 되돌리지 않습니다 — 코어 마이그레이션은 앞으로만 갑니다. 큰 판올림 전에는
  `node api/dist/backup.js dump` 로 DB 를 받아 두세요.
- 서버가 실행 중이면(`data/brick.pid` 의 프로세스가 살아 있으면) 거부합니다. 파일을 바꾸는 동안
  Node 가 옛 모듈을 들고 있으면 반쯤 바뀐 상태로 동작할 수 있기 때문입니다.
- 체크섬이 다르면 중단합니다. 릴리스의 `SHA256SUMS.txt` 와 대조합니다.

## 배포본 업로드 (FTP, 수동)

```
1. data / uploads / plugins / themes 를 백업합니다 (설정·업로드·설치한 확장)
2. 새 배포본에서 다음만 덮어씁니다:
     server.js
     node_modules/
     api/
     web/
   ※ data, uploads, plugins, themes 는 그대로 두세요
3. 호스팅 패널에서 Restart
```

재시작하면 DB 마이그레이션이 자동 적용됩니다. 설정 파일(`data/brick.config.json`)은
그대로 유지되므로 DB 정보를 다시 입력할 필요가 없습니다.

> `plugins/` 를 덮어쓰면 사용자가 업로드한 플러그인이 지워집니다.
> 동봉 플러그인(게시판·쇼핑몰·결제)만 갱신하려면 해당 폴더만 개별로 덮어쓰세요.

## Node 직접 실행

```bash
git pull
pnpm install
pnpm build
# 프로세스 재시작 — 마이그레이션은 부팅 시 자동 적용됩니다
```

## 이미 올라온 이미지의 썸네일 채우기 (0.2.x → 그 다음 버전)

이미지 최적화(축소·EXIF 제거·썸네일)는 **업로드 시점**에 동작합니다. 그 전부터 운영해 온 사이트에는
썸네일이 없는 파일이 남아 목록이 원본을 내려보냅니다. 한 번만 돌리면 빠진 것을 채웁니다.

```bash
# Docker
docker compose exec brick node /app/api/dist/backfill-thumbs.js --dry   # 무엇을 할지 먼저 본다
docker compose exec brick node /app/api/dist/backfill-thumbs.js

# 배포본 (FTP·직접 실행)
node api/dist/backfill-thumbs.js --dry
node api/dist/backfill-thumbs.js
```

- **원본은 건드리지 않습니다.** 다시 압축하면 화질이 한 번 더 깎이고, 운영자가 올린 그대로여야 하는
  파일(정밀한 로고·인쇄용)이 있을 수 있습니다. 새로 만드는 것은 목록용 썸네일과 DB 의 치수뿐입니다.
- 여러 번 돌려도 같은 결과입니다(이미 썸네일이 있는 항목은 건너뜁니다). 파일을 못 읽는 항목은
  그것만 건너뛰고 계속합니다.
- `sharp` 를 쓸 수 없는 환경에서는 안내를 남기고 종료합니다 — 그 서버에서는 원본이 계속 쓰입니다.

## 자동 마이그레이션 원리

| 항목 | 동작 |
|---|---|
| 적용 시점 | API 프로세스 부팅 시 (HTTP 리스닝 **전**) |
| 중복 방지 | `core_migrations` 테이블 + PostgreSQL advisory lock |
| 원자성 | 각 마이그레이션이 개별 트랜잭션 — 부분 적용이 남지 않음 |
| 실패 시 | 프로세스 종료 (exit 1). 컨테이너가 재시작 루프에 들어가 즉시 알 수 있음 |
| 비활성화 | `BRICK_AUTO_MIGRATE=false` (수동 제어가 필요한 대규모 운영) |

수동으로 실행하려면:

```bash
docker compose exec brick node /app/api/dist/migrate.js
```

## 플러그인 업데이트

관리자 → 플러그인 → 새 버전 ZIP 업로드. 그것으로 끝입니다.

- 활성 상태였다면 **자동으로 재적재**됩니다 (비활성화→활성화를 오갈 필요 없음)
- 새 버전에 추가된 `migrations/*.sql` 이 이때 적용됩니다
- 이미 적용된 마이그레이션은 `plugin_migrations` 테이블로 건너뜁니다

## 왜 "관리자 화면에서 업데이트" 버튼이 없는가

워드프레스처럼 관리자에서 클릭 한 번으로 업데이트하는 기능은 **의도적으로 넣지 않았습니다.**

자기 파일을 덮어쓰는 자체 업데이터는 다음 상황에서 사이트를 복구 불가 상태로 만듭니다:

- 다운로드 중 연결이 끊겨 파일이 **부분만** 교체됨
- 실행 중인 프로세스가 잡고 있는 파일을 교체하지 못해 **버전이 섞임**
- 공유 호스팅에서 쓰기 권한이 일부 경로에만 있어 **중간에 실패**
- 새 코드와 옛 코드가 동시에 로드되어 **정의되지 않은 동작**

PHP는 요청마다 파일을 다시 읽으므로 파일 교체가 상대적으로 안전하지만,
Node는 프로세스가 모듈을 메모리에 유지하므로 위험이 더 큽니다.

대신 안전한 경로를 제공합니다:

| 방식 | 명령 | 원자성 |
|---|---|---|
| Docker | `docker compose pull && up -d` | ✅ 이미지 단위로 교체 |
| 배포본 | 파일 덮어쓰기 → 재시작 | ⚠️ 사용자가 백업 후 수행 |

향후 자체 업데이터를 넣는다면 **원자적 교체**(새 버전을 다른 디렉터리에 내려받아
검증한 뒤 심볼릭 링크를 바꾸는 방식)로 설계해야 합니다.

## 롤백

```bash
# 1. 이전 이미지로 되돌리기
docker compose down
# docker-compose.yml 의 image 태그를 이전 버전으로 지정 (예: :0.1.0)
docker compose up -d

# 2. 스키마도 되돌려야 한다면 백업에서 복원
docker compose exec brick node /app/api/dist/backup.js restore /app/uploads/backup.dump
```

> **주의**: Brick은 down 마이그레이션(되돌리기 SQL)을 제공하지 않습니다.
> 스키마 롤백이 필요하면 백업 복원이 유일하게 안전한 경로입니다.
> 그래서 업그레이드 전 백업을 권장합니다.

## 현재 버전 확인

```bash
# Docker
docker compose exec brick node -p "require('/app/api/package.json').version"

# 배포본
node -p "require('./package.json').version"
```

## 업그레이드 전 확인

- [ ] DB 백업 완료
- [ ] 업로드 파일 백업 (`brick_uploads` 볼륨)
- [ ] 사용 중인 플러그인이 새 코어 버전과 호환되는지 (`brickVersion` 확인)
- [ ] 트래픽이 적은 시간대인지

관련 문서: [설치](installation.md) · [운영](operations.md)
