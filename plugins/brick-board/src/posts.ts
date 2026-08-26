import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BoardRow, Db, SessionUser } from "./types.js";
import { BoardError, hasRole } from "./types.js";
import { hashGuestPassword } from "./guest.js";
import { sanitizeHtml } from "./sanitize.js";

export interface WritePostInput {
  title: string;
  content: string;
  category?: string | null;
  isNotice?: boolean;
  isSecret?: boolean;
  /** 답변형: 부모 글 id */
  replyTo?: string | null;
  /** 비회원 글쓰기 */
  guestName?: string;
  guestPassword?: string;
}

/**
 * 글 작성 (원글 또는 답변).
 *
 * 답변형 정렬은 materialized path로 한다:
 *   원글      thread_path = ''
 *   1단 답변  '0001', '0002', ...
 *   2단 답변  '0001.0001'
 * 목록 정렬은 (thread_created_at DESC, thread_path ASC) → 스레드가 통째로 묶인다.
 */
export async function createPost(
  db: Db,
  params: {
    board: BoardRow;
    input: WritePostInput;
    user: SessionUser | null;
    ip: string | null;
  },
): Promise<{ id: string }> {
  const { board, input, user, ip } = params;

  const title = String(input.title ?? "").trim();
  if (!title) throw new BoardError(400, "제목을 입력해주세요.");
  if (title.length > 500) throw new BoardError(400, "제목이 너무 깁니다. (500자 이내)");

  // 본문은 HTML로 렌더되므로 반드시 걸러낸다 (저장형 XSS 방지).
  // 저장 시점에 정제해 두면 렌더할 때마다 비용을 치르지 않는다.
  const raw = String(input.content ?? "").trim();
  if (!raw) throw new BoardError(400, "내용을 입력해주세요.");
  if (raw.length > 200_000) throw new BoardError(400, "내용이 너무 깁니다.");
  const content = sanitizeHtml(raw);
  if (!content.replace(/<[^>]*>/g, "").trim()) {
    throw new BoardError(400, "내용을 입력해주세요.");
  }

  // 분류가 설정된 게시판이면 목록에 있는 값만 허용한다
  const category = input.category ? String(input.category).trim() : null;
  if (category && board.categories.length && !board.categories.includes(category)) {
    throw new BoardError(400, `허용되지 않는 분류입니다: ${category}`);
  }

  // 공지는 관리자만
  const isNotice = Boolean(input.isNotice) && hasRole(user, "manager");
  const isSecret = Boolean(input.isSecret) && board.allow_secret;

  // 비회원 글은 이름과 비밀번호가 필수 (수정·삭제 확인용)
  let guestName: string | null = null;
  let guestPasswordHash: string | null = null;
  if (!user) {
    guestName = String(input.guestName ?? "").trim();
    const pw = String(input.guestPassword ?? "");
    if (guestName.length < 2 || guestName.length > 20) {
      throw new BoardError(400, "이름을 2~20자로 입력해주세요.");
    }
    if (pw.length < 4) throw new BoardError(400, "비밀번호를 4자 이상 입력해주세요.");
    guestPasswordHash = hashGuestPassword(pw);
  }

  const id = uuidv7();
  const authorName = user ? user.displayName : guestName;

  return db.transaction(async (tx) => {
    let threadId = id;
    let threadCreatedAt: Date | null = null;
    let threadPath = "";
    let depth = 0;

    if (input.replyTo) {
      if (!board.allow_reply) throw new BoardError(400, "이 게시판은 답변을 허용하지 않습니다.");
      const { rows } = await tx.execute(sql`
        SELECT id, thread_id, thread_created_at, thread_path, depth
        FROM board_posts WHERE id = ${input.replyTo}::uuid AND board_id = ${board.id}::uuid LIMIT 1
      `);
      const parent = rows[0];
      if (!parent) throw new BoardError(404, "답변할 원글을 찾을 수 없습니다.");
      if (Number(parent.depth) >= 8) throw new BoardError(400, "더 이상 답변을 달 수 없습니다.");

      threadId = String(parent.thread_id ?? parent.id);
      threadCreatedAt = new Date(String(parent.thread_created_at));
      depth = Number(parent.depth) + 1;

      // 같은 부모 아래 형제 수를 세어 다음 순번을 만든다.
      // 스레드 행을 잠가 동시 답변이 같은 path를 갖지 않게 한다.
      await tx.execute(sql`SELECT id FROM board_posts WHERE id = ${threadId}::uuid FOR UPDATE`);
      const parentPath = String(parent.thread_path ?? "");
      const prefix = parentPath ? `${parentPath}.` : "";
      const { rows: siblings } = await tx.execute(sql`
        SELECT count(*) AS n FROM board_posts
        WHERE thread_id = ${threadId}::uuid AND depth = ${depth}
          AND thread_path LIKE ${`${prefix}%`}
          AND thread_path NOT LIKE ${`${prefix}%.%`}
      `);
      const next = Number(siblings[0]?.n ?? 0) + 1;
      threadPath = `${prefix}${String(next).padStart(4, "0")}`;
    }

    await tx.execute(sql`
      INSERT INTO board_posts (
        id, board_id, author_id, author_name, title, content, category,
        is_notice, is_secret, thread_id, thread_created_at, thread_path, depth,
        guest_name, guest_password, author_ip
      ) VALUES (
        ${id}, ${board.id}::uuid, ${user?.id ?? null}::uuid, ${authorName}, ${title}, ${content}, ${category},
        ${isNotice}, ${isSecret}, ${threadId}::uuid,
        ${threadCreatedAt ? threadCreatedAt.toISOString() : null}::timestamptz,
        ${threadPath}, ${depth},
        ${guestName}, ${guestPasswordHash}, ${ip}
      )
    `);
    // 원글이면 thread_created_at을 자기 created_at으로 채운다
    if (!input.replyTo) {
      await tx.execute(sql`
        UPDATE board_posts SET thread_created_at = created_at WHERE id = ${id}
      `);
    }
    return { id };
  });
}

