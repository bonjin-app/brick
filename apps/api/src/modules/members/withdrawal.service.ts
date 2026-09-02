import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import type { BrickDb } from "@brick/database";
import type { HookBus, PluginDb } from "@brick/core";
import { DB, HOOKS } from "../../runtime.module.js";
import { DataErasers } from "./data-erasers.js";

/**
 * 회원 탈퇴.
 *
 * 이 서비스가 해결하는 것은 충돌이다:
 *
 *   개인정보보호법 제21조 — 목적을 달성했으면 **지체 없이 파기**하라.
 *   전자상거래법 제6조   — 계약·결제·배송 기록은 **5년간 보존**하라.
 *
 * 둘 다 지키는 방법은 하나뿐이다. **개인을 지우고 거래를 남긴다.**
 * 주문 행은 남기되 작성자 연결을 끊고, 그 안의 개인정보(수령인 이름·연락처·주소)는
 * 보존 의무의 대상이므로 남기지만, 회원 계정에서는 찾아갈 수 없게 한다.
 *
 * 왜 행을 지우지 않는가:
 *   users 행을 DELETE 하면 ON DELETE CASCADE 로 주문까지 사라진다.
 *   그러면 보존 의무를 위반하고, 매출 통계도 과거가 바뀐다.
 *   그래서 **익명화**한다 — 행은 남고 사람은 사라진다.
 */

export interface WithdrawResult {
  /** 익명화된 계정의 새 식별자 (감사 로그 대조용) */
  anonymizedEmail: string;
  /** 함께 처리된 것들 */
  effects: string[];
}

