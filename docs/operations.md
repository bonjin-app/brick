# 운영 가이드

## 백업

Brick의 상태는 두 곳에 있습니다: **PostgreSQL**(콘텐츠·설정)과 **볼륨**(업로드 파일·설치된 확장).
둘 다 백업해야 완전합니다.

### DB

```bash
# 백업 (custom 포맷 — 압축 + 선택 복원 가능)
docker compose exec brick node /app/api/dist/backup.js dump /app/uploads/db-$(date +%F).dump

# 복원 (기존 데이터를 덮어씁니다)
docker compose exec brick node /app/api/dist/backup.js restore /app/uploads/db-2026-08-25.dump
```

### 파일

```bash
# 업로드
docker run --rm -v brick_uploads:/d -v "$PWD":/b alpine \
  tar czf /b/uploads-$(date +%F).tgz -C /d .

# 플러그인 · 테마
docker run --rm -v brick_plugins:/d -v "$PWD":/b alpine tar czf /b/plugins.tgz -C /d .
docker run --rm -v brick_themes:/d  -v "$PWD":/b alpine tar czf /b/themes.tgz  -C /d .
```

### 자동 백업 (cron)

```bash
# 매일 새벽 4시
0 4 * * * cd /srv/brick && docker compose exec -T brick \
  node /app/api/dist/backup.js dump /app/uploads/db-$(date +\%F).dump
```

오래된 백업 정리도 함께 걸어두세요 — 업로드 볼륨이 백업으로 가득 차는 것이 흔한 사고입니다.

---

## 모니터링

| 엔드포인트 | 용도 | 특징 |
|---|---|---|
| `GET /healthz` | liveness | DB를 건드리지 않음. 프로세스 생존만 확인 |
| `GET /readyz` | readiness | DB 연결 확인. 실패 시 503 |

Docker 이미지에 `HEALTHCHECK` 가 내장되어 있어 `docker compose ps` 에 상태가 표시됩니다.

k8s 예시:

```yaml
livenessProbe:
  httpGet: { path: /healthz, port: 3001 }
  initialDelaySeconds: 20
readinessProbe:
  httpGet: { path: /readyz, port: 3001 }
  periodSeconds: 10
```

---

## 성능

### 캐시

렌더 결과는 PostgreSQL 기반 태그 캐시에 저장됩니다 (기본 TTL 300초).
페이지·테마·플러그인·설정이 변경되면 자동 무효화됩니다.

트래픽이 커지면 Redis로 전환하세요:

```yaml
environment:
  REDIS_URL: redis://redis:6379
```

### 정리 작업

만료된 세션과 캐시 레코드는 **1시간 주기로 자동 정리**됩니다 (`MaintenanceService`).
Redis 없이 동작하는 설계의 대가이므로 코어가 책임집니다 — 별도 cron이 필요 없습니다.

### 인덱스

주요 인덱스는 마이그레이션에 포함되어 있습니다. 게시글이 수십만 건을 넘어가면
`EXPLAIN ANALYZE` 로 실제 쿼리를 확인하고 필요한 복합 인덱스를 추가하세요.

---

## 한국어 검색

**현재 제약**: 코어 검색은 `ILIKE` 기반입니다. 정확하지만 데이터가 많아지면 느려집니다.

PostgreSQL의 기본 전문 검색(`to_tsvector('simple', ...)`)은 한국어에서 두 가지 문제가 있습니다:

1. DB 로케일이 `C` 이면 한글을 토큰으로 인식하지 못합니다 (공식 postgres 이미지는 UTF-8이라 괜찮습니다)
2. 조사·어미가 붙는 교착어 특성상 `simple` 사전으로는 "수정된" ↔ "수정" 이 매칭되지 않습니다

### 권장: pg_trgm

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX pages_title_trgm_idx ON pages USING gin (title gin_trgm_ops);
CREATE INDEX pages_text_trgm_idx  ON pages USING gin (plain_text gin_trgm_ops);
CREATE INDEX board_posts_trgm_idx ON board_posts USING gin (title gin_trgm_ops);
```

trigram 인덱스는 `ILIKE '%검색어%'` 를 가속하므로 코드 변경 없이 즉시 효과가 있습니다.

### 대안

한국어 형태소 분석이 필요하면 `pg_bigm` 이나 외부 검색엔진(Meilisearch, Typesense)을
플러그인으로 연동하는 방향을 검토하세요.

---

## 로그

```bash
docker compose logs -f brick          # 전체
docker compose logs --since 1h brick  # 최근 1시간
```

프로덕션에서는 로그 드라이버를 설정해 디스크가 차지 않게 하세요:

```yaml
logging:
  driver: json-file
  options: { max-size: "10m", max-file: "3" }
```

---

## 스케일링

Brick은 **단일 인스턴스**를 전제로 설계되었습니다 (ADR-1). 여러 인스턴스로 늘리려면:

| 항목 | 필요한 조치 |
|---|---|
| 요청 제한 | 현재 인메모리 → `CacheProvider` 기반 구현으로 교체 필요 |
| 캐시 | `REDIS_URL` 설정 (PostgreSQL 캐시도 공유되지만 Redis가 빠름) |
| 업로드 파일 | `STORAGE_DRIVER=s3` 로 전환 (로컬 디스크는 공유되지 않음) |
| 확장 파일 | 공유 볼륨(NFS) 또는 이미지에 포함 |
| 마이그레이션 | advisory lock이 이미 처리 — 추가 조치 불필요 |

대부분의 설치형 사이트는 단일 인스턴스로 충분합니다. 수직 확장을 먼저 검토하세요.

관련 문서: [설치](installation.md) · [업그레이드](upgrade.md) · [보안](security.md)
