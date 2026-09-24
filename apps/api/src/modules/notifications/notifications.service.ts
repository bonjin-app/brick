import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { notifications, users } from "@brick/database";
import type { MailProvider } from "@brick/core";
import { fillTemplate, normalizePhone } from "@brick/core";
import type { SmsProvider } from "@brick/core";
import { DB, MAIL } from "../../runtime.module.js";

/** 읽은 알림을 얼마나 들고 있나 */
const READ_KEEP_DAYS = 30;
/** 안 읽은 것까지 포함해 무조건 지우는 나이 */
const ANY_KEEP_DAYS = 180;

/** 알림 하나 — 두 통로(알림함·메일)에 같은 말을 보낸다 */
export interface NotifyInput {
  /** 받는 회원. 있으면 알림함에 남는다 */
  userId?: string | null;
  /**
   * 받는 주소. 없으면 회원의 가입 주소로 보낸다.
   *
   * 비회원 손님(주문·1:1문의)에게는 이것만 있다 — 알림함을 볼 수 없으므로
   * 메일이 유일한 길이고, 그래서 이 값이 있으면 회원 여부와 무관하게 보낸다.
   */
  email?: string | null;
  /** board.comment · helpdesk.answered · shop.order … */
  kind: string;
  title: string;
  body?: string;
  /** 눌러서 갈 사이트 안 경로 (`/board/free/…`) */
  url?: string;
  /**
   * 메일은 보내지 않는다.
   *
   * "읽음 표시"처럼 사이트 안에서만 뜻이 있는 알림에 쓴다 — 메일함까지 따라가면
   * 성가심이 된다. 기본은 보내는 쪽이다(알림을 놓치는 쪽이 더 나쁘다).
   */
  mail?: false;
  /** 문자 받을 번호 (`sms: true` 일 때만 쓰인다) */
  phone?: string | null;
  /**
   * 문자로도 보낸다 — **옵트인**이다.
   *
   * 문자는 건당 요금이 나간다. 그래서 메일과 반대로, 부르는 쪽이 명시적으로
   * 켠 알림만 나간다(주문 접수·발송처럼 손님이 기다리는 것).
   */
  sms?: true;
  /** 무슨 알림인가 — 알림톡처럼 승인된 템플릿으로 보내는 통로가 이것으로 템플릿을 찾는다 */
  event?: string;
  /** 템플릿 변수 값 */
  vars?: Record<string, string>;
}