@Injectable()
export class WithdrawalService {
  private readonly log = new Logger("Withdrawal");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(HOOKS) private readonly hooks: HookBus,
    private readonly erasers: DataErasers,
  ) {}

  /**
   * 탈퇴 처리.
   *
   * @param deletePosts 작성한 게시글도 지울지. 기본은 남긴다 —
   *   토론의 맥락이 통째로 사라지면 남은 사람들의 글이 읽을 수 없게 된다.
   *   남길 때도 작성자는 "탈퇴한 회원"으로 바뀐다.
   */
  async withdraw(params: {
    userId: string;
    reason?: string | null;
    deletePosts?: boolean;
    ip?: string | null;
  }): Promise<WithdrawResult> {
    const { rows: found } = await this.db.execute(sql`
      SELECT id, email, role, withdrawn_at FROM users WHERE id = ${params.userId}::uuid LIMIT 1
    `);
    const user = found[0];
    if (!user) throw new BadRequestException("회원을 찾을 수 없습니다.");
    if (user.withdrawn_at) throw new BadRequestException("이미 탈퇴 처리된 계정입니다.");

    // 마지막 관리자가 탈퇴하면 사이트에 들어갈 수 없다.
    // DB를 직접 만지지 않으면 복구가 불가능하므로 여기서 막는다.
    if (user.role === "admin") {
      const { rows: admins } = await this.db.execute(sql`
        SELECT count(*) AS n FROM users
        WHERE role = 'admin' AND is_active = true AND withdrawn_at IS NULL
      `);
      if (Number(admins[0]?.n ?? 0) <= 1) {
        throw new BadRequestException(
          "마지막 관리자는 탈퇴할 수 없습니다. 다른 관리자를 먼저 지정해주세요.",
        );
      }
    }

    const effects: string[] = [];
    // 재가입을 막지 않기 위해 원래 이메일은 비워야 하고(유니크 제약),
    // 동시에 같은 값이 겹치지 않아야 한다. 무작위 접미사를 쓴다.
    const suffix = randomBytes(8).toString("hex");
    const anonymizedEmail = `withdrawn-${suffix}@withdrawn.invalid`;

    await this.db.transaction(async (tx) => {
      // ── 1. 세션 즉시 무효화 ──
      // 탈퇴 요청 후에도 로그인 상태가 유지되면 "탈퇴했다"는 말이 거짓이 된다
      await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${params.userId}::uuid`);
      effects.push("로그인 세션 삭제");

      // ── 2. 소셜 연결 해제 ──
      // 남겨두면 같은 소셜 계정으로 다시 로그인할 때 탈퇴한 계정에 붙는다
      await tx.execute(sql`DELETE FROM user_identities WHERE user_id = ${params.userId}::uuid`);
      effects.push("소셜 연결 해제");

      // ── 3. 비밀번호 재설정·이메일 인증 토큰 폐기 ──
      await tx.execute(sql`DELETE FROM password_resets WHERE user_id = ${params.userId}::uuid`);
      await tx.execute(sql`DELETE FROM email_verifications WHERE user_id = ${params.userId}::uuid`);

      // ── 4. 개인정보 익명화 ──
      // 비밀번호 해시는 쓸 수 없는 값으로 덮는다. NULL 로 두지 않는 이유는
      // "비밀번호 없는 계정"이라는 상태를 인증 코드 전체에 퍼뜨리지 않기 위해서다
      // (소셜 전용 계정과 같은 판단 — docs/social-login.md).
      const deadHash = `withdrawn:${randomBytes(32).toString("hex")}`;
      await tx.execute(sql`
        UPDATE users SET
          admin_memo = NULL,
          email = ${anonymizedEmail},
          display_name = '탈퇴한 회원',
          password_hash = ${deadHash},
          password_login_enabled = false,
          is_active = false,
          marketing_opt_in = false,
          birth_month = NULL,
          birth_day = NULL,
          withdrawn_at = now(),
          withdraw_reason = ${String(params.reason ?? "").slice(0, 300) || null},
          updated_at = now()
        WHERE id = ${params.userId}::uuid
      `);
      effects.push("개인정보 익명화 (이메일·이름·비밀번호)");

      // ── 5. 플러그인 데이터 ──
      //
      // 코어는 플러그인 테이블 이름을 알지 않는다. 알려고 하면 두 가지가 깨진다 —
      // 코어가 플러그인에 의존하게 되고, 플러그인이 스키마를 바꿀 때 탈퇴가
      // 조용히 실패한다(실제로 shop_cart_items 에 user_id 가 없어서 500이 났다).
      //
      // 그래서 각 플러그인이 등록한 eraser 를 부른다. **예외를 삼키지 않는다** —
      // 하나라도 실패하면 트랜잭션이 되돌아가고, 지우지 못한 것을 지웠다고
      // 말하지 않게 된다. 훅(action)을 쓸 수 없는 이유가 이것이다.
      for (const eraser of this.erasers.list()) {
        const done = await eraser.erase({
          tx: tx as unknown as PluginDb,
          userId: params.userId,
          deletePosts: params.deletePosts === true,
        });
        effects.push(...done);
      }

      // 동의 이력(user_agreements)은 건드리지 않는다.
      // ON DELETE SET NULL 이 아니라 그대로 둔다 — user_id 가 익명화된 계정을
      // 계속 가리키므로, "이 계정이 언제 무엇에 동의했다"는 사실이 보존된다.
    });

    // 훅은 트랜잭션 밖에서 — 플러그인 예외가 탈퇴를 되돌리면 안 된다
    await this.hooks.doAction("user.withdrawn", { userId: params.userId });

    this.log.log(`회원 탈퇴 처리 완료: ${params.userId}`);
    return { anonymizedEmail, effects };
  }

  /**
   * 탈퇴 전 미리 보여줄 안내.
   *
   * "정말 탈퇴하시겠습니까?"만 묻는 것은 불충분하다. 무엇이 사라지고 무엇이 남는지
   * 알려주지 않으면 나중에 항의가 들어온다 — 특히 포인트와 주문 내역이 그렇다.
   */
  async preview(userId: string): Promise<{ items: Array<{ label: string; detail: string }> }> {
    const items: Array<{ label: string; detail: string }> = [];

    // 각 플러그인이 자기 손실을 설명한다.
    // describe 가 실패하면 그 항목만 건너뛴다 — 안내를 못 만드는 것이
    // 탈퇴 화면 전체를 막을 이유는 없다.
    for (const eraser of this.erasers.list()) {
      if (!eraser.describe) continue;
      try {
        items.push(...(await eraser.describe({ userId })));
      } catch (err) {
        this.log.warn(`탈퇴 안내 생성 실패 (${eraser.label}): ${String(err)}`);
      }
    }

    items.push({
      label: "개인정보",
      detail: "이메일·이름·비밀번호는 즉시 파기되며 같은 계정으로 다시 로그인할 수 없습니다.",
    });

    return { items };
  }
}

/** 이메일 인증·재설정 토큰과 같은 해시 방식 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
