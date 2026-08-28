import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
// HTML 제거는 코어의 것을 쓴다 — 검색 발췌와 같은 규칙이어야 한다
import { stripHtml } from "@brick/core";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { randomBytes } from "node:crypto";
import type { BrickDb } from "@brick/database";
import type { MailProvider, QueueProvider } from "@brick/core";
import { DB, ENV, MAIL, QUEUE } from "../../runtime.module.js";
import type { loadEnv } from "../../config/env.js";

/**
 * 회원 단체메일.
 *
 * **틀리면 법을 위반한다.** 정보통신망법 제50조:
 *  - 영리목적 광고성 정보는 **사전 동의**를 받은 사람에게만
 *  - 제목 앞에 **(광고)** 표기
 *  - 본문에 **수신거부 방법** 명시
 *
 * 그래서 구분을 사용자에게 맡기지 않는다. 종류(공지/광고)를 고르면
 * 수신자 조건이 자동으로 바뀌고 광고는 제목·본문이 강제로 보정된다.
 */

export const CAMPAIGN_KINDS = ["notice", "ad"] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

export const KIND_LABEL: Record<CampaignKind, string> = {
  notice: "공지 (동의 불필요)",
  ad: "광고 (수신 동의자만)",
};

export const CAMPAIGN_STATUS = ["draft", "sending", "sent", "failed", "cancelled"] as const;
export const STATUS_LABEL: Record<string, string> = {
  draft: "작성중",
  sending: "발송중",
  sent: "발송완료",
  failed: "실패",
  cancelled: "취소",
};

/** 광고 제목 접두어 — 법으로 정해진 문구다 */
const AD_PREFIX = "(광고)";

/** 한 번에 처리하는 수신자 수. SMTP 서버를 몰아치지 않도록 나눈다 */
const BATCH = 20;

/** 배치 사이 대기 (ms) — 초당 발송량을 제한한다 */
const BATCH_DELAY_MS = 1000;

const QUEUE_JOB = "mailing.send";

export interface Filters {
  roles?: string[];
  joinedAfter?: string | null;
  joinedBefore?: string | null;
  /** 이 일수 이상 미접속 */
  inactiveDays?: number | null;
  /** 이메일 인증한 회원만 */
  verifiedOnly?: boolean;
}

