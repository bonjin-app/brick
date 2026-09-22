import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { BrickDb } from "@brick/database";
import { notifications, users } from "@brick/database";
import type { MailProvider } from "@brick/core";
import { DB, MAIL } from "../../runtime.module.js";

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

  /**
   * 알림 보내기.
   *
   * **절대 던지지 않는다.** 부르는 쪽은 댓글 등록·주문 처리 같은 주 흐름이고,
   * 알림이 실패했다고 그 일이 실패해서는 안 된다(메일이 그랬듯이).
   */
  async notify(input: NotifyInput): Promise<void> {
    const title = input.title.trim().slice(0, 300);
    if (!title) return;
    const body = (input.body ?? "").trim();
    const url = (input.url ?? "").trim().slice(0, 1000);

    if (input.userId) {
      await this.db
        .insert(notifications)
        .values({ id: randomUUID(), userId: input.userId, kind: input.kind, title, body: inboxBody(body), url })
        .catch((e: unknown) => {
          // 탈퇴로 회원이 사라진 뒤 도착한 알림 등 — 주 흐름을 막지 않는다
          this.logger.warn(`알림함 기록 실패 (${input.kind}): ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    if (input.mail === false) return;
    const to = input.email?.trim() || (input.userId ? await this.emailOf(input.userId) : "");
    if (!to) return;
    await this.mail
      .send({ to, subject: title, text: body ? `${body}\n\n${url}`.trim() : url })
      .catch(() => false);
  }

  private async emailOf(userId: string): Promise<string> {
    const [row] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.email ?? "";
  }

  /** 내 알림 목록 — 최신순. `before` 로 이어 읽는다 */
  async list(userId: string, opts: { limit?: number; before?: Date } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const where = opts.before
      ? and(eq(notifications.userId, userId), lt(notifications.createdAt, opts.before))
      : eq(notifications.userId, userId);
    const rows = await this.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
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
   * 읽음 표시. `id` 를 주면 그것만, 없으면 전부.
   *
   * 이미 읽은 것은 건드리지 않는다 — 읽은 시각은 "언제 봤나"의 기록이라
   * 목록을 다시 열 때마다 덮어쓰면 뜻이 사라진다.
   */
  async markRead(userId: string, id?: string): Promise<number> {
    const where = id
      ? and(eq(notifications.userId, userId), eq(notifications.id, id), isNull(notifications.readAt))
      : and(eq(notifications.userId, userId), isNull(notifications.readAt));
    const rows = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(where)
      .returning({ id: notifications.id });
    return rows.length;
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
