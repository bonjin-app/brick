import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpException,
  HttpStatus, Inject, Param, Post, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import { count, desc, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import argon2 from "argon2";
import type { FastifyRequest } from "fastify";
import type { BrickDb } from "@brick/database";
import { siteSettings, users } from "@brick/database";
import type { HookBus } from "@brick/core";
import { AdminGuard, AuthGuard } from "../auth/auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { ReauthService } from "../auth/reauth.service.js";
import type { CaptchaProvider } from "@brick/core";
import { AuditService } from "../audit/audit.service.js";
import { CAPTCHA, DB, HOOKS } from "../../runtime.module.js";
import { isUniqueViolation } from "@brick/core";
import { AgreementsService } from "../members/agreements.service.js";
import { EmailVerifyService } from "../members/email-verify.service.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ["admin", "manager", "member"] as const;

@Controller("api")
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(HOOKS) private readonly hooks: HookBus,
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
    private readonly reauth: ReauthService,
    private readonly audit: AuditService,
    @Inject(CAPTCHA) private readonly captcha: CaptchaProvider,
    private readonly agreements: AgreementsService,
    private readonly emailVerify: EmailVerifyService,
  ) {}

  /** 회원가입 — site.registration_open 설정으로 열고 닫을 수 있다 */
  @Post("register")
  async register(
    @Body() body: {
      email: string; password: string; displayName: string;
      captchaToken?: string; captchaAnswer?: string;
      /** 약관 동의 (kind → 동의 여부). 필수 항목을 빠뜨리면 가입이 거부된다 */
      agreements?: Record<string, boolean>;
      /** 만 14세 이상 확인 */
      ageConfirmed?: boolean;
    },
    @Req() req: FastifyRequest,
  ) {
    const open = await this.setting<boolean>("site.registration_open");
    if (open === false) throw new ForbiddenException("회원가입이 닫혀 있습니다.");

    // 캡차를 먼저 검사한다 — 비밀번호 해싱(argon2)은 비싸므로,
    // 봇이 그 비용을 유발하기 전에 걸러내야 한다.
    if (this.captcha.enabled) {
      const passed = await this.captcha.verify(body?.captchaToken ?? "", body?.captchaAnswer ?? "");
      if (!passed) {
        throw new BadRequestException("자동입력 방지 문자가 올바르지 않습니다. 다시 시도해주세요.");
      }
    }

    const email = (body?.email ?? "").toLowerCase().trim();

    // 가입 스팸 방어 — 두 축으로 나눈다.
    //
    // IP 하나에 5회/시간은 너무 좁다. 사무실·학교·카페처럼 NAT 뒤에서
    // 여러 사람이 가입하면 여섯 번째 사람이 막힌다 — 로그인에서 이미 같은
    // 문제를 겪고 고친 적이 있다(이메일별·IP별로 분리).
    //
    // 그래서: 같은 이메일 3회/시간(재시도 루프 차단),
    //         같은 IP 20회/시간(대량 생성 차단).
    // 봇 차단의 본체는 캡차이고, 레이트리밋은 그 보조다.
    for (const [key, limit, label] of [
      [`register-email:${email}`, 3, "이 이메일로"],
      [`register-ip:${req.ip}`, 20, "이 네트워크에서"],
    ] as const) {
      const { allowed, retryAfterSeconds } = this.rateLimit.consume(key, limit, 60 * 60_000);
      if (!allowed) {
        throw new HttpException(
          `${label} 가입 시도가 너무 많습니다. ${Math.ceil(retryAfterSeconds / 60)}분 후 다시 시도하세요.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const displayName = (body?.displayName ?? "").trim();
    if (!EMAIL_RE.test(email)) throw new BadRequestException("올바른 이메일을 입력하세요.");
    if ((body?.password ?? "").length < 8) throw new BadRequestException("비밀번호는 8자 이상이어야 합니다.");
    if (displayName.length < 2 || displayName.length > 30) {
      throw new BadRequestException("이름은 2~30자로 입력하세요.");
    }

    // 만 14세 미만은 법정대리인 동의 절차 없이 가입시킬 수 없다.
    // 생년월일 전체를 받지 않는다 — 확인에 필요한 최소는 "14세 이상인가" 뿐이다.
    if (body?.ageConfirmed === false) {
      throw new BadRequestException(
        "만 14세 미만은 법정대리인 동의가 필요합니다. 사이트 운영자에게 문의해주세요.",
      );
    }

    const id = uuidv7();
    const passwordHash = await argon2.hash(body.password);

    // 계정 생성과 동의 기록은 한 트랜잭션이다.
    // 나뉘면 "동의 없이 만들어진 계정"이 남을 수 있고, 그건 위법 상태다.
    let marketingOptIn = false;
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(users).values({
          id,
          email,
          passwordHash,
          displayName,
          role: "member",
        });
        const consent = await this.agreements.recordForUser(tx as unknown as BrickDb, {
          userId: id,
          accepted: body?.agreements ?? {},
          ip: req.ip,
        });
        marketingOptIn = consent.marketingOptIn;
        if (marketingOptIn) {
          await tx.execute(sql`
            UPDATE users SET marketing_opt_in = true WHERE id = ${id}::uuid
          `);
        }
      });
    } catch (err) {
      if (isUniqueViolation(err, "users_email")) {
        throw new ConflictException("이미 등록된 이메일입니다.");
      }
      throw err;
    }

    // 인증 메일은 가입을 막지 않는다 — SMTP 가 없는 사이트에서 가입이 실패하면
    // 설치 직후 아무도 들어올 수 없다. 실패해도 계정은 남고, 나중에 재발송한다.
    try {
      await this.emailVerify.send({ userId: id });
    } catch {
      // 메일 실패는 조용히 넘긴다 (재발송 경로가 있다)
    }

    await this.hooks.doAction("user.registered", { userId: id, email });
    await this.audit.record({ action: "user.register", targetType: "user", targetId: id, summary: email, ip: req.ip });
    return { id };
  }

  /** 내 프로필 수정 (이름/비밀번호/생일) */
  @Put("me")
  @UseGuards(AuthGuard)
  async updateMe(
    @Req() req: FastifyRequest & { user: { id: string } },
    @Body() body: {
      displayName?: string; currentPassword?: string; newPassword?: string;
      /** 생일 (선택 · 월/일만). 둘 다 null 이면 삭제 — 언제든 지울 수 있어야 한다 */
      birthMonth?: number | null; birthDay?: number | null;
    },
  ) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    // 생일 — 월·일이 함께 오거나 함께 null 이어야 한다 (반쪽 생일은 의미가 없다)
    if (body.birthMonth !== undefined || body.birthDay !== undefined) {
      const m = body.birthMonth ?? null;
      const d = body.birthDay ?? null;
      if (m === null && d === null) {
        patch.birthMonth = null;
        patch.birthDay = null;
      } else {
        const month = Math.floor(Number(m));
        const day = Math.floor(Number(d));
        const daysIn = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (!Number.isFinite(month) || month < 1 || month > 12
          || !Number.isFinite(day) || day < 1 || day > daysIn[month - 1]) {
          throw new BadRequestException("생일 날짜가 올바르지 않습니다.");
        }
        patch.birthMonth = month;
        patch.birthDay = day;
      }
    }

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
  async list(@Req() req: FastifyRequest, @Query("page") pageParam?: string) {
    // 회원 개인정보(이메일) 열람 — 훔친 세션만으로는 못 본다.
    // 최근 10분 내 비밀번호 재확인(POST /api/me/security/reauth)이 필요하다.
    this.reauth.assertRequest(req as never);
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
