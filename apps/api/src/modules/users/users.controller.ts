import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException,
  HttpStatus, Inject, Param, Post, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import { count, desc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import argon2 from "argon2";
import type { FastifyRequest } from "fastify";
import type { BrickDb } from "@brick/database";
import { siteSettings, users } from "@brick/database";
import type { HookBus } from "@brick/core";
import { AdminGuard, AuthGuard } from "../auth/auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { AuditService } from "../audit/audit.service.js";
import { DB, HOOKS } from "../../runtime.module.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ["admin", "manager", "member"] as const;

@Controller("api")
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(HOOKS) private readonly hooks: HookBus,
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /** 회원가입 — site.registration_open 설정으로 열고 닫을 수 있다 */
  @Post("register")
  async register(
    @Body() body: { email: string; password: string; displayName: string },
    @Req() req: FastifyRequest,
  ) {
    const open = await this.setting<boolean>("site.registration_open");
    if (open === false) throw new ForbiddenException("회원가입이 닫혀 있습니다.");

    // 가입 스팸 방어
    const { allowed, retryAfterSeconds } = this.rateLimit.consume(`register:${req.ip}`, 5, 60 * 60_000);
    if (!allowed) {
      throw new HttpException(
        `가입 시도가 너무 많습니다. ${Math.ceil(retryAfterSeconds / 60)}분 후 다시 시도하세요.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const email = (body?.email ?? "").toLowerCase().trim();
    const displayName = (body?.displayName ?? "").trim();
    if (!EMAIL_RE.test(email)) throw new BadRequestException("올바른 이메일을 입력하세요.");
    if ((body?.password ?? "").length < 8) throw new BadRequestException("비밀번호는 8자 이상이어야 합니다.");
    if (displayName.length < 2 || displayName.length > 30) {
      throw new BadRequestException("이름은 2~30자로 입력하세요.");
    }

    const id = uuidv7();
    try {
      await this.db.insert(users).values({
        id,
        email,
        passwordHash: await argon2.hash(body.password),
        displayName,
        role: "member",
      });
    } catch (err) {
      if (String(err).includes("users_email_unique") || String(err).includes("duplicate key")) {
        throw new ConflictException("이미 등록된 이메일입니다.");
      }
      throw err;
    }
    await this.hooks.doAction("user.registered", { userId: id, email });
    await this.audit.record({ action: "user.register", targetType: "user", targetId: id, summary: email, ip: req.ip });
    return { id };
  }

  /** 내 프로필 수정 (이름/비밀번호) */
  @Put("me")
  @UseGuards(AuthGuard)
  async updateMe(
    @Req() req: FastifyRequest & { user: { id: string } },
    @Body() body: { displayName?: string; currentPassword?: string; newPassword?: string },
  ) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (body.displayName !== undefined) {
      const name = body.displayName.trim();
      if (name.length < 2 || name.length > 30) throw new BadRequestException("이름은 2~30자로 입력하세요.");
      patch.displayName = name;
    }

    if (body.newPassword) {
      // 비밀번호 변경에는 현재 비밀번호를 반드시 확인한다 (세션 탈취 시 계정 탈취로 번지지 않도록)
      const [row] = await this.db.select().from(users).where(eq(users.id, req.user.id)).limit(1);
      if (!row || !(await argon2.verify(row.passwordHash, body.currentPassword ?? ""))) {
        throw new BadRequestException("현재 비밀번호가 올바르지 않습니다.");
      }
      if (body.newPassword.length < 8) throw new BadRequestException("새 비밀번호는 8자 이상이어야 합니다.");
      patch.passwordHash = await argon2.hash(body.newPassword);
    }

    await this.db.update(users).set(patch).where(eq(users.id, req.user.id));
    // 비밀번호를 바꾸면 다른 모든 세션을 무효화한다
    if (patch.passwordHash) await this.auth.revokeAllSessions(req.user.id);
    return { ok: true };
  }

  // ── 관리자: 회원 관리 ──────────────────────────────
  @Get("users")
  @UseGuards(AdminGuard)
  async list(@Query("page") pageParam?: string) {
    const page = Math.max(1, Number(pageParam ?? 1));
    const size = 30;
    const [items, [total]] = await Promise.all([
      this.db
        .select({
          id: users.id, email: users.email, displayName: users.displayName,
          role: users.role, isActive: users.isActive, createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(size)
        .offset((page - 1) * size),
      this.db.select({ value: count() }).from(users),
    ]);
    return { items, total: Number(total?.value ?? 0), page, pageSize: size };
  }

  @Put("users/:id")
  @UseGuards(AdminGuard)
  async updateUser(
    @Param("id") id: string,
    @Body() body: { role?: string; isActive?: boolean },
    @Req() req: FastifyRequest & { user: { id: string } },
  ) {
    // 자기 자신의 권한을 내리거나 계정을 잠그는 것을 막는다 (관리자 전멸 방지)
    if (id === req.user.id && (body.role !== undefined || body.isActive === false)) {
      throw new BadRequestException("자신의 권한이나 활성 상태는 변경할 수 없습니다.");
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role as (typeof ROLES)[number])) throw new BadRequestException("알 수 없는 권한입니다.");
      patch.role = body.role;
    }
    if (body.isActive !== undefined) patch.isActive = body.isActive;

    const [before] = await this.db
      .select({ email: users.email, role: users.role, isActive: users.isActive })
      .from(users).where(eq(users.id, id)).limit(1);

    await this.db.update(users).set(patch).where(eq(users.id, id));
    // 비활성화하면 즉시 로그아웃시킨다
    if (body.isActive === false) await this.auth.revokeAllSessions(id);

    // 권한 변경과 계정 정지는 추적이 반드시 필요한 동작이다
    const changes: string[] = [];
    if (body.role !== undefined && before) changes.push(`권한 ${before.role} → ${body.role}`);
    if (body.isActive !== undefined && before) changes.push(body.isActive ? "계정 활성화" : "계정 정지");
    await this.audit.fromRequest(req as never, {
      action: body.role !== undefined ? "user.role_change" : "user.status_change",
      targetType: "user",
      targetId: id,
      summary: `${before?.email ?? id}: ${changes.join(", ")}`,
    });
    return { ok: true };
  }

  private async setting<T>(key: string): Promise<T | null> {
    const [row] = await this.db.select().from(siteSettings).where(eq(siteSettings.key, key)).limit(1);
    return (row?.value as T) ?? null;
  }
}
