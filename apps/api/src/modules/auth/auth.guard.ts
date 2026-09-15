import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { AuthService } from "./auth.service.js";
import { ipAllowed } from "./ip-allowlist.js";
import { DB } from "../../runtime.module.js";
import type { BrickDb } from "@brick/database";

/** 로그인 필수 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(protected readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: unknown }>();
    const user = await this.auth.resolveFromRequest(req);
    /*
     * 메시지를 비워 두면 Nest 가 "Unauthorized" 를 넣는다. 화면은 서버가 준
     * message 를 그대로 보여주므로, 관리자가 상품 설명을 한참 쓰고 저장을
     * 눌렀을 때 "저장 실패: Unauthorized" 가 떴다 — 무슨 일인지도, 무엇을
     * 해야 하는지도 알 수 없다(내용은 폼에 남아 있는데 그것조차 모른다).
     * 이 파일의 다른 예외는 전부 한국어였다.
     */
    if (!user) throw new UnauthorizedException("로그인이 풀렸습니다. 다시 로그인한 뒤 시도해주세요.");
    req.user = user;
    return true;
  }
}

/**
 * 관리자 전용.
 *
 * 2단계 인증 강제(`security.require_2fa_for_staff`)가 켜져 있으면, 2FA 를
 * 켜지 않은 관리자의 **관리 작업을 막는다.**
 *
 * 로그인 자체를 막지 않는 이유: 설정을 켠 순간 아무도 못 들어오게 되면
 * 등록할 방법이 없어 사이트가 잠긴다. 등록 경로(`/api/me/security/*`)는
 * AuthGuard 만 쓰므로 열려 있고, 관리 화면만 닫힌다.
 */
@Injectable()
export class AdminGuard extends AuthGuard {
  constructor(
    auth: AuthService,
    @Inject(DB) protected readonly db: BrickDb,
  ) {
    super(auth);
  }

  /**
   * 이 가드가 통과시키는 역할.
   *
   * `ManagerGuard` 가 낮춘다 — 2단계 인증 강제와 IP 제한은 **그대로 적용된다**.
   * 운영자도 관리 화면을 쓰는 사람이고, 강제 설정의 이름도 "관리자·운영자" 다.
   */
  protected allows(role: string | undefined): boolean {
    return role === "admin";
  }
  protected denyMessage(): string {
    return "관리자만 할 수 있는 작업입니다.";
  }

  override async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await super.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: { id: string; role: string } }>();
    const staff = req.user;
    // AuthGuard 가 이미 세션을 확인했다 — 여기서는 타입만 좁힌다
    if (!staff || !this.allows(staff.role)) throw new ForbiddenException(this.denyMessage());

    const { rows } = await this.db.execute(sql`
      SELECT
        (SELECT value FROM site_settings WHERE key = 'security.require_2fa_for_staff') AS required,
        (SELECT value FROM site_settings WHERE key = 'security.admin_ip_allowlist') AS ip_allowlist,
        EXISTS (SELECT 1 FROM user_totp
                WHERE user_id = ${staff.id}::uuid AND is_enabled = true) AS has_totp
    `);
    const required = rows[0]?.required === true || rows[0]?.required === "true";
    if (required && rows[0]?.has_totp !== true) {
      throw new ForbiddenException(
        "이 사이트는 관리자·운영자에게 2단계 인증을 요구합니다. 계정 보안 설정에서 먼저 등록해주세요.",
      );
    }

    // 관리자 IP 제한 (선택 — 고정 IP 사업장용).
    // 비상 탈출: 서버 소유자는 BRICK_ADMIN_IP_LIMIT=off 로 끌 수 있다 —
    // 서버에 접속할 수 있는 사람은 어차피 DB 도 만질 수 있으므로 새 권한이
    // 아니고, 실수로 스스로 잠근 운영자를 재설치 없이 구한다.
    const allowlist = typeof rows[0]?.ip_allowlist === "string" ? rows[0].ip_allowlist : "";
    if (allowlist && process.env.BRICK_ADMIN_IP_LIMIT !== "off") {
      if (!ipAllowed(req.ip, allowlist)) {
        throw new ForbiddenException("이 IP 에서는 관리자 기능을 쓸 수 없습니다.");
      }
    }
    return true;
  }
}

/**
 * 관리자 **또는 운영자**.
 *
 * 플러그인 관리 라우트는 디스패처가 manager 까지 통과시킨다(plugins.controller).
 * 그런데 그 화면들의 **목록**(admin/nav)만 admin 으로 닫혀 있어서, 운영자는
 * 자기가 쓸 수 있는 화면을 사이드바에서 찾을 수 없었다 — 권한은 있는데 길이
 * 없으면 역할이 없는 것과 같다.
 */
@Injectable()
export class ManagerGuard extends AdminGuard {
  constructor(auth: AuthService, @Inject(DB) db: BrickDb) {
    super(auth, db);
  }
  protected override allows(role: string | undefined): boolean {
    return role === "admin" || role === "manager";
  }
  protected override denyMessage(): string {
    return "관리자·운영자만 할 수 있는 작업입니다.";
  }
}
