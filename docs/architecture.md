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

## ADR-10. 마이그레이션은 부팅 시 자동 적용된다

- 설치형 CMS의 업데이트 경험은 "파일 교체 후 관리자에서 클릭" 수준이어야 한다.
  별도 마이그레이션 명령을 외우게 하면 `docker compose pull && up -d` 라는 약속이 깨진다.
- 그래서 API 프로세스가 HTTP 리스닝 **전에** 마이그레이션을 실행한다.
  advisory lock으로 다중 인스턴스 동시 부팅에도 한 번만 적용된다.
- 실패하면 프로세스를 종료한다(exit 1). 깨진 스키마로 서비스하는 것보다 안전하고,
  컨테이너 재시작 루프로 운영자가 즉시 인지한다.
- down 마이그레이션은 제공하지 않는다 — 롤백은 백업 복원이 유일하게 안전한 경로다.
- 플러그인 마이그레이션은 활성화 시점에 적용되고, ZIP 재업로드 시 자동 재적재로 새 버전이 반영된다.
- `BRICK_AUTO_MIGRATE=false` 로 끌 수 있다(대규모 운영에서 수동 제어가 필요한 경우).

## ADR-11. 배포 산출물은 pnpm deploy로 만든다

- pnpm 워크스페이스의 `node_modules`는 전역 스토어를 가리키는 심볼릭 링크라
  Docker 이미지에 그대로 복사하면 런타임에 모듈을 찾지 못한다.
- `pnpm deploy --filter=@brick/api --prod` 가 자기완결적 번들을 만든다. Dockerfile은 이것을 복사한다.
- Next.js는 `output: "standalone"` + `outputFileTracingRoot`(모노레포 루트)로 별도 번들을 만든다.
- CI가 이 두 경로를 매번 검증한다 — 로컬에서 되는데 이미지에서 깨지는 사고를 막는다.

## 알려진 제약