/** 글 목록 (스레드 정렬 + 공지 상단 고정) */
export async function listPosts(
  db: Db,
  params: { board: BoardRow; page: number; category?: string; q?: string; searchIn?: string },
) {
  const { board } = params;
  const size = board.page_size;
  const page = Math.max(1, params.page);
  const category = params.category?.trim() || "";
  const q = (params.q ?? "").trim();
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  // 검색 대상: title | content | author | all
  const searchIn = params.searchIn ?? "all";

  const search = !q
    ? sql`TRUE`
    : searchIn === "title"
      ? sql`p.title ILIKE ${like}`
      : searchIn === "content"
        ? sql`p.content ILIKE ${like}`
        : searchIn === "author"
          ? sql`coalesce(p.author_name, '') ILIKE ${like}`
          : sql`(p.title ILIKE ${like} OR p.content ILIKE ${like} OR coalesce(p.author_name,'') ILIKE ${like})`;

  const filter = sql`
    p.board_id = ${board.id}::uuid
    AND (${category} = '' OR p.category = ${category})
    AND ${search}
  `;

  // 공지는 항상 위. 검색 중에는 공지를 섞지 않는다(그누보드와 같은 동작)
  const { rows: notices } = q
    ? { rows: [] }
    : await db.execute(sql`
        SELECT p.id, p.title, p.category, p.author_name, p.created_at, p.view_count,
               p.comment_count, p.file_count, p.up_count, p.is_secret, p.depth, 0 AS is_reply
        FROM board_posts p
        WHERE p.board_id = ${board.id}::uuid AND p.is_notice = true
        ORDER BY p.created_at DESC LIMIT 5
      `);

  const { rows: items } = await db.execute(sql`
    SELECT p.id, p.title, p.category, p.author_name, p.created_at, p.view_count,
           p.comment_count, p.file_count, p.up_count, p.is_secret, p.depth,
           CASE WHEN p.depth > 0 THEN 1 ELSE 0 END AS is_reply
    FROM board_posts p
    WHERE ${filter} AND p.is_notice = false
    ORDER BY p.thread_created_at DESC, p.thread_path ASC
    LIMIT ${size} OFFSET ${(page - 1) * size}
  `);

  const { rows: counted } = await db.execute(sql`
    SELECT count(*) AS n FROM board_posts p WHERE ${filter} AND p.is_notice = false
  `);
  const total = Number(counted[0]?.n ?? 0);

  return {
    notices,
    items,
    total,
    page,
    pageSize: size,
    totalPages: Math.max(1, Math.ceil(total / size)),
    categories: board.categories,
    query: q,
    searchIn,
    category,
  };
}
