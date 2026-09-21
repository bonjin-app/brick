import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { escapeHtml, CORE_CATALOGS, makeTranslator } from "@brick/core";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import type { MailProvider } from "@brick/core";
import { DB, MAIL, ENV } from "../../runtime.module.js";
import { AuthService } from "../auth/auth.service.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import type { loadEnv } from "../../config/env.js";
import { msg } from "../../common/localized-error.js";

const TOKEN_TTL_HOURS = 24;
/** 재발송 최소 간격 — 메일 폭탄에 쓰이지 않게 */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * 이메일 인증.
 *
 * 비밀번호 재설정과 같은 원칙을 따른다:
 *  - 토큰 원문은 메일 링크에만, DB에는 sha256 해시만
 *  - used_at 으로 단회성
 *  - 새로 요청하면 이전 링크는 죽는다
 *
 * 다른 점: **열거 방지가 필요 없다.** 이 흐름은 이미 로그인한 사람이
 * 자기 주소를 인증하는 것이므로 "그 주소가 가입되어 있는가"를 숨길 대상이 없다.
 *
 * 인증되지 않은 회원을 어디까지 막을지는 사이트가 정한다
 * (site.require_email_verification). 기본값은 막지 않는다 —
 * 메일 설정(SMTP)이 안 된 사이트에서 아무도 로그인할 수 없게 되면
 * 설치 직후 사이트가 죽는다.
 */