/**
 * 알림 — **메일과 알림함 두 통로로 같은 말을 보낸다.**
 *
 * 지금까지 알림은 `mail.send` 하나뿐이었다. 그런데 SMTP 미설정은 설치 직후의
 * 기본값이고(대시보드가 그 상태를 스스로 경고한다), 그래서 기본 설치에서는
 * 댓글도 문의 답변도 주문 안내도 **조용히 사라졌다** — 손님은 답이 없다고 느끼고
 * 운영자는 보냈다고 믿는다.
 *
 * 알림함은 메일을 대체하지 않는다. 메일이 되면 둘 다 가고, 안 되면 최소한
 * 로그인한 사람은 사이트에서 본다.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(MAIL) private readonly mail: MailProvider,
  ) {}

  /*
   * 문자 발송기.
   *
   * 플러그인이 등록하면 **로더가 여기에 넣어 준다**(우리가 로더를 읽으러 가지
   * 않는다 — 로더는 이미 우리를 쓰고 있어서, 서로를 읽으면 모듈이 순환한다).
   * 하나만 둔다: 둘이 등록하면 같은 안내가 두 번 나가고 요금도 두 배다.
   */
  private smsGateway: { plugin: string; gateway: SmsProvider } | null = null;

  setSmsGateway(plugin: string, gateway: SmsProvider): void {
    this.smsGateway = { plugin, gateway };
  }

  /** 그 플러그인이 등록한 발송기를 치운다 (꺼진 확장이 계속 요금을 쓰면 안 된다) */
  clearSmsGateway(plugin: string): void {
    if (this.smsGateway?.plugin === plugin) this.smsGateway = null;
  }

  /** 지금 문자를 보낼 수 있는가 (설정 화면·대시보드가 읽는다) */
  smsEnabled(): boolean {
    return Boolean(this.smsGateway?.gateway.enabled);
  }

  /**
   * 알림 보내기.
   *
   * **절대 던지지 않는다.** 부르는 쪽은 댓글 등록·주문 처리 같은 주 흐름이고,
   * 알림이 실패했다고 그 일이 실패해서는 안 된다(메일이 그랬듯이).
   */
  async notify(input: NotifyInput): Promise<void> {
    let title = input.title.trim().slice(0, 300);
    let body = (input.body ?? "").trim();
    /** 운영자가 따로 쓴 문자 문구 (없으면 제목 + 본문) */
    let smsText: string | null = null;
    /*
     * 운영자가 고친 문구가 있으면 그것으로 보낸다 — 알림함·메일·문자 모두.
     *
     * 보내는 쪽(플러그인)은 늘 기본 문구와 변수를 함께 넘긴다. 문구를 코드에서 고치던 시절에는
     * "입금 확인 후 1~2일 안에 발송됩니다" 한 줄을 더하려고 개발자를 불렀다.
     */
    if (input.event) {
      const tpl = await this.templateFor(input.event);
      if (tpl) {
        const vars = input.vars ?? {};
        title = fillTemplate(tpl.subject, vars).replace(/\s+/g, " ").slice(0, 300) || title;
        body = fillTemplate(tpl.body, vars);
        smsText = tpl.sms?.trim() ? fillTemplate(tpl.sms, vars) : null;
      }
    }
    if (!title) return;
    const url = (input.url ?? "").trim().slice(0, 1000);

    if (input.userId) {
      await this.db
        .insert(notifications)
        // uuidv7 = 시각이 앞에 오는 id. 목록 정렬과 이어 읽기가 이 한 값으로 끝난다
        .values({ id: uuidv7(), userId: input.userId, kind: input.kind, title, body: inboxBody(body), url })
        .catch((e: unknown) => {
          // 탈퇴로 회원이 사라진 뒤 도착한 알림 등 — 주 흐름을 막지 않는다
          this.logger.warn(`알림함 기록 실패 (${input.kind}): ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    /*
     * 문자.
     *
     * 메일보다 먼저 보낸다 — 둘 다 나가는 알림이라면 손님이 먼저 보는 쪽이 문자다.
     * 발송기가 없으면(플러그인 미설치) 조용히 지나간다: 문자는 있으면 좋은 통로이지
     * 없다고 알림이 실패해야 할 것은 아니다.
     */
    if (input.sms) {
      const gateway = this.smsGateway?.gateway ?? null;
      const phone = normalizePhone(input.phone);
      if (gateway?.enabled && phone) {
        await gateway
          .send({
            to: phone, title, text: smsText ?? (body ? `${title}\n\n${body}` : title),
            // 알림톡처럼 승인된 템플릿으로만 보내는 통로가 이것으로 템플릿을 찾아 채운다
            ...(input.event ? { event: input.event, vars: input.vars ?? {} } : {}),
          })
          .catch(() => false);
      }
    }

    if (input.mail === false) return;
    const to = input.email?.trim() || (input.userId ? await this.emailOf(input.userId) : "");
    if (!to) return;
    await this.mail
      .send({ to, subject: title, text: body ? `${body}\n\n${url}`.trim() : url })
      .catch(() => false);
  }

  /** 운영자가 고친 알림 문구 — 없으면 null (기본 문구로 나간다). 읽기 실패도 기본 문구로 */
  async templateFor(event: string): Promise<{ subject: string; body: string; sms: string | null; updatedAt: Date } | null> {
    try {
      const { rows } = (await this.db.execute(sql`
        SELECT subject, body, sms, updated_at FROM notification_templates WHERE event = ${event}
      `)) as unknown as { rows: Array<{ subject: string; body: string; sms: string | null; updated_at: string | Date }> };
      const r = rows[0];
      return r ? { subject: r.subject, body: r.body, sms: r.sms, updatedAt: new Date(r.updated_at) } : null;
    } catch (e) {
      this.logger.warn(`알림 문구를 읽지 못해 기본 문구로 보냅니다 (${event}): ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async saveTemplate(event: string, t: { subject: string; body: string; sms: string | null }, userId: string | null): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO notification_templates (event, subject, body, sms, updated_by, updated_at)
      VALUES (${event}, ${t.subject}, ${t.body}, ${t.sms}, ${userId}::uuid, now())
      ON CONFLICT (event) DO UPDATE SET
        subject = EXCLUDED.subject, body = EXCLUDED.body, sms = EXCLUDED.sms,
        updated_by = EXCLUDED.updated_by, updated_at = now()
    `);
  }

  async removeTemplate(event: string): Promise<boolean> {
    const { rows } = (await this.db.execute(sql`
      DELETE FROM notification_templates WHERE event = ${event} RETURNING event
    `)) as unknown as { rows: unknown[] };
    return rows.length > 0;
  }

  async customizedEvents(): Promise<Map<string, Date>> {
    const { rows } = (await this.db.execute(sql`SELECT event, updated_at FROM notification_templates`)) as unknown as {
      rows: Array<{ event: string; updated_at: string | Date }>;
    };
    return new Map(rows.map((r) => [r.event, new Date(r.updated_at)]));
  }

  private async emailOf(userId: string): Promise<string> {
    const [row] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.email ?? "";
  }

  /**
   * 내 알림 목록 — 최신순. `before`(앞 쪽의 마지막 id)로 이어 읽는다.
   *
   * 시각 하나로 자르지 않는다. 같은 순간에 들어온 두 알림이 경계에 걸리면
   * **하나가 건너뛰거나 두 번 나온다** — 재입고 알림처럼 한 번에 여러 건을 넣는
   * 경로가 실제로 있고, `created_at` 은 트랜잭션 안에서 같은 값이다.
   * 그래서 `(시각, id)` 쌍으로 자른다: 같은 시각이어도 id 가 갈라 준다.
   *
   * id 만으로 자르지 않는 이유는, 알림을 넣는 쪽이 항상 우리라는 보장이 없기
   * 때문이다(가져오기·복원이 다른 방식의 id 를 넣으면 순서가 어긋난다).
   * 시각이 먼저인 정렬은 누가 넣었든 맞다.
   */
  async list(userId: string, opts: { limit?: number; before?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);

    /*
     * 이어 읽기 지점이 **내 알림인지** 먼저 확인한다. 없는 id 를 그대로 하위
     * 질의에 넣으면 비교가 NULL 이 되어 빈 목록이 나가는데, 그건 "알림이 없다"
     * 는 거짓말이다. 남의 id 로 남의 목록에 넘어갈 수도 없다.
     */
    let hasCursor = false;
    if (opts.before) {
      const [row] = await this.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.id, opts.before), eq(notifications.userId, userId)))
        .limit(1);
      hasCursor = Boolean(row);
    }

    /*
     * 비교는 **DB 안에서** 한다 — 시각을 자바스크립트로 꺼냈다 넣으면 정밀도가
     * 깎인다. PostgreSQL 의 timestamptz 는 마이크로초까지 있는데 JS Date 는
     * 밀리초까지다. 그 잘린 값으로 자르면 경계의 한 건이 두 번 나오거나
     * (같은 밀리초 안의 것들이) 통째로 사라진다 — 실제로 그렇게 비어 나왔다.
     */
    const where = hasCursor
      ? and(
          eq(notifications.userId, userId),
          sql`(${notifications.createdAt}, ${notifications.id}) <
              (SELECT created_at, id FROM notifications WHERE id = ${opts.before}::uuid)`,
        )
      : eq(notifications.userId, userId);
    const rows = await this.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      url: r.url,
      read: r.readAt !== null,
      createdAt: r.createdAt,
    }));
  }

  /** 안 읽은 개수 — 머리의 배지가 읽는다 */
  async unreadCount(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return row?.n ?? 0;
  }

  /**
   * 읽음 표시.
   *
   * `ids` 를 주면 **그것만** — 화면에 보여준 것만 읽음으로 넘기기 위해서다.
   * 전에는 알림함을 열면 안 읽은 것을 **전부** 읽음 처리했는데, 화면에는 서른
   * 건만 보여준다. 안 읽은 것이 서른다섯 건이면 다섯 건은 **보지도 못한 채**
   * 사라졌다(주문이 몰리는 쇼핑몰에서 바로 일어난다).
   *
   * `ids` 가 없으면 전부다 — 그건 사람이 "모두 읽음" 을 누른 경우다.
   *
   * 이미 읽은 것은 건드리지 않는다 — 읽은 시각은 "언제 봤나"의 기록이라
   * 목록을 다시 열 때마다 덮어쓰면 뜻이 사라진다.
   */
  async markRead(userId: string, ids?: readonly string[]): Promise<number> {
    if (ids && ids.length === 0) return 0;
    const mine = and(eq(notifications.userId, userId), isNull(notifications.readAt));
    const rows = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      // 남의 알림 id 를 섞어 보내도 userId 조건이 함께 걸려 아무 일도 일어나지 않는다
      .where(ids ? and(mine, inArray(notifications.id, [...ids])) : mine)
      .returning({ id: notifications.id });
    return rows.length;
  }

  /**
   * 오래된 알림 정리 — 주기 정리 작업(MaintenanceService)이 부른다.
   *
   * 알림은 **댓글·주문·재입고마다 한 줄씩** 쌓인다. 치우지 않으면 이 테이블이
   * 본문보다 커지고, 그 비용은 조용히 늘기만 한다(세션·캐시·감사 로그를 치우는
   * 것과 같은 이유다 — 그런데 알림만 빠져 있었다).
   *
   * 읽은 것은 30일, 안 읽은 것도 180일이면 지운다. 반년이 지나도록 열어 보지
   * 않은 알림은 이미 낡았고, 그때까지 붙들고 있어서 좋아지는 사람이 없다.
   */
  async prune(): Promise<void> {
    const readCutoff = new Date(Date.now() - READ_KEEP_DAYS * 86_400_000);
    const anyCutoff = new Date(Date.now() - ANY_KEEP_DAYS * 86_400_000);
    await this.db
      .delete(notifications)
      .where(
        or(
          and(isNotNull(notifications.readAt), lt(notifications.readAt, readCutoff)),
          lt(notifications.createdAt, anyCutoff),
        ),
      );
  }
}

/**
 * 알림함에 남길 본문.
 *
 * 같은 문구가 메일로도 나가는데, 메일 본문에는 **맨 주소 줄**이 들어 있다 —
 * 메일에는 링크를 걸 수 없으니 주소를 통째로 적는 수밖에 없기 때문이다.
 * 그런데 알림함에서는 제목이 이미 그리로 가는 링크라, 그 줄은
 * `http://example.com/board/free/01a0c68b-…#comments` 같은 날것의 문자열로
 * 남아 목록을 읽기 어렵게 만든다(실제로 화면에서 그렇게 보였다).
 *
 * 문장은 건드리지 않는다 — **한 줄이 통째로 주소인 경우**만 덜어낸다.
 */
function inboxBody(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s*https?:\/\/\S+\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
