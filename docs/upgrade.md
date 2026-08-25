# 업그레이드 가이드

Brick의 업데이트는 **명령 한 줄**로 끝나도록 설계했습니다.
DB 마이그레이션은 컨테이너가 부팅할 때 스스로 적용합니다 — 외울 명령이 없습니다.

## Docker

```bash
# 1. (권장) 백업
docker compose exec brick node /app/api/dist/backup.js dump /app/uploads/backup.dump

# 2. 업데이트
docker compose pull && docker compose up -d
```

끝입니다. 부팅 과정에서 자동으로:

1. 새 이미지의 코어 마이그레이션이 적용됩니다 (advisory lock으로 중복 실행 방지)
2. 활성 플러그인이 복원됩니다
3. 마이그레이션이 실패하면 **서버가 뜨지 않습니다** — 깨진 스키마로 서비스하는 것보다 안전합니다

## Node 직접 실행

```bash
git pull
pnpm install
pnpm build
# 프로세스 재시작 — 마이그레이션은 부팅 시 자동 적용됩니다
```

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

## 업그레이드 전 확인

- [ ] DB 백업 완료
- [ ] 업로드 파일 백업 (`brick_uploads` 볼륨)
- [ ] 사용 중인 플러그인이 새 코어 버전과 호환되는지 (`brickVersion` 확인)
- [ ] 트래픽이 적은 시간대인지

관련 문서: [설치](installation.md) · [운영](operations.md)
