/**
 * 데이터베이스 오류 판별.
 *
 * 왜 이 파일이 있는가:
 *   중복 등록을 잡을 때 `String(err).includes("duplicate key")` 로 검사하고 있었다.
 *   drizzle 0.45 부터 드라이버 오류를 `Error("Failed query: ...")` 로 감싸고
 *   원본을 `cause` 에 넣기 때문에, 그 문자열 검사는 조용히 실패한다.
 *   결과는 "이미 사용 중인 주소입니다"(409) 대신 500 — 사용자는 무엇이
 *   잘못됐는지 알 수 없고, 서버 오류로 보인다.
 *
 *   그래서 문자열이 아니라 **PostgreSQL 오류 코드**로 판별한다. 코드는 표준이고
 *   드라이버 버전에 따라 바뀌지 않는다. 감싸인 오류를 cause 사슬을 따라 찾는다.
 *
 * 참고: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

/** 자주 쓰는 PostgreSQL 오류 코드 */
export const PG_ERROR = {
  /** 유니크 제약 위반 — 이미 있는 값 */
  UNIQUE_VIOLATION: "23505",
  /** 외래키 위반 — 없는 대상을 가리킴 */
  FOREIGN_KEY_VIOLATION: "23503",
  /** NOT NULL 위반 */
  NOT_NULL_VIOLATION: "23502",
  /** CHECK 제약 위반 */
  CHECK_VIOLATION: "23514",
  /** 교착 상태 — 재시도할 수 있다 */
  DEADLOCK_DETECTED: "40P01",
  /** 직렬화 실패 — 재시도할 수 있다 */
  SERIALIZATION_FAILURE: "40001",
  /** 락 획득 시간 초과 */
  LOCK_NOT_AVAILABLE: "55P03",
} as const;

interface PgErrorShape {
  code?: unknown;
  constraint?: unknown;
  table?: unknown;
  detail?: unknown;
}

/**
 * 감싸인 오류에서 PostgreSQL 오류 정보를 찾는다.
 *
 * cause 사슬을 따라간다 — drizzle 이 한 번, 상위 계층이 또 감쌀 수 있다.
 * 순환 참조로 무한 루프에 빠지지 않도록 깊이를 제한한다.
 */
export function findPgError(err: unknown): PgErrorShape | null {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8 && cursor; depth += 1) {
    if (typeof cursor === "object") {
      const candidate = cursor as PgErrorShape & { cause?: unknown };
      // 코드가 다섯 글자 문자열이면 PostgreSQL 오류로 본다 (SQLSTATE)
      if (typeof candidate.code === "string" && candidate.code.length === 5) {
        return candidate;
      }
      cursor = candidate.cause;
    } else {
      return null;
    }
  }
  return null;
}

/** SQLSTATE 코드를 꺼낸다 (없으면 null) */
export function pgErrorCode(err: unknown): string | null {
  const found = findPgError(err);
  return found && typeof found.code === "string" ? found.code : null;
}

/**
 * 유니크 제약 위반인가.
 *
 * @param constraint 특정 제약만 인정하려면 이름(또는 이름의 일부)을 넘긴다.
 *   테이블에 유니크 제약이 여럿일 때 "slug 중복"과 "코드 중복"을 구분해야 한다.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const found = findPgError(err);
  if (!found || found.code !== PG_ERROR.UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return String(found.constraint ?? "").includes(constraint);
}

/** 위반한 제약의 이름 (없으면 null) */
export function violatedConstraint(err: unknown): string | null {
  const found = findPgError(err);
  return found && typeof found.constraint === "string" ? found.constraint : null;
}

/** 외래키 위반인가 — 참조 대상이 없거나, 참조되는 중이라 지울 수 없다 */
export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const found = findPgError(err);
  if (!found || found.code !== PG_ERROR.FOREIGN_KEY_VIOLATION) return false;
  if (!constraint) return true;
  return String(found.constraint ?? "").includes(constraint);
}

/** CHECK 제약 위반인가 */
export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const found = findPgError(err);
  if (!found || found.code !== PG_ERROR.CHECK_VIOLATION) return false;
  if (!constraint) return true;
  return String(found.constraint ?? "").includes(constraint);
}

/**
 * 다시 시도하면 성공할 수 있는 오류인가.
 * 교착 상태와 직렬화 실패는 애플리케이션 잘못이 아니라 동시성의 결과다.
 */
export function isRetryable(err: unknown): boolean {
  const code = pgErrorCode(err);
  return (
    code === PG_ERROR.DEADLOCK_DETECTED ||
    code === PG_ERROR.SERIALIZATION_FAILURE ||
    code === PG_ERROR.LOCK_NOT_AVAILABLE
  );
}
