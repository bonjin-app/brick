import {
  BadRequestException, Body, Controller, Get, Inject, Param, Post, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { BrickDb } from "@brick/database";
import { AdminGuard, AuthGuard } from "../auth/auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { AuditService } from "../audit/audit.service.js";
import { DB } from "../../runtime.module.js";
import { AgreementsService, KIND_LABEL, type AgreementKind } from "./agreements.service.js";
import { EmailVerifyService } from "./email-verify.service.js";
import { WithdrawalService } from "./withdrawal.service.js";

type AuthedRequest = FastifyRequest & { user: { id: string; role: string } };

/**
 * 회원 생애주기 API — 약관 · 이메일 인증 · 탈퇴.
 *
 * 회원가입 자체는 UsersController 에 있다. 여기는 가입 **전후**를 다룬다:
 * 가입 화면이 보여줄 약관, 가입 후 인증, 그리고 떠날 때.
 */
@Controller("api")
export class MembersController {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly agreements: AgreementsService,
    private readonly emailVerify: EmailVerifyService,
    private readonly withdrawal: WithdrawalService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  // ══════════════════════════════════════════════════
  //  약관 (공개)
  // ══════════════════════════════════════════════════

  /**
   * 가입 화면이 보여줄 약관.
   * 로그인 없이 접근한다 — 가입 전에 읽어야 하는 문서다.
   */
  @Get("agreements")
  async list() {
    const items = await this.agreements.listActive();
    return {
      items: items.map((a) => ({
        kind: a.kind,
        label: KIND_LABEL[a.kind] ?? a.kind,
        version: a.version,
        title: a.title,
        body: a.body,
        required: a.isRequired,
      })),
    };
  }

  /** 개정된 약관에 다시 동의해야 하는지 (로그인 후 확인) */
  @Get("agreements/pending")
  @UseGuards(AuthGuard)
  async pending(@Req() req: AuthedRequest) {
    const items = await this.agreements.pendingFor(req.user.id);
    return {
      items: items.map((a) => ({
        kind: a.kind, version: a.version, title: a.title, body: a.body,
      })),
    };
  }

  @Post("agreements/accept")
  @UseGuards(AuthGuard)
  async accept(
    @Req() req: AuthedRequest,
    @Body() body: { accepted?: Record<string, boolean> },
  ) {
    await this.agreements.acceptPending({
      userId: req.user.id,
      accepted: body?.accepted ?? {},
      ip: req.ip,
    });
    return { ok: true };
  }

  /** 내 동의 이력 */
  @Get("me/agreements")
  @UseGuards(AuthGuard)
  async myAgreements(@Req() req: AuthedRequest) {
    return { items: await this.agreements.historyFor(req.user.id) };
  }

  // ══════════════════════════════════════════════════
  //  이메일 인증
  // ══════════════════════════════════════════════════

  @Post("me/email/verify/send")
  @UseGuards(AuthGuard)
  async sendVerification(
    @Req() req: AuthedRequest,
    @Body() body: { email?: string },
  ) {
    // 주소를 바꾸면서 인증하는 경우 — 새 주소를 검증한다
    if (body?.email) {
      const email = String(body.email).toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BadRequestException("이메일 주소 형식이 올바르지 않습니다.");
      }
      // 선점 여부를 미리 본다. 인증 메일을 보낸 뒤 실패하면 사용자가 이유를 모른다.
      const { rows } = await this.db.execute(sql`
        SELECT id FROM users WHERE email = ${email} AND id <> ${req.user.id}::uuid LIMIT 1
      `);
      if (rows.length) throw new BadRequestException("이미 사용 중인 이메일 주소입니다.");
    }
    return await this.emailVerify.send({ userId: req.user.id, email: body?.email ?? null });
  }

  /**
   * 인증 완료. 로그인하지 않은 브라우저에서 링크를 열 수 있으므로 인증 없이 받는다 —
   * 토큰 자체가 신원 증명이다.
   */
  @Post("email/verify")
  async confirmVerification(@Body() body: { token?: string }, @Req() req: FastifyRequest) {
    const result = await this.emailVerify.confirm(String(body?.token ?? ""));
    await this.audit.record({ action: "user.email_verified", ip: req.ip });
    return { ok: true, email: result.email };
  }

  // ══════════════════════════════════════════════════
  //  내 정보 (수신 동의 · 나이 확인)
  // ══════════════════════════════════════════════════

  @Get("me/profile")
  @UseGuards(AuthGuard)
  async myProfile(@Req() req: AuthedRequest) {
    const { rows } = await this.db.execute(sql`
      SELECT id, email, display_name, role, email_verified_at, marketing_opt_in,
             age_confirmed, last_login_at, created_at, birth_month, birth_day,
             password_login_enabled
      FROM users WHERE id = ${req.user.id}::uuid LIMIT 1
    `);
    const me = rows[0];
    if (!me) throw new BadRequestException("회원을 찾을 수 없습니다.");
    return {
      ...me,
      email_verified: Boolean(me.email_verified_at),
      pendingAgreements: (await this.agreements.pendingFor(req.user.id)).length,
    };
  }

  /** 광고 수신 동의 변경 — 언제든 철회할 수 있어야 한다 */
  @Put("me/marketing")
  @UseGuards(AuthGuard)
  async setMarketing(@Req() req: AuthedRequest, @Body() body: { optIn?: boolean }) {
    const optIn = body?.optIn === true;
    await this.db.execute(sql`
      UPDATE users SET marketing_opt_in = ${optIn}, updated_at = now()
      WHERE id = ${req.user.id}::uuid
    `);
    // 철회는 이력에 남겨야 한다 — "동의를 철회했는데 메일이 왔다"에 답하려면 필요하다
    await this.audit.record({
      action: optIn ? "user.marketing_opt_in" : "user.marketing_opt_out",
      targetType: "user", targetId: req.user.id, ip: req.ip,
    });
    return { ok: true, optIn };
  }

  // ══════════════════════════════════════════════════
  //  탈퇴
  // ══════════════════════════════════════════════════

  /** 탈퇴하면 무엇이 사라지는지 미리 보여준다 */
  @Get("me/withdraw/preview")
  @UseGuards(AuthGuard)
  async withdrawPreview(@Req() req: AuthedRequest) {
    return await this.withdrawal.preview(req.user.id);
  }

  /**
   * 탈퇴 실행.
   *
   * 비밀번호를 다시 확인한다 — 세션이 탈취된 상태에서 계정을 지워버리는 것을 막는다.
   * 소셜 전용 계정은 비밀번호가 없으므로 확인 문구를 받는다.
   */
  @Post("me/withdraw")
  @UseGuards(AuthGuard)
  async withdraw(
    @Req() req: AuthedRequest,
    @Body() body: { password?: string; confirm?: string; reason?: string; deletePosts?: boolean },
  ) {
    const { rows } = await this.db.execute(sql`
      SELECT password_login_enabled FROM users WHERE id = ${req.user.id}::uuid LIMIT 1
    `);
    const canUsePassword = rows[0]?.password_login_enabled === true;

    if (canUsePassword) {
      const ok = await this.auth.verifyPassword(req.user.id, String(body?.password ?? ""));
      if (!ok) throw new BadRequestException("비밀번호가 올바르지 않습니다.");
    } else if (String(body?.confirm ?? "").trim() !== "탈퇴합니다") {
      // 소셜 전용 계정 — 확인 문구를 정확히 입력해야 한다
      throw new BadRequestException('탈퇴를 확인하려면 "탈퇴합니다"를 입력해주세요.');
    }

    const result = await this.withdrawal.withdraw({
      userId: req.user.id,
      reason: body?.reason ?? null,
      deletePosts: body?.deletePosts === true,
      ip: req.ip,
    });

    // 감사 로그에는 익명화된 식별자만 남긴다 — 원래 이메일을 남기면
    // 파기했다는 말이 거짓이 된다
    await this.audit.record({
      action: "user.withdraw", targetType: "user", targetId: req.user.id,
      summary: result.anonymizedEmail, ip: req.ip,
    });

    return { ok: true, effects: result.effects };
  }

  // ══════════════════════════════════════════════════
  //  관리자: 약관 관리
  // ══════════════════════════════════════════════════

  @Get("admin/agreements")
  @UseGuards(AdminGuard)
  async adminList() {
    return { items: await this.agreements.listAll() };
  }

  @Get("admin/agreements/:id")
  @UseGuards(AdminGuard)
  async adminGet(@Param("id") id: string) {
    const row = await this.agreements.getOne(id);
    if (!row) throw new BadRequestException("약관을 찾을 수 없습니다.");
    return row;
  }

  /** 개정 발행 — 기존 버전을 고치지 않고 새 버전을 만든다 */
  @Post("admin/agreements")
  @UseGuards(AdminGuard)
  async adminPublish(
    @Req() req: AuthedRequest,
    @Body() body: { kind: string; title: string; body: string; isRequired?: boolean; effectiveAt?: string },
  ) {
    const result = await this.agreements.publishRevision({
      kind: body.kind,
      title: body.title,
      body: body.body,
      isRequired: body.isRequired !== false,
      effectiveAt: body.effectiveAt ?? null,
    });
    await this.audit.record({
      action: "agreement.publish", targetType: "agreement", targetId: result.id,
      summary: `${body.kind} v${result.version}`, ip: req.ip,
    });
    return result;
  }

  // ══════════════════════════════════════════════════
  //  관리자: 탈퇴 · 휴면
  // ══════════════════════════════════════════════════

  /** 관리자가 회원을 탈퇴 처리 (요청 대행 · 규정 위반 제재) */
  @Post("admin/users/:id/withdraw")
  @UseGuards(AdminGuard)
  async adminWithdraw(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: { reason?: string; deletePosts?: boolean },
  ) {
    const result = await this.withdrawal.withdraw({
      userId: id,
      reason: body?.reason ?? "관리자 처리",
      deletePosts: body?.deletePosts === true,
      ip: req.ip,
    });
    await this.audit.record({
      action: "user.withdraw_by_admin", targetType: "user", targetId: id,
      summary: result.anonymizedEmail, ip: req.ip,
    });
    return { ok: true, effects: result.effects };
  }

  /**
   * 휴면 대상 조회.
   *
   * 즉시 전환하지 않고 목록만 준다 — 개인정보보호법은 파기 전 **사전 통지**를
   * 요구한다. 통지 없이 자동 전환하면 그 자체가 위반이다.
   */
  @Get("admin/users/dormant-candidates")
  @UseGuards(AdminGuard)
  async dormantCandidates(@Query("months") months?: string) {
    const m = Math.min(60, Math.max(1, Number(months ?? 12)));
    const { rows } = await this.db.execute(sql`
      SELECT id, email, display_name, last_login_at, created_at
      FROM users
      WHERE withdrawn_at IS NULL AND dormant_at IS NULL AND role = 'member'
        AND coalesce(last_login_at, created_at) < now() - ${sql.raw(`interval '${m} months'`)}
      ORDER BY coalesce(last_login_at, created_at)
      LIMIT 200
    `);
    return { months: m, items: rows, total: rows.length };
  }

  @Post("admin/users/:id/dormant")
  @UseGuards(AdminGuard)
  async markDormant(@Req() req: AuthedRequest, @Param("id") id: string) {
    const { rows } = await this.db.execute(sql`
      UPDATE users SET dormant_at = now(), updated_at = now()
      WHERE id = ${id}::uuid AND withdrawn_at IS NULL
      RETURNING id
    `);
    if (!rows.length) throw new BadRequestException("회원을 찾을 수 없습니다.");
    // 휴면 계정은 로그인할 수 없어야 하므로 세션을 끊는다
    await this.auth.revokeAllSessions(id);
    await this.audit.record({
      action: "user.dormant", targetType: "user", targetId: id, ip: req.ip,
    });
    return { ok: true };
  }
}
