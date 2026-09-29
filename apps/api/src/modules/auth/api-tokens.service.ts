import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, gt, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { apiTokens, users } from "@brick/database";
import type { SessionUser } from "@brick/shared";
import { DB } from "../../runtime.module.js";

/** 토큰 앞머리 — 사람이 읽어도 로그·설정 파일에서 "이건 Brick 토큰" 임을 알아보게 (비밀 스캐너도 잡는다) */
export const API_TOKEN_PREFIX = "brk_";

/**
 * 토큰으로 열리는 경로 — **읽기(GET)만, 진단에 필요한 것만.**
 *
 * 허용목록이다(막을 것을 적는 방식이 아니다). 새 관리 경로가 생겨도 여기에 적지 않으면 토큰으로는 닿지 않는다.
 * 회원 목록·주문·문의·감사 로그(행위자 이메일과 IP 가 있다)처럼 개인정보가 담긴 경로는 일부러 없다 — 도구가 사이트 상태를 보는 데 그것은 필요 없고,
 * 도구의 설정이 새어도 개인정보가 새지 않는다.
 */
export const API_TOKEN_PATHS: readonly string[] = [
  "/healthz",
  "/readyz",
  "/api/admin/version",
  "/api/admin/dashboard",
  "/api/admin/areas",
  "/api/admin/updates",
  "/api/plugins",
  "/api/themes",
  "/api/openapi.json",
  "/api/render/page",
];

/** 마지막 사용 시각을 이만큼 이상 지났을 때만 갱신한다 (읽기 요청마다 쓰기가 나가지 않게) */
const TOUCH_EVERY_MS = 60_000;

export interface ApiTokenRow {
  id: string;
  name: string;
  hint: string;
  createdBy: string;
  createdByEmail: string | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  /** 지금 쓸 수 있는가 (폐기·만료 아님) */
  active: boolean;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 요청 주소에서 경로만 — 쿼리·끝 슬래시는 뗀다 */
export function pathOf(url: string): string {
  const path = url.split("?")[0] ?? "";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

@Injectable()
export class ApiTokensService {
  constructor(@Inject(DB) private readonly db: BrickDb) {}

  /** 만든다. 원문은 이 반환값에만 있다 — 다시 볼 수 없다 */
  async create(input: { name: string; createdBy: string; expiresInDays: number }): Promise<{ id: string; token: string; expiresAt: Date }> {
    const token = API_TOKEN_PREFIX + randomBytes(24).toString("base64url");
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
    await this.db.insert(apiTokens).values({
      id,
      name: input.name,
      tokenHash: hashToken(token),
      hint: token.slice(-4),
      createdBy: input.createdBy,
      expiresAt,
    });
    return { id, token, expiresAt };
  }

  async list(): Promise<ApiTokenRow[]> {
    const rows = await this.db
      .select({ t: apiTokens, email: users.email })
      .from(apiTokens)
      .leftJoin(users, eq(users.id, apiTokens.createdBy))
      .orderBy(desc(apiTokens.createdAt));
    const now = Date.now();
    return rows.map(({ t, email }) => ({
      id: t.id, name: t.name, hint: t.hint, createdBy: t.createdBy, createdByEmail: email,
      expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt, revokedAt: t.revokedAt, createdAt: t.createdAt,
      active: !t.revokedAt && t.expiresAt.getTime() > now,
    }));
  }

  /** 폐기한다. 이미 폐기된 것은 그대로 두고 false */
  async revoke(id: string): Promise<boolean> {
    const rows = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    return rows.length > 0;
  }

  /**
   * 요청에 실린 토큰을 사용자로 바꾼다. 아니면 null.
   *
   * 세션과 달리 **여기서 요청까지 본다** — 토큰은 "누구인가" 만이 아니라 "무엇을 할 수 있는가" 가 좁아서, 이 한 곳에서
   * 강제하면 모든 가드(AuthGuard·AdminGuard·ManagerGuard)가 자동으로 같은 제한을 받는다. 가드마다 따로 막으면
   * 새 가드가 생길 때 빠진다.
   */
  async resolve(token: string, req: { method: string; url: string }): Promise<SessionUser | null> {
    if (!token.startsWith(API_TOKEN_PREFIX)) return null;
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    if (!API_TOKEN_PATHS.includes(pathOf(req.url))) return null;

    const [row] = await this.db
      .select({ t: apiTokens, u: users })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.createdBy))
      .where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, new Date())))
      .limit(1);
    // 만든 사람이 더는 관리자가 아니거나 비활성이면 토큰도 죽는다 — 권한을 내려놓았는데 도구가 계속 읽으면 안 된다
    if (!row || !row.u.isActive || row.u.role !== "admin") return null;

    const last = row.t.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - last > TOUCH_EVERY_MS) {
      void this.db.update(apiTokens).set({ lastUsedAt: sql`now()` }).where(eq(apiTokens.id, row.t.id)).catch(() => undefined);
    }
    return {
      id: row.u.id, email: row.u.email, displayName: row.u.displayName, role: "admin",
      avatarUrl: row.u.avatarUrl ?? null, scopes: null,
    };
  }
}