@Injectable()
export class EmailVerifyService {
  private readonly log = new Logger("EmailVerify");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(MAIL) private readonly mail: MailProvider,
    @Inject(ENV) private readonly env: ReturnType<typeof loadEnv>,
    private readonly loader: PluginLoaderService,
    // 주소가 바뀌면 세션을 모두 끊는다 — 비밀번호 변경과 같은 처리
    private readonly auth: AuthService,
  ) {}

  /**
   * 인증 메일 발송.
   *
   * @param email 인증할 주소. 생략하면 현재 계정의 주소.
   *   주소 변경 흐름에서는 **새 주소**를 넣는다 — 새 주소를 인증하기 전에
   *   users.email 을 바꾸면 잘못 입력한 주소로 계정이 넘어간다.
   */
  async send(params: { userId: string; email?: string | null }): Promise<{ sent: boolean }> {
    const { rows } = await this.db.execute(sql`
      SELECT id, email, display_name, email_verified_at, withdrawn_at
      FROM users WHERE id = ${params.userId}::uuid LIMIT 1
    `);
    const user = rows[0];
    if (!user) throw new BadRequestException("회원을 찾을 수 없습니다.");
    if (user.withdrawn_at) throw new BadRequestException("탈퇴한 계정입니다.");

    const target = String(params.email ?? user.email).toLowerCase().trim();

    // 이미 인증된 주소를 다시 인증할 이유가 없다
    if (user.email_verified_at && target === String(user.email)) {
      throw new BadRequestException("이미 인증된 주소입니다.");
    }

    // 도배 방지 — 최근에 보냈으면 거절한다.
    // 남의 주소를 넣어 메일 폭탄을 보내는 데 쓰이는 것을 막는다.
    const { rows: recent } = await this.db.execute(sql`
      SELECT created_at FROM email_verifications
      WHERE user_id = ${params.userId}::uuid
        AND created_at > now() - ${sql.raw(`interval '${RESEND_COOLDOWN_SECONDS} seconds'`)}
      LIMIT 1
    `);
    if (recent.length) {
      throw new BadRequestException(
        msg("err.verifyMailCooldown", { seconds: RESEND_COOLDOWN_SECONDS }),
      );
    }

    // 이전 미사용 토큰 폐기
    await this.db.execute(sql`
      UPDATE email_verifications SET used_at = now()
      WHERE user_id = ${params.userId}::uuid AND used_at IS NULL
    `);

    const token = randomBytes(32).toString("base64url");
    await this.db.execute(sql`
      INSERT INTO email_verifications (id, user_id, email, token_hash, expires_at)
      VALUES (${uuidv7()}, ${params.userId}::uuid, ${target}, ${hashToken(token)},
              now() + ${sql.raw(`interval '${TOKEN_TTL_HOURS} hours'`)})
    `);

    const link = `${this.env.siteUrl.replace(/\/$/, "")}/verify-email?token=${token}`;
    // 재설정 메일과 같은 이유로 카탈로그를 탄다 — 메일은 사이트 밖에서 읽힌다
    const t = makeTranslator({ locale: this.loader.siteLocale, catalogs: CORE_CATALOGS });
    const name = String(user.display_name);
    await this.mail.send({
      to: target,
      subject: t("mail.verifySubject"),
      text:
        `${t("mail.greeting", { name })}\n\n` +
        `${t("mail.verifyBody")}\n${link}\n\n` +
        `${t("mail.verifyValid", { hours: TOKEN_TTL_HOURS })}\n` +
        `${t("mail.ignoreNote")}`,
      // 비밀번호 재설정 메일과 같은 모양 — 메일 클라이언트에서 버튼 하나로 끝나게
      html:
        `<p>${escapeHtml(t("mail.greeting", { name }))}</p>` +
        `<p>${escapeHtml(t("mail.verifyBodyHtml", { hours: TOKEN_TTL_HOURS }))}</p>` +
        `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 24px;` +
        `background:#d0402c;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(t("mail.verifyButton"))}</a></p>` +
        `<p style="color:#666;font-size:13px">${escapeHtml(t("mail.ignoreNote"))}</p>`,
    });

    this.log.log(`인증 메일 발송 (도메인: ${target.split("@")[1] ?? "?"})`);
    return { sent: true };
  }

  /**
   * 토큰으로 인증 완료.
   *
   * 토큰이 담고 있던 주소를 users.email 에 반영한다 — 주소 변경 흐름이
   * 여기서 완결된다. 그 주소가 그사이 다른 사람에게 선점되었으면 거절한다.
   */
  async confirm(token: string): Promise<{ email: string }> {
    const hash = hashToken(String(token ?? ""));

    // 원자적으로 소모한다 — 동시에 두 번 열려도 한 번만 성공한다
    const { rows } = await this.db.execute(sql`
      UPDATE email_verifications SET used_at = now()
      WHERE token_hash = ${hash} AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, email
    `);
    const row = rows[0];
    if (!row) {
      throw new BadRequestException("인증 링크가 만료되었거나 이미 사용되었습니다.");
    }

    const userId = String(row.user_id);
    const email = String(row.email);

    // 바꾸기 **전** 주소를 잡아 둔다 — 바뀐 뒤에는 알릴 곳을 알 수 없다
    const { rows: before } = await this.db.execute(sql`
      SELECT email, display_name FROM users WHERE id = ${userId}::uuid LIMIT 1
    `);
    const oldEmail = String(before[0]?.email ?? "");
    const name = String(before[0]?.display_name ?? "");
    const changed = oldEmail !== "" && oldEmail !== email;

    try {
      await this.db.execute(sql`
        UPDATE users SET email = ${email}, email_verified_at = now(), updated_at = now()
        WHERE id = ${userId}::uuid
      `);
    } catch (err) {
      // 인증 대기 중에 그 주소로 다른 사람이 가입한 경우
      throw new BadRequestException("이미 사용 중인 이메일 주소입니다.");
    }

    if (changed) {
      /*
       * 주소가 **바뀌었으면** 옛 주소에 알리고 모든 세션을 끊는다.
       *
       * 훔친 세션 하나로 계정이 통째로 넘어가는 경로였다. 재현했다: 세션 쿠키만
       * 있으면 주소를 공격자의 것으로 바꿀 수 있었고(현재 비밀번호를 묻지 않았다),
       * 확인 링크는 그 새 주소로 가고, 원래 주인에게는 **아무것도 가지 않았다.**
       * 그 뒤 원래 주소로는 로그인이 401 이 된다 — 계정을 잃은 것이다.
       *
       * 알림은 옛 주소로 간다. 그 주소의 주인만이 "내가 한 것이 아니다" 를 안다.
       * 메일이 실패해도 변경은 되돌리지 않는다 — 이미 확정된 사실이고, 여기서
       * 예외를 던지면 정상적으로 주소를 바꾼 사람이 오류 화면을 본다.
       *
       * 세션을 모두 끊는 것은 비밀번호 변경과 같은 처리다. 공격자가 들고 있던
       * 세션도 함께 끊긴다.
       */
      const t = makeTranslator({ locale: this.loader.siteLocale, catalogs: CORE_CATALOGS });
      const site = await this.loader.siteName();
      await this.mail
        .send({
          to: oldEmail,
          subject: t("mail.emailChangedSubject", { site }),
          text:
            `${t("mail.greeting", { name })}\n\n` +
            `${t("mail.emailChangedBody", { newEmail: email })}\n\n` +
            `${t("mail.emailChangedNotYou")}`,
        })
        .catch(() => false);
      await this.auth.revokeAllSessions(userId);
    }

    this.log.log(`이메일 인증 완료: ${userId}`);
    return { email };
  }

  /** 만료된 토큰 청소 — MaintenanceService 가 1시간마다 부른다 */
  async purgeExpired(): Promise<number> {
    const { rows } = await this.db.execute(sql`
      DELETE FROM email_verifications
      WHERE expires_at < now() - interval '7 days'
      RETURNING id
    `);
    return rows.length;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