- **한국어 전문 검색**: `to_tsvector('simple', ...)`는 DB 로케일이 C면 한글을 토큰으로 인식하지
  못하고, 교착어 특성상 조사/어미 때문에 `simple` 사전으로는 매칭 품질이 낮다.
  그래서 코어 검색은 `ILIKE` 기반으로 구현했다 — 정확하지만 데이터가 많아지면 느려진다.
  운영 시 `pg_trgm` GIN 인덱스를 추가하면 코드 변경 없이 가속된다([운영 가이드](operations.md#한국어-검색)).
- **단일 인스턴스 전제**: 요청 제한이 인메모리다. 다중 인스턴스로 확장할 때는
  `CacheProvider` 기반 구현으로 교체해야 한다.
- **감사 로그/2FA/이메일 미구현**: [보안 문서](security.md#알려진-제약) 참고.

## ADR-12. 플러그인 관리 화면은 선언적 리소스로 생성한다

문제: 플러그인은 ZIP으로 배포되므로 Next.js 라우트(React 페이지)를 추가할 수 없다.
그런데 쇼핑몰처럼 큰 기능은 관리 화면 없이는 성립하지 않는다.

검토한 선택지:
- (a) 플러그인이 Next.js 소스를 포함 → 설치 시 재빌드 필요. 테마와 같은 이유로 탈락(ADR-6).
- (b) 플러그인이 관리자 HTML을 서버 렌더 → 폼 상태 관리를 매 플러그인이 재구현해야 한다.
- (c) **플러그인이 "무엇을 편집할 수 있는가"만 선언하고 코어가 UI를 생성** ← 선택

`ctx.registerAdminResource({ fields, basePath, ... })` 로 필드 스키마를 등록하면
코어 관리자(`/admin/x/<plugin>/<resource>`)가 목록·폼·검증·페이지네이션을 런타임에 만든다.
플러그인은 REST 규약(GET/POST/PUT/DELETE)만 구현한다.

효과: 워드프레스 플러그인이 각자 관리 화면을 짜서 UI가 파편화되는 문제를 피하고,
빌드 없이 ZIP 설치만으로 일관된 관리 화면을 얻는다. brick-shop이 이 방식으로
관리 화면 4개를 만든다.

한계: 완전히 자유로운 커스텀 화면(대시보드형 차트 등)은 만들 수 없다.
그런 경우 `registerAdminMenu` + 자체 페이지 조합이 필요하며, 향후 과제다.

## ADR-13. 플러그인에 진짜 트랜잭션을 제공한다

초기에 플러그인 DB 표면을 `execute()` 하나로 두고, 트랜잭션은 플러그인이
`execute("BEGIN")` / `execute("COMMIT")` 으로 처리하게 했다. **이것은 조용히 깨진다** —
커넥션 풀에서 매 `execute` 가 다른 커넥션을 받을 수 있어 BEGIN과 후속 문장이
같은 트랜잭션에 있다는 보장이 없다. (쇼핑몰 재고 테스트에서 실제로 발견)

그래서 `PluginDb` 계약에 `transaction(fn)` 을 추가했다. 콜백 전체가 하나의 커넥션에서
실행되고 예외 시 롤백된다. 재고 차감·결제처럼 원자성이 필요한 로직은 이것을 써야 한다.

함께 배운 것: 동시성이 있는 감소 연산은 조회 후 차감이 아니라
`UPDATE ... WHERE stock >= qty RETURNING` 형태의 조건부 원자적 UPDATE로 해야 한다.
주문번호도 `count(*)+1` 로 만들면 동시 주문에서 충돌하므로 시퀀스를 쓴다.

## ADR-14. 결제는 게이트웨이 추상화로 분리하고, 금액은 PG 응답과 대조한다

특정 PG에 커플링되면 국가·사업자마다 코어를 고쳐야 한다. 그래서 `PaymentGateway`
인터페이스만 brick-shop이 알고, PG별 구현은 별도 플러그인이 `shop.payment.register`
훅으로 등록한다(brick-pay-toss가 레퍼런스).

핵심 방어는 **금액 검증 위치**다. 게이트웨이는 "PG가 실제로 승인한 금액"을 반환할
책임만 지고, 주문 총액과의 대조는 brick-shop이 한다. 게이트웨이를 신뢰하지 않는 구조이므로
서드파티 PG 플러그인이 부실해도 금액 위조가 통과하지 않는다.
불일치 시 즉시 PG 취소를 시도하고 실패로 기록한다 — 조용히 넘기면 대조가 무의미해진다.

중복 승인은 코드가 아니라 **DB가** 막는다: `shop_payments (provider, provider_tid)` unique.
같은 웹훅이 재전송되어도 재고·매출이 이중 계상되지 않는다. 주문 자체의 중복은
`idempotency_key` unique로 막는다 — 결제 직전 네트워크 재시도가 재고를 이중 차감하는 것을
방지하는 실전 요구사항이다.

## ADR-15. 메일은 Provider로 두고, 미설정 시 콘솔로 폴백한다

비밀번호 재설정은 프로덕션 필수 기능이지만, SMTP를 요구하면 "설치가 쉬워야 한다"는
전제(ADR-1)가 깨진다. 그래서 `MailProvider`를 두고 SMTP 미설정 시 `LogMailProvider`가
콘솔에 출력한다 — 메일 서버 없이도 재설정 흐름을 개발·테스트할 수 있다.

대가: 프로덕션에서 SMTP를 잊으면 재설정 링크가 로그에 남아 로그 접근자가 계정을 탈취할
수 있다. 그래서 보안 문서와 배포 체크리스트에 명시했다. (부팅을 막지는 않는다 —
메일 없이도 CMS는 정상 동작해야 하기 때문)

메일 발송 실패는 예외를 던지지 않고 `false`를 반환한다. 메일 서버 장애가 회원가입이나
주문을 막아서는 안 된다.

## ADR-16. 감사 로그는 기록 실패가 주 동작을 막지 않는다

권한 변경·계정 정지·확장 설치는 사고 시 추적이 반드시 필요하므로 기록한다.
단, 감사 로그 INSERT가 실패해도 페이지 저장이나 권한 변경은 성공해야 한다 —
로그를 남기지 못했다는 이유로 실제 작업을 되돌리면 가용성이 낮아진다.
그래서 `AuditService.record()` 는 예외를 삼키고 경고만 남긴다.

본문 같은 큰 데이터와 비밀번호·토큰은 담지 않는다. "무엇에 대한 어떤 동작"과 짧은 요약만
남기며, 180일이 지나면 정리 작업이 지운다.
