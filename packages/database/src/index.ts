import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
export * as schema from "./schema/index.js";
export * from "./schema/index.js";

export type BrickDb = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  /*
   * **유휴 커넥션의 오류를 받아야 한다.**
   *
   * pg-pool 은 쉬고 있는 커넥션에서 오류가 나면 `pool.emit("error")` 를 부른다. 듣는 이가
   * 없으면 EventEmitter 가 그것을 던지고, 아무도 잡지 않으므로 **Node 가 프로세스를 죽인다** —
   * 즉 PostgreSQL 재시작이나 커넥션 순단 한 번에 사이트가 내려갔다(실제로 그랬다).
   * Docker 라면 재시작되지만 FTP 배포본은 그냥 죽어 있는다.
   *
   * 풀은 죽은 커넥션을 버리고 다음 요청에서 새로 맺으므로, 여기서는 로그만 남기면 된다.
   * 로그는 stderr 로 낸다 — 이 패키지는 NestJS 를 모른다(CLI 도구들이 같이 쓴다).
   */
  pool.on("error", (err) => {
    console.error(`[brick:db] 유휴 커넥션 오류 — 풀이 새 커넥션을 맺습니다: ${err.message}`);
  });
  return drizzle(pool);
}
