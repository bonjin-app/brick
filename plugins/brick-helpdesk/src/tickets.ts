import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db, HelpSettings } from "./types.js";
import { HelpError, TICKET_STATUS } from "./types.js";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * 1:1 문의.
 *
 * 설계에서 가장 중요한 것: **기본이 비공개**다.
 * 게시판은 기본이 공개이고 비밀글이 예외다. 문의는 반대여야 한다 —
 * 주문번호·연락처·환불 사유가 실수로 공개되는 경로를 만들지 않기 위해서다.
 * 그래서 "공개 문의" 옵션 자체를 두지 않았다. 필요하면 게시판을 쓰면 된다.
 */

/** 비회원 문의 조회용 비밀번호 — 게시판 비회원 글과 같은 방식 */
async function hashGuestPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyGuestPassword(stored: string, password: string): Promise<boolean> {
  const [algo, saltHex, keyHex] = String(stored ?? "").split("$");
  if (algo !== "scrypt" || !saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(keyHex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 문의 번호 — 시퀀스로 만든다. count(*)+1 은 동시 접수에서 중복이 난다 */
async function nextTicketNo(db: Db): Promise<string> {
  const { rows } = await db.execute(sql`SELECT nextval('help_ticket_no_seq') AS n`);
  const n = Number(rows[0]?.n ?? 0);
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  return `Q${ym}-${String(n).padStart(5, "0")}`;
}

export interface CreateTicketInput {
  category?: string;
  title?: string;
  content?: string;
  attachments?: string[];
  /** 비회원 문의 */
  guestName?: string;
  guestEmail?: string;
  guestPassword?: string;
}

export async function createTicket(
  db: Db,
  params: {
    input: CreateTicketInput;
    settings: HelpSettings;
    user: { id: string; displayName?: string; email?: string } | null;
  },
): Promise<{ id: string; ticketNo: string }> {
  const { input, settings, user } = params;

  const title = String(input?.title ?? "").trim();
  const content = String(input?.content ?? "").trim();
  if (!title) throw new HelpError(400, "문의 제목을 입력해주세요.");
  if (title.length > 300) throw new HelpError(400, "제목이 너무 깁니다. (300자 이내)");
  if (content.length < 5) throw new HelpError(400, "문의 내용을 5자 이상 입력해주세요.");
  if (content.length > 10000) throw new HelpError(400, "문의가 너무 깁니다. (10000자 이내)");

  const category = String(input?.category ?? settings.categories[0] ?? "일반");
  if (!settings.categories.includes(category)) {
    throw new HelpError(400, "문의 분류가 올바르지 않습니다.");
  }

  const attachments = normalizeAttachments(input?.attachments);

  let authorName: string;
  let authorEmail: string | null;
  let guestHash: string | null = null;

  if (user) {
    authorName = String(user.displayName ?? "회원").slice(0, 100);
    authorEmail = user.email ?? null;
  } else {
    if (!settings.allowGuest) throw new HelpError(401, "로그인이 필요합니다.");
    authorName = String(input?.guestName ?? "").trim().slice(0, 100);
    if (!authorName) throw new HelpError(400, "이름을 입력해주세요.");
    authorEmail = String(input?.guestEmail ?? "").trim().toLowerCase() || null;
    if (!authorEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
      // 비회원은 답변을 확인할 방법이 메일뿐이다 — 주소가 없으면 받을 수 없다
      throw new HelpError(400, "답변을 받을 이메일 주소를 입력해주세요.");
    }
    const pw = String(input?.guestPassword ?? "");
    if (pw.length < 4) throw new HelpError(400, "조회용 비밀번호를 4자 이상 입력해주세요.");
    guestHash = await hashGuestPassword(pw);
  }

  const id = uuidv7();
  const ticketNo = await nextTicketNo(db);

  await db.execute(sql`
    INSERT INTO help_tickets
      (id, ticket_no, user_id, author_name, author_email, category, title, content,
       attachments, guest_password_hash)
    VALUES
      (${id}, ${ticketNo}, ${user ? sql`${user.id}::uuid` : sql`NULL`}, ${authorName},
       ${authorEmail}, ${category}, ${title}, ${content},
       ${JSON.stringify(attachments)}::jsonb, ${guestHash})
  `);

  return { id, ticketNo };
}

/** 내 문의 목록 — 남의 것은 보이지 않는다 */
export async function listMyTickets(
  db: Db,
  params: { userId: string; page: number; pageSize: number; status?: string },
) {
  const size = Math.min(50, Math.max(5, params.pageSize));
  const page = Math.max(1, params.page);
  const status = params.status && TICKET_STATUS.includes(params.status as never)
    ? params.status
    : null;

  const filter = status
    ? sql`user_id = ${params.userId}::uuid AND status = ${status}`
    : sql`user_id = ${params.userId}::uuid`;

  const { rows } = await db.execute(sql`
    SELECT id, ticket_no, category, title, status, created_at, answered_at,
           (SELECT count(*) FROM help_replies r WHERE r.ticket_id = help_tickets.id) AS reply_count
    FROM help_tickets WHERE ${filter}
    ORDER BY created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n FROM help_tickets WHERE ${filter}
  `);
  return { items: rows, total: Number(cnt[0]?.n ?? 0), page, pageSize: size };
}

/**
 * 문의 상세 + 대화.
 *
 * 열람 권한은 세 가지 중 하나여야 한다:
 *  - 작성자 본인 (회원)
 *  - 운영자
 *  - 비회원이 문의 번호 + 조회 비밀번호를 맞춘 경우
 *
 * 하나도 아니면 **404 를 준다.** 403 을 주면 "그 번호의 문의가 존재한다"는
 * 사실이 새어 나가고, 문의 번호는 순차적이라 열거할 수 있다.
 */
export async function getTicket(
  db: Db,
  params: {
    id?: string;
    ticketNo?: string;
    viewer: { id: string; role: string } | null;
    guestPassword?: string;
  },
) {
  const where = params.id
    ? sql`id = ${params.id}::uuid`
    : sql`ticket_no = ${String(params.ticketNo ?? "")}`;

  const { rows } = await db.execute(sql`
    SELECT id, ticket_no, user_id, author_name, author_email, category, title, content,
           status, attachments, guest_password_hash, assignee_id, created_at, answered_at
    FROM help_tickets WHERE ${where} LIMIT 1
  `);
  const t = rows[0];
  if (!t) throw new HelpError(404, "문의를 찾을 수 없습니다.");

  const isManager = params.viewer?.role === "admin" || params.viewer?.role === "manager";
  const isOwner = Boolean(params.viewer && String(t.user_id) === params.viewer.id);
  let guestOk = false;

  if (!isManager && !isOwner && t.guest_password_hash) {
    guestOk = await verifyGuestPassword(
      String(t.guest_password_hash),
      String(params.guestPassword ?? ""),
    );
  }

  if (!isManager && !isOwner && !guestOk) {
    // 존재 여부를 숨긴다
    throw new HelpError(404, "문의를 찾을 수 없습니다.");
  }

  const { rows: replies } = await db.execute(sql`
    SELECT id, author_name, is_staff, content, attachments, created_at
    FROM help_replies WHERE ticket_id = ${String(t.id)}::uuid ORDER BY created_at
  `);

  return {
    ticket: {
      ...t,
      // 해시는 절대 응답에 넣지 않는다
      guest_password_hash: undefined,
      // 비회원 문의의 메일 주소는 운영자에게만
      author_email: isManager ? t.author_email : undefined,
      mine: isOwner,
    },
    replies,
    canReply: isManager || isOwner || guestOk,
  };
}

/**
 * 답변·추가 문의 등록.
 *
 * 운영자가 쓰면 상태가 answered 로 바뀌고, 작성자가 쓰면 open 으로 되돌아간다 —
 * "답변했는데 또 물어봤다"가 목록에서 보여야 놓치지 않는다.
 */
export async function addReply(
  db: Db,
  params: {
    ticketId: string;
    content: string;
    attachments?: string[];
    author: { id: string; displayName?: string; role: string } | null;
    /** 비회원이 조회 비밀번호로 인증한 경우 */
    guestName?: string;
  },
): Promise<{ id: string; status: string }> {
  const content = String(params.content ?? "").trim();
  if (content.length < 2) throw new HelpError(400, "내용을 입력해주세요.");
  if (content.length > 10000) throw new HelpError(400, "내용이 너무 깁니다.");

  const isStaff = params.author?.role === "admin" || params.author?.role === "manager";
  const attachments = normalizeAttachments(params.attachments);
  const id = uuidv7();
  const nextStatus = isStaff ? "answered" : "open";

  await db.transaction(async (tx) => {
    const { rows } = await tx.execute(sql`
      SELECT id, status FROM help_tickets WHERE id = ${params.ticketId}::uuid LIMIT 1
    `);
    if (!rows[0]) throw new HelpError(404, "문의를 찾을 수 없습니다.");
    if (rows[0].status === "closed") {
      throw new HelpError(409, "종료된 문의에는 답변할 수 없습니다.");
    }

    await tx.execute(sql`
      INSERT INTO help_replies (id, ticket_id, author_id, author_name, is_staff, content, attachments)
      VALUES (${id}, ${params.ticketId}::uuid,
              ${params.author ? sql`${params.author.id}::uuid` : sql`NULL`},
              ${String(params.author?.displayName ?? params.guestName ?? "작성자").slice(0, 100)},
              ${isStaff}, ${content}, ${JSON.stringify(attachments)}::jsonb)
    `);

    await tx.execute(sql`
      UPDATE help_tickets SET
        status = ${nextStatus},
        answered_at = ${isStaff ? sql`now()` : sql`answered_at`},
        updated_at = now()
      WHERE id = ${params.ticketId}::uuid
    `);
  });

  return { id, status: nextStatus };
}

/** 관리자: 문의 목록 (전체) */
export async function listAllTickets(
  db: Db,
  params: { page: number; pageSize: number; status?: string; q?: string; category?: string },
) {
  const size = Math.min(100, Math.max(5, params.pageSize));
  const page = Math.max(1, params.page);
  const status = params.status && TICKET_STATUS.includes(params.status as never) ? params.status : "";
  const q = String(params.q ?? "").trim();
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const category = String(params.category ?? "");

  const filter = sql`
    (${status} = '' OR status = ${status})
    AND (${category} = '' OR category = ${category})
    AND (${q} = '' OR title ILIKE ${like} OR content ILIKE ${like} OR ticket_no ILIKE ${like})
  `;

  const { rows } = await db.execute(sql`
    SELECT t.id, t.ticket_no, t.author_name, t.author_email, t.category, t.title,
           t.status, t.created_at, t.answered_at, u.display_name AS assignee_name,
           (SELECT count(*) FROM help_replies r WHERE r.ticket_id = t.id) AS reply_count
    FROM help_tickets t
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE ${filter}
    ORDER BY (t.status = 'open') DESC, t.created_at DESC
    LIMIT ${size} OFFSET ${(page - 1) * size}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n,
           count(*) FILTER (WHERE status = 'open') AS open_count
    FROM help_tickets WHERE ${filter}
  `);
  return {
    items: rows,
    total: Number(cnt[0]?.n ?? 0),
    openCount: Number(cnt[0]?.open_count ?? 0),
    page,
    pageSize: size,
  };
}

/** 관리자: 상태 변경 · 담당자 지정 */
export async function updateTicket(
  db: Db,
  params: { id: string; status?: string; assigneeId?: string | null },
): Promise<void> {
  const sets = [];
  if (params.status !== undefined) {
    if (!TICKET_STATUS.includes(params.status as never)) {
      throw new HelpError(400, "상태가 올바르지 않습니다.");
    }
    sets.push(sql`status = ${params.status}`);
  }
  if (params.assigneeId !== undefined) {
    sets.push(
      params.assigneeId
        ? sql`assignee_id = ${params.assigneeId}::uuid`
        : sql`assignee_id = NULL`,
    );
  }
  if (!sets.length) return;

  const { rows } = await db.execute(sql`
    UPDATE help_tickets SET ${sql.join(sets, sql`, `)}, updated_at = now()
    WHERE id = ${params.id}::uuid RETURNING id
  `);
  if (!rows.length) throw new HelpError(404, "문의를 찾을 수 없습니다.");
}

/**
 * 첨부 URL 정규화.
 * 상대 경로나 http(s) 만 허용한다 — javascript: 가 img/a 에 들어가는 것을 막는다.
 */
function normalizeAttachments(input: unknown): string[] {
  return (Array.isArray(input) ? input : [])
    .map((u) => String(u).trim())
    .filter((u) => /^(\/|https?:\/\/)/.test(u) && u.length <= 1000)
    .slice(0, 5);
}