@Injectable()
export class MailingService {
  private readonly log = new Logger("Mailing");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(MAIL) private readonly mail: MailProvider,
    @Inject(QUEUE) private readonly queue: QueueProvider,
    @Inject(ENV) private readonly env: ReturnType<typeof loadEnv>,
  ) {
    // 워커 등록 — 발송은 요청 밖에서 진행된다.
    // 수만 명에게 보내는 것은 몇 분~몇 시간이 걸리고, 요청 안에서 다 보내면
    // 타임아웃이 나고 어디까지 보냈는지 알 수 없어진다.
    this.queue.process<{ campaignId: string }>(QUEUE_JOB, async (job) => {
      await this.runCampaign(job.payload.campaignId);
    });
  }

  /**
   * 수신자 조건 → SQL.
   *
   * 광고는 **marketing_opt_in = true** 를 조건에서 뺄 수 없다.
   * 이것을 옵션으로 두면 실수로 끄는 순간 위법이 된다.
   */
  private recipientFilter(kind: CampaignKind, filters: Filters) {
    const parts = [
      // 탈퇴·정지 회원에게는 보내지 않는다
      sql`u.withdrawn_at IS NULL`,
      sql`u.is_active = true`,
      // 내부 주소(.invalid)는 실제로 메일이 나가지 않는다 — 실패로 세어질 뿐이다
      sql`u.email NOT LIKE '%.invalid'`,
    ];

    if (kind === "ad") {
      // 광고는 동의자에게만. 조건에서 빼는 방법을 만들지 않는다.
      parts.push(sql`u.marketing_opt_in = true`);
    }

    const roles = (filters.roles ?? []).filter((r) =>
      ["admin", "manager", "member"].includes(r),
    );
    if (roles.length) {
      parts.push(sql`u.role IN (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})`);
    }

    if (filters.joinedAfter) {
      parts.push(sql`u.created_at >= ${new Date(filters.joinedAfter)}`);
    }
    if (filters.joinedBefore) {
      parts.push(sql`u.created_at <= ${new Date(filters.joinedBefore)}`);
    }
    if (filters.inactiveDays && filters.inactiveDays > 0) {
      const days = Math.min(3650, Math.floor(filters.inactiveDays));
      parts.push(
        sql`coalesce(u.last_login_at, u.created_at) < now() - ${sql.raw(`interval '${days} days'`)}`,
      );
    }
    if (filters.verifiedOnly) {
      parts.push(sql`u.email_verified_at IS NOT NULL`);
    }

    return sql.join(parts, sql` AND `);
  }

  /**
   * 대상 수 미리보기.
   *
   * 발송 전에 몇 명에게 가는지 알아야 한다. 수만 명에게 잘못 보내는 것은
   * 되돌릴 수 없다.
   */
  async preview(
    kind: CampaignKind,
    filters: Filters,
  ): Promise<{ count: number; sample: string[]; excludedByConsent: number }> {
    const where = this.recipientFilter(kind, filters);
    const { rows } = await this.db.execute(sql`
      SELECT count(*) AS n FROM users u WHERE ${where}
    `);

    // 광고에서 동의하지 않아 빠진 인원을 따로 보여준다 —
    // "대상이 왜 이렇게 적은가"에 답이 된다
    let excludedByConsent = 0;
    if (kind === "ad") {
      const noConsent = this.recipientFilter("notice", filters);
      const { rows: all } = await this.db.execute(sql`
        SELECT count(*) AS n FROM users u WHERE ${noConsent}
      `);
      excludedByConsent = Math.max(0, Number(all[0]?.n ?? 0) - Number(rows[0]?.n ?? 0));
    }

    const { rows: sample } = await this.db.execute(sql`
      SELECT email FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT 5
    `);

    return {
      count: Number(rows[0]?.n ?? 0),
      sample: sample.map((r) => maskEmail(String(r.email))),
      excludedByConsent,
    };
  }

  /**
   * 캠페인 생성 + 대상 확정.
   *
   * 대상을 미리 행으로 만든다. 발송 중에 회원이 가입하거나 수신 동의를 철회하면
   * 조건이 달라지는데, 그때 "누구에게 보냈는가"가 흔들리면 안 된다.
   * 그리고 이 행들이 재시도의 근거다 — 서버가 죽어도 pending 만 다시 보낸다.
   */
  async create(params: {
    kind: string;
    subject: string;
    body: string;
    isHtml?: boolean;
    filters?: Filters;
    actorId: string;
  }): Promise<{ id: string; total: number }> {
    const kind = String(params.kind) as CampaignKind;
    if (!CAMPAIGN_KINDS.includes(kind)) {
      throw new BadRequestException("발송 종류가 올바르지 않습니다.");
    }

    let subject = String(params.subject ?? "").trim();
    if (!subject) throw new BadRequestException("제목을 입력해주세요.");
    if (subject.length > 250) throw new BadRequestException("제목이 너무 깁니다. (250자 이내)");

    const body = String(params.body ?? "").trim();
    if (!body) throw new BadRequestException("본문을 입력해주세요.");
    if (body.length > 100_000) throw new BadRequestException("본문이 너무 깁니다.");

    // 광고는 제목에 (광고)를 붙인다. 이미 있으면 중복하지 않는다.
    // 사용자가 지웠어도 다시 붙는다 — 선택 사항이 아니다.
    if (kind === "ad" && !subject.startsWith(AD_PREFIX)) {
      subject = `${AD_PREFIX} ${subject}`;
    }

    const filters = normalizeFilters(params.filters);
    const id = uuidv7();

    await this.db.execute(sql`
      INSERT INTO mail_campaigns (id, kind, subject, body, is_html, filters, created_by)
      VALUES (${id}, ${kind}, ${subject}, ${body}, ${params.isHtml === true},
              ${JSON.stringify(filters)}::jsonb, ${params.actorId}::uuid)
    `);

    // 대상 확정
    const where = this.recipientFilter(kind, filters);
    const { rows } = await this.db.execute(sql`
      INSERT INTO mail_recipients (id, campaign_id, user_id, email)
      SELECT gen_random_uuid(), ${id}::uuid, u.id, u.email
      FROM users u WHERE ${where}
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const total = rows.length;

    await this.db.execute(sql`
      UPDATE mail_campaigns SET total_count = ${total} WHERE id = ${id}::uuid
    `);

    return { id, total };
  }

  /** 발송 시작 — 큐에 넣고 즉시 반환한다 */
  async start(campaignId: string): Promise<{ queued: boolean; total: number }> {
    const { rows } = await this.db.execute(sql`
      SELECT status, total_count FROM mail_campaigns WHERE id = ${campaignId}::uuid LIMIT 1
    `);
    const c = rows[0];
    if (!c) throw new BadRequestException("캠페인을 찾을 수 없습니다.");
    if (String(c.status) === "sending") {
      throw new BadRequestException("이미 발송 중입니다.");
    }
    if (String(c.status) === "sent") {
      throw new BadRequestException("이미 발송이 완료되었습니다.");
    }
    if (Number(c.total_count) === 0) {
      throw new BadRequestException(
        "받을 사람이 없습니다. 수신자 조건을 확인해주세요 " +
          "(광고는 수신 동의한 회원에게만 발송됩니다).",
      );
    }
    if (!this.mail.enabled) {
      // SMTP 없이 시작하면 전부 실패로 기록된다 — 시작 전에 막는다
      throw new BadRequestException(
        "SMTP가 설정되지 않아 메일을 보낼 수 없습니다. 환경변수를 확인해주세요.",
      );
    }

    await this.db.execute(sql`
      UPDATE mail_campaigns SET status = 'sending', started_at = now(), error = NULL
      WHERE id = ${campaignId}::uuid
    `);
    await this.queue.enqueue(QUEUE_JOB, { campaignId }, { maxAttempts: 3 });

    return { queued: true, total: Number(c.total_count) };
  }

  /** 발송 중단 — 남은 대상은 pending 으로 남고, 다시 시작하면 이어서 보낸다 */
  async cancel(campaignId: string): Promise<void> {
    const { rows } = await this.db.execute(sql`
      UPDATE mail_campaigns SET status = 'cancelled', finished_at = now()
      WHERE id = ${campaignId}::uuid AND status IN ('draft', 'sending')
      RETURNING id
    `);
    if (!rows.length) {
      throw new BadRequestException("중단할 수 없는 상태입니다.");
    }
  }

  /**
   * 실제 발송 (워커).
   *
   * 배치로 나누고 사이에 쉰다 — SMTP 서버를 몰아치면 차단되거나
   * 스팸으로 분류된다. 그리고 **한 통 실패가 전체를 멈추지 않는다**.
   */
  private async runCampaign(campaignId: string): Promise<void> {
    const { rows } = await this.db.execute(sql`
      SELECT id, kind, subject, body, is_html, status FROM mail_campaigns
      WHERE id = ${campaignId}::uuid LIMIT 1
    `);
    const c = rows[0];
    if (!c) return;
    if (String(c.status) !== "sending") {
      this.log.log(`발송 건너뜀 (상태: ${String(c.status)})`);
      return;
    }

    const kind = String(c.kind) as CampaignKind;
    let sent = 0;
    let failed = 0;

    for (;;) {
      // 중단 확인 — 관리자가 멈추면 즉시 반영된다
      const { rows: cur } = await this.db.execute(sql`
        SELECT status FROM mail_campaigns WHERE id = ${campaignId}::uuid LIMIT 1
      `);
      if (String(cur[0]?.status) !== "sending") {
        this.log.log(`발송 중단됨 (${sent}건 발송 후)`);
        return;
      }

      const { rows: batch } = await this.db.execute(sql`
        SELECT id, user_id, email FROM mail_recipients
        WHERE campaign_id = ${campaignId}::uuid AND status = 'pending'
        ORDER BY id LIMIT ${BATCH}
      `);
      if (!batch.length) break;

      for (const r of batch) {
        const userId = r.user_id ? String(r.user_id) : null;
        const email = String(r.email);

        // 발송 직전에 수신 동의를 다시 확인한다.
        // 대상 확정 후 철회했을 수 있고, 그 사람에게 보내면 위법이다.
        if (kind === "ad" && userId) {
          const { rows: still } = await this.db.execute(sql`
            SELECT marketing_opt_in, withdrawn_at FROM users WHERE id = ${userId}::uuid LIMIT 1
          `);
          const ok = still[0]?.marketing_opt_in === true && !still[0]?.withdrawn_at;
          if (!ok) {
            await this.db.execute(sql`
              UPDATE mail_recipients SET status = 'skipped',
                error = '수신 동의 철회 또는 탈퇴', sent_at = now()
              WHERE id = ${String(r.id)}::uuid
            `);
            continue;
          }
        }

        const text = await this.renderBody(String(c.body), { kind, userId, email });
        let ok = false;
        try {
          ok = await this.mail.send({
            to: email,
            subject: String(c.subject),
            text: c.is_html ? stripHtml(text) : text,
            html: c.is_html ? text : undefined,
          });
        } catch (err) {
          this.log.warn(`발송 실패 (${maskEmail(email)}): ${String(err)}`);
        }

        if (ok) {
          sent += 1;
          await this.db.execute(sql`
            UPDATE mail_recipients SET status = 'sent', sent_at = now()
            WHERE id = ${String(r.id)}::uuid
          `);
        } else {
          failed += 1;
          await this.db.execute(sql`
            UPDATE mail_recipients SET status = 'failed', error = '발송 실패', sent_at = now()
            WHERE id = ${String(r.id)}::uuid
          `);
        }
      }

      await this.db.execute(sql`
        UPDATE mail_campaigns SET sent_count = ${sent}, failed_count = ${failed}
        WHERE id = ${campaignId}::uuid
      `);

      // SMTP 를 몰아치지 않는다.
      // 마지막 배치(정원 미달)면 쉬지 않는다 — 스무 명에게 보내고 1초를 더
      // 기다리면 관리자 화면에 이유 없이 "발송중"으로 남는다.
      if (batch.length === BATCH) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    await this.db.execute(sql`
      UPDATE mail_campaigns SET
        status = ${failed > 0 && sent === 0 ? "failed" : "sent"},
        sent_count = ${sent}, failed_count = ${failed}, finished_at = now()
      WHERE id = ${campaignId}::uuid
    `);
    this.log.log(`발송 완료: 성공 ${sent} · 실패 ${failed}`);
  }

  /**
   * 본문 렌더 — 수신거부 안내를 붙인다.
   *
   * 정보통신망법 제50조 제4항은 수신거부 방법을 **본문에 명시**하라고 정한다.
   * 로그인해서 설정을 바꾸라고 하는 것은 "쉬운 방법"이 아니다 —
   * 링크 한 번으로 해제되어야 한다.
   *
   * 공지에는 붙이지 않는다. 공지는 수신 거부의 대상이 아니고(서비스 운영에
   * 필요한 정보), 거부 링크를 붙이면 광고로 오인된다.
   */
  private async renderBody(
    body: string,
    ctx: { kind: CampaignKind; userId: string | null; email: string },
  ): Promise<string> {
    if (ctx.kind !== "ad" || !ctx.userId) return body;

    const token = await this.unsubscribeToken(ctx.userId);
    const base = this.env.siteUrl.replace(/\/+$/, "");
    const link = `${base}/api/mail/unsubscribe?token=${token}`;

    return (
      `${body}\n\n` +
      `─────────────────────────────\n` +
      `이 메일은 광고성 정보 수신에 동의하신 분께 발송되었습니다.\n` +
      `수신을 원하지 않으시면 아래 주소를 열어주세요 (로그인 불필요):\n${link}\n`
    );
  }

  /**
   * 수신거부 토큰 — 회원별로 하나이고 만료되지 않는다.
   * 오래된 메일의 링크도 동작해야 한다.
   */
  private async unsubscribeToken(userId: string): Promise<string> {
    const { rows } = await this.db.execute(sql`
      SELECT token FROM mail_unsubscribe_tokens WHERE user_id = ${userId}::uuid LIMIT 1
    `);
    if (rows[0]) return String(rows[0].token);

    const token = randomBytes(24).toString("base64url");
    await this.db.execute(sql`
      INSERT INTO mail_unsubscribe_tokens (user_id, token)
      VALUES (${userId}::uuid, ${token})
      ON CONFLICT (user_id) DO NOTHING
    `);
    // 동시 요청으로 다른 토큰이 먼저 들어갔을 수 있다 — 저장된 값을 읽는다
    const { rows: saved } = await this.db.execute(sql`
      SELECT token FROM mail_unsubscribe_tokens WHERE user_id = ${userId}::uuid LIMIT 1
    `);
    return String(saved[0]?.token ?? token);
  }

  /**
   * 수신거부 처리.
   *
   * **로그인을 요구하지 않는다.** 메일을 받은 사람이 그 자리에서 끊을 수
   * 있어야 하고, 그게 법이 요구하는 "쉬운 방법"이다.
   * 토큰이 틀려도 성공처럼 응답하지 않는다 — 사용자가 해제됐다고 믿으면 안 된다.
   */
  async unsubscribe(token: string): Promise<{ email: string }> {
    const { rows } = await this.db.execute(sql`
      UPDATE users SET marketing_opt_in = false, updated_at = now()
      WHERE id = (
        SELECT user_id FROM mail_unsubscribe_tokens WHERE token = ${String(token ?? "")} LIMIT 1
      )
      RETURNING email
    `);
    if (!rows.length) {
      throw new BadRequestException("수신거부 주소가 올바르지 않습니다.");
    }
    return { email: maskEmail(String(rows[0].email)) };
  }

  /* ── 조회 ────────────────────────────────────────── */

  async list(page: number) {
    const size = 30;
    const { rows } = await this.db.execute(sql`
      SELECT c.id, c.kind, c.subject, c.status, c.total_count, c.sent_count, c.failed_count,
             c.created_at, c.started_at, c.finished_at, c.error, u.display_name AS created_by_name
      FROM mail_campaigns c
      LEFT JOIN users u ON u.id = c.created_by
      ORDER BY c.created_at DESC LIMIT ${size} OFFSET ${(Math.max(1, page) - 1) * size}
    `);
    const { rows: cnt } = await this.db.execute(sql`SELECT count(*) AS n FROM mail_campaigns`);
    return {
      items: rows.map((r) => ({
        ...r,
        kind_label: KIND_LABEL[String(r.kind) as CampaignKind] ?? String(r.kind),
        status_label: STATUS_LABEL[String(r.status)] ?? String(r.status),
      })),
      total: Number(cnt[0]?.n ?? 0),
      page: Math.max(1, page),
      pageSize: size,
    };
  }

  async detail(campaignId: string) {
    const { rows } = await this.db.execute(sql`
      SELECT * FROM mail_campaigns WHERE id = ${campaignId}::uuid LIMIT 1
    `);
    const c = rows[0];
    if (!c) throw new BadRequestException("캠페인을 찾을 수 없습니다.");

    // 실패한 대상만 보여준다. 성공 목록은 수만 건이고 볼 이유가 없다 —
    // 알아야 하는 것은 "누가 못 받았는가"다.
    const { rows: failures } = await this.db.execute(sql`
      SELECT email, error FROM mail_recipients
      WHERE campaign_id = ${campaignId}::uuid AND status IN ('failed', 'skipped')
      ORDER BY email LIMIT 100
    `);
    const { rows: counts } = await this.db.execute(sql`
      SELECT status, count(*) AS n FROM mail_recipients
      WHERE campaign_id = ${campaignId}::uuid GROUP BY status
    `);

    return {
      campaign: {
        ...c,
        kind_label: KIND_LABEL[String(c.kind) as CampaignKind] ?? String(c.kind),
        status_label: STATUS_LABEL[String(c.status)] ?? String(c.status),
      },
      byStatus: Object.fromEntries(counts.map((r) => [String(r.status), Number(r.n)])),
      // 주소를 가려서 보여준다 — 발송 이력 화면에 회원 주소가 그대로 뜰 이유가 없다
      failures: failures.map((r) => ({
        email: maskEmail(String(r.email)),
        error: r.error,
      })),
    };
  }
}

/* ── 헬퍼 ──────────────────────────────────────────── */

function normalizeFilters(raw: Filters | undefined): Filters {
  const f = raw ?? {};
  return {
    roles: Array.isArray(f.roles)
      ? f.roles.map(String).filter((r) => ["admin", "manager", "member"].includes(r))
      : [],
    joinedAfter: f.joinedAfter ? String(f.joinedAfter) : null,
    joinedBefore: f.joinedBefore ? String(f.joinedBefore) : null,
    inactiveDays:
      f.inactiveDays === null || f.inactiveDays === undefined
        ? null
        : Math.max(0, Math.floor(Number(f.inactiveDays))) || null,
    verifiedOnly: f.verifiedOnly === true,
  };
}

/**
 * 주소 가리기.
 *
 * 발송 이력·실패 목록에 회원 주소가 그대로 뜰 이유가 없다.
 * 운영자가 필요한 것은 "누가 못 받았는지 알아볼 수 있는 정도"다.
 */
function maskEmail(email: string): string {
  const [local, domain] = String(email).split("@");
  if (!domain) return "***";
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}


