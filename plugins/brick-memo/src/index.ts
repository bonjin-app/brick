import { definePlugin } from "@brick/plugin-sdk";
import type { PluginDb } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { MEMO_CSS, memoScript, renderMemoShell, resolveMemoView } from "./views.js";
import { bindI18n } from "./i18n.js";

class MemoError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 포인트 서비스의 필요한 부분만 좁게 선언한다.
 * brick-point에 대한 컴파일 의존을 만들지 않으므로, 포인트 없이도 빌드·동작한다.
 */
interface PointsPort {
  balance(userId: string, tx?: PluginDb): Promise<number>;
  spend(
    params: { userId: string; amount: number; reason: string; refType?: string; refId?: string },
    tx?: PluginDb,
  ): Promise<boolean>;
}

interface MemoSettings {
  /** 쪽지 발송 시 차감할 포인트 (0이면 무료) */
  sendPoint: number;
  /** 같은 사람에게 다시 보낼 수 있게 되기까지의 초 (도배 방지) */
  sendInterval: number;
  /** 하루 발송 한도 (0이면 무제한) */
  dailyLimit: number;
  /** 쪽지 최대 길이 */
  maxLength: number;
}

const DEFAULT_SETTINGS: MemoSettings = {
  sendPoint: 0,
  sendInterval: 10,
  dailyLimit: 50,
  maxLength: 2000,
};

const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/**
 * brick-memo — 회원 간 쪽지.
 *
 * 포인트가 설치되어 있으면 발송 시 차감할 수 있다(그누보드와 같은 정책).
 * 포인트가 없으면 무료로 동작한다 — 서비스 조회가 null을 허용한다.
 */
export default definePlugin(async (ctx) => {
  bindI18n(ctx);
  const db = ctx.db as PluginDb;

  const settings = async (): Promise<MemoSettings> => ({
    ...DEFAULT_SETTINGS,
    ...((await ctx.settings.get<Partial<MemoSettings>>("settings")) ?? {}),
  });

  /** 사용 시점에 조회 — 활성화 순서에 의존하지 않는다 */
  const pointsPort = (): PointsPort | null => ctx.useService<PointsPort>("points");

  const requireUser = (req: {
    user: { id: string; role: string; displayName?: string } | null;
  }) => {
    if (!req.user) throw new MemoError(401, "로그인이 필요합니다.");
    return req.user;
  };

  // ════════════════════════════════════════════════════
  //  받은 / 보낸 쪽지함
  // ════════════════════════════════════════════════════

  ctx.registerRoute("GET", "/inbox", async (req) => {
    const user = requireUser(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = 20;
    const [items, counted, unread] = await Promise.all([
      db.execute(sql`
        SELECT m.id, m.sender_id, m.sender_name, m.is_read, m.read_at, m.created_at,
               left(m.content, 60) AS preview
        FROM memo_messages m
        WHERE m.receiver_id = ${user.id}::uuid AND m.receiver_deleted_at IS NULL
        ORDER BY m.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}
      `).then((r) => r.rows),
      db.execute(sql`
        SELECT count(*) AS n FROM memo_messages
        WHERE receiver_id = ${user.id}::uuid AND receiver_deleted_at IS NULL
      `).then((r) => Number(r.rows[0]?.n ?? 0)),
      db.execute(sql`
        SELECT count(*) AS n FROM memo_messages
        WHERE receiver_id = ${user.id}::uuid AND receiver_deleted_at IS NULL AND is_read = false
      `).then((r) => Number(r.rows[0]?.n ?? 0)),
    ]);
    return { items, total: counted, unread, page, pageSize: size };
  });

  ctx.registerRoute("GET", "/sent", async (req) => {
    const user = requireUser(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const size = 20;
    const [items, counted] = await Promise.all([
      db.execute(sql`
        SELECT m.id, m.receiver_id, u.display_name AS receiver_name,
               m.is_read, m.read_at, m.created_at, left(m.content, 60) AS preview
        FROM memo_messages m LEFT JOIN users u ON u.id = m.receiver_id
        WHERE m.sender_id = ${user.id}::uuid AND m.sender_deleted_at IS NULL
        ORDER BY m.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}
      `).then((r) => r.rows),
      db.execute(sql`
        SELECT count(*) AS n FROM memo_messages
        WHERE sender_id = ${user.id}::uuid AND sender_deleted_at IS NULL
      `).then((r) => Number(r.rows[0]?.n ?? 0)),
    ]);
    return { items, total: counted, page, pageSize: size };
  });

  /** 안읽은 개수 — 헤더 배지가 자주 호출한다 */
  ctx.registerRoute("GET", "/unread-count", async (req) => {
    if (!req.user) return { count: 0 };
    const { rows } = await db.execute(sql`
      SELECT count(*) AS n FROM memo_messages
      WHERE receiver_id = ${req.user.id}::uuid AND receiver_deleted_at IS NULL AND is_read = false
    `);
    return { count: Number(rows[0]?.n ?? 0) };
  });

  /** 쪽지 읽기 — 받은 쪽지면 읽음 처리한다 */
  ctx.registerRoute("GET", "/:id", async (req) => {
    const user = requireUser(req);
    const { rows } = await db.execute(sql`
      SELECT m.id, m.sender_id, m.sender_name, m.receiver_id, m.content,
             m.is_read, m.read_at, m.created_at,
             u.display_name AS receiver_name
      FROM memo_messages m LEFT JOIN users u ON u.id = m.receiver_id
      WHERE m.id = ${req.params.id}::uuid LIMIT 1
    `);
    const memo = rows[0];
    if (!memo) throw new MemoError(404, "쪽지를 찾을 수 없습니다.");

    const isReceiver = String(memo.receiver_id) === user.id;
    const isSender = memo.sender_id ? String(memo.sender_id) === user.id : false;
    // 당사자만 읽을 수 있다. 관리자도 남의 쪽지를 볼 수 없다 (프라이버시)
    if (!isReceiver && !isSender) throw new MemoError(403, "열람 권한이 없습니다.");

    if (isReceiver && !memo.is_read) {
      await db.execute(sql`
        UPDATE memo_messages SET is_read = true, read_at = now() WHERE id = ${req.params.id}::uuid
      `);
      memo.is_read = true;
    }
    return { memo, role: isReceiver ? "receiver" : "sender" };
  });

  // ════════════════════════════════════════════════════
  //  발송
  // ════════════════════════════════════════════════════
  ctx.registerRoute("POST", "/", async (req) => {
    const user = requireUser(req);
    const body = req.body as { receiverEmail?: string; receiverId?: string; content?: string };
    const s = await settings();

    const content = String(body?.content ?? "").trim();
    if (!content) throw new MemoError(400, "내용을 입력해주세요.");
    if (content.length > s.maxLength) {
      throw new MemoError(400, `쪽지는 ${s.maxLength}자까지 보낼 수 있습니다.`);
    }

    // 수신자 확인 — 이메일 또는 id
    const { rows: receivers } = await db.execute(sql`
      SELECT id, display_name, is_active FROM users
      WHERE (${body?.receiverId ?? null}::uuid IS NOT NULL AND id = ${body?.receiverId ?? null}::uuid)
         OR (${body?.receiverEmail ?? ""} <> '' AND email = lower(${body?.receiverEmail ?? ""}))
      LIMIT 1
    `);
    const receiver = receivers[0];
    if (!receiver) throw new MemoError(404, "받는 회원을 찾을 수 없습니다.");
    if (!receiver.is_active) throw new MemoError(400, "정지된 계정에는 쪽지를 보낼 수 없습니다.");
    if (String(receiver.id) === user.id) throw new MemoError(400, "자신에게는 쪽지를 보낼 수 없습니다.");

    // 차단 확인 — 차단당한 쪽에는 "차단됨"을 알리지 않는다(차단 사실 노출 방지).
    // 보낸 것처럼 보이지만 실제로는 저장하지 않는 방식은 거짓 응답이므로 쓰지 않고,
    // 중립적인 메시지로 거절한다.
    const { rows: blocked } = await db.execute(sql`
      SELECT 1 FROM memo_blocks
      WHERE user_id = ${String(receiver.id)}::uuid AND blocked_id = ${user.id}::uuid
    `);
    if (blocked.length) throw new MemoError(403, "이 회원에게는 쪽지를 보낼 수 없습니다.");

    // 도배 방지 — 같은 사람에게 연속 발송 제한
    if (s.sendInterval > 0) {
      const { rows: recent } = await db.execute(sql`
        SELECT 1 FROM memo_messages
        WHERE sender_id = ${user.id}::uuid AND receiver_id = ${String(receiver.id)}::uuid
          AND created_at > now() - (${s.sendInterval} || ' seconds')::interval
        LIMIT 1
      `);
      if (recent.length) {
        throw new MemoError(429, `너무 빠르게 보냈습니다. ${s.sendInterval}초 후 다시 시도해주세요.`);
      }
    }

    // 하루 한도 — 계정 탈취 시 대량 발송을 제한한다
    if (s.dailyLimit > 0) {
      const { rows: today } = await db.execute(sql`
        SELECT count(*) AS n FROM memo_messages
        WHERE sender_id = ${user.id}::uuid AND created_at >= date_trunc('day', now())
      `);
      if (Number(today[0]?.n ?? 0) >= s.dailyLimit) {
        throw new MemoError(429, `하루 발송 한도(${s.dailyLimit}건)를 초과했습니다.`);
      }
    }

    const id = uuidv7();
    const port = pointsPort();

    /**
     * 포인트 차감과 쪽지 저장은 하나의 트랜잭션이어야 한다.
     * 차감만 되고 쪽지가 안 가면 사용자가 손해를 본다.
     */
    await db.transaction(async (tx) => {
      if (s.sendPoint > 0) {
        if (!port) {
          // 정책은 포인트 차감인데 포인트 플러그인이 꺼져 있다 — 조용히 무료로 보내면
          // 정책이 무력화되므로 명확히 실패시킨다.
          throw new MemoError(
            503,
            "쪽지 발송에 포인트가 필요하도록 설정되어 있으나 포인트 기능이 비활성 상태입니다. 관리자에게 문의해주세요.",
          );
        }
        const ok = await port.spend(
          {
            userId: user.id,
            amount: s.sendPoint,
            reason: "쪽지 발송",
            refType: "memo.send",
            refId: id,
          },
          tx,
        );
        if (!ok) {
          throw new MemoError(400, `포인트가 부족합니다. (필요: ${s.sendPoint.toLocaleString("ko-KR")})`);
        }
      }

      await tx.execute(sql`
        INSERT INTO memo_messages (id, sender_id, sender_name, receiver_id, content)
        VALUES (${id}, ${user.id}::uuid, ${user.displayName ?? "회원"}, ${String(receiver.id)}::uuid, ${content})
      `);
    });

    await ctx.hooks.doAction("memo.sent", {
      memoId: id,
      senderId: user.id,
      receiverId: String(receiver.id),
    });

    return { id, receiverName: String(receiver.display_name), pointUsed: s.sendPoint };
  });

  /**
   * 삭제 — 내 쪽에서만 지운다.
   * 받는 사람이 지워도 보낸 사람의 보낸함에는 남는다(그누보드와 같은 동작).
   */
  ctx.registerRoute("DELETE", "/:id", async (req) => {
    const user = requireUser(req);
    const { rows } = await db.execute(sql`
      UPDATE memo_messages SET
        receiver_deleted_at = CASE WHEN receiver_id = ${user.id}::uuid THEN now() ELSE receiver_deleted_at END,
        sender_deleted_at   = CASE WHEN sender_id   = ${user.id}::uuid THEN now() ELSE sender_deleted_at END
      WHERE id = ${req.params.id}::uuid
        AND (receiver_id = ${user.id}::uuid OR sender_id = ${user.id}::uuid)
      RETURNING sender_deleted_at, receiver_deleted_at
    `);
    if (!rows.length) throw new MemoError(404, "쪽지를 찾을 수 없습니다.");

    // 양쪽 다 지웠으면 실제로 제거한다 (보관할 이유가 없다)
    if (rows[0].sender_deleted_at && rows[0].receiver_deleted_at) {
      await db.execute(sql`DELETE FROM memo_messages WHERE id = ${req.params.id}::uuid`);
    }
    return { ok: true };
  });

  /** 받은함 전체 읽음 처리 */
  ctx.registerRoute("POST", "/read-all", async (req) => {
    const user = requireUser(req);
    const { rows } = await db.execute(sql`
      UPDATE memo_messages SET is_read = true, read_at = now()
      WHERE receiver_id = ${user.id}::uuid AND receiver_deleted_at IS NULL AND is_read = false
      RETURNING id
    `);
    return { ok: true, updated: rows.length };
  });

  // ════════════════════════════════════════════════════
  //  차단
  // ════════════════════════════════════════════════════
  ctx.registerRoute("GET", "/blocks/list", async (req) => {
    const user = requireUser(req);
    const { rows } = await db.execute(sql`
      SELECT b.blocked_id, u.display_name, u.email, b.created_at
      FROM memo_blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.user_id = ${user.id}::uuid ORDER BY b.created_at DESC
    `);
    return { items: rows };
  });

  ctx.registerRoute("POST", "/blocks/:userId", async (req) => {
    const user = requireUser(req);
    if (req.params.userId === user.id) throw new MemoError(400, "자신을 차단할 수 없습니다.");
    const { rows } = await db.execute(sql`
      SELECT 1 FROM users WHERE id = ${req.params.userId}::uuid
    `);
    if (!rows.length) throw new MemoError(404, "회원을 찾을 수 없습니다.");
    await db.execute(sql`
      INSERT INTO memo_blocks (user_id, blocked_id) VALUES (${user.id}::uuid, ${req.params.userId}::uuid)
      ON CONFLICT DO NOTHING
    `);
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/blocks/:userId", async (req) => {
    const user = requireUser(req);
    await db.execute(sql`
      DELETE FROM memo_blocks WHERE user_id = ${user.id}::uuid AND blocked_id = ${req.params.userId}::uuid
    `);
    return { ok: true };
  });

  /** 수신자 찾기 — 이름/이메일로 검색 (자동완성용) */
  ctx.registerRoute("GET", "/recipients/search", async (req) => {
    const user = requireUser(req);
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return { items: [] };
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const { rows } = await db.execute(sql`
      SELECT id, display_name, email FROM users
      WHERE is_active = true AND id <> ${user.id}::uuid
        AND (display_name ILIKE ${like} OR email ILIKE ${like})
      ORDER BY display_name LIMIT 10
    `);
    // 이메일 전체를 노출하면 회원 목록이 새어 나간다 — 일부만 가려서 보여준다
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        display_name: String(r.display_name),
        email_masked: maskEmail(String(r.email)),
      })),
    };
  });

  /** 발송 비용 안내 — 쓰기 화면이 미리 보여준다 */
  ctx.registerRoute("GET", "/cost", async (req) => {
    requireUser(req);
    const s = await settings();
    return {
      sendPoint: s.sendPoint,
      maxLength: s.maxLength,
      // 포인트가 꺼져 있는데 비용 정책이 있으면 발송이 막힌다 — 미리 알려준다
      pointsAvailable: Boolean(pointsPort()),
    };
  });

  // ════════════════════════════════════════════════════
  //  관리자
  // ════════════════════════════════════════════════════
  const requireAdmin = (req: { user: { role: string } | null }) => {
    if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      throw new MemoError(403, "관리자 권한이 필요합니다.");
    }
  };

  /**
   * 관리자 목록 — **내용은 제외한다.**
   * 스팸 대응을 위해 누가 누구에게 얼마나 보냈는지는 봐야 하지만,
   * 회원 간 사적 대화의 내용을 관리자가 읽을 이유는 없다.
   */
  ctx.registerRoute("GET", "/admin/messages", async (req) => {
    requireAdmin(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const { rows } = await db.execute(sql`
      SELECT m.id, m.sender_name, u.display_name AS receiver_name,
             length(m.content) AS length, m.is_read, m.created_at
      FROM memo_messages m LEFT JOIN users u ON u.id = m.receiver_id
      ORDER BY m.created_at DESC LIMIT 30 OFFSET ${(page - 1) * 30}
    `);
    const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM memo_messages`);
    return { items: rows, total: Number(cnt[0]?.n ?? 0), page, pageSize: 30 };
  });

  ctx.registerRoute("DELETE", "/admin/messages/:id", async (req) => {
    requireAdmin(req);
    await db.execute(sql`DELETE FROM memo_messages WHERE id = ${req.params.id}::uuid`);
    return { ok: true };
  });

  ctx.registerRoute("GET", "/admin/settings-list", async (req) => {
    requireAdmin(req);
    return { items: [{ id: "settings", ...(await settings()) }], total: 1 };
  });

  ctx.registerRoute("PUT", "/admin/settings-list/:id", async (req) => {
    requireAdmin(req);
    const b = req.body as Partial<MemoSettings>;
    const num = (v: unknown, fallback: number, min: number, max: number) => {
      const n = Math.floor(Number(v ?? fallback));
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new MemoError(400, `값이 허용 범위를 벗어났습니다 (${min}~${max}).`);
      }
      return n;
    };
    const current = await settings();
    const next: MemoSettings = {
      sendPoint: num(b.sendPoint, current.sendPoint, 0, 1_000_000),
      sendInterval: num(b.sendInterval, current.sendInterval, 0, 3600),
      dailyLimit: num(b.dailyLimit, current.dailyLimit, 0, 10_000),
      maxLength: num(b.maxLength, current.maxLength, 10, 100_000),
    };
    await ctx.settings.set("settings", next);
    return { ok: true };
  });

  /**
   * 회원 탈퇴 시 쪽지 삭제.
   *
   * 통째로 지운다. 사적인 대화이고 보존 의무가 없다.
   * 상대방 화면에서도 사라지는데, 그게 맞다 — 쪽지는 "관리자도 볼 수 없다"는
   * 전제로 만들어졌고(ADR-30), 탈퇴한 사람의 대화를 상대방에게만 남길 근거가 없다.
   */
  ctx.registerDataEraser({
    label: "쪽지",
    order: 10,
    async erase({ tx, userId }) {
      const { rows } = await tx.execute(sql`
        DELETE FROM memo_messages
        WHERE sender_id = ${userId}::uuid OR receiver_id = ${userId}::uuid
        RETURNING id
      `);
      await tx.execute(sql`
        DELETE FROM memo_blocks WHERE user_id = ${userId}::uuid OR blocked_id = ${userId}::uuid
      `);
      return rows.length ? [`쪽지 ${rows.length}건 삭제`] : [];
    },
    async describe({ userId }) {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM memo_messages
        WHERE sender_id = ${userId}::uuid OR receiver_id = ${userId}::uuid
      `);
      const n = Number(rows[0]?.n ?? 0);
      return n ? [{ label: "쪽지", detail: `${n}건이 삭제됩니다. 상대방 화면에서도 사라집니다.` }] : [];
    },
  });

  ctx.registerAdminResource({
    name: "messages",
    title: "쪽지",
    itemLabel: "쪽지",
    basePath: "/admin/messages",
    order: 30,
    description:
      "스팸 대응을 위한 발송 이력입니다. **내용은 표시하지 않습니다** — " +
      "회원 간 사적 대화이므로 관리자가 읽지 않습니다. 필요하면 삭제할 수 있습니다.",
    can: { create: false, update: false },
    fields: [
      { name: "created_at", label: "발송일시", type: "date", readOnly: true, inList: true },
      { name: "sender_name", label: "보낸 사람", type: "text", readOnly: true, inList: true },
      { name: "receiver_name", label: "받는 사람", type: "text", readOnly: true, inList: true },
      { name: "length", label: "글자 수", type: "number", readOnly: true, inList: true },
      { name: "is_read", label: "읽음", type: "boolean", readOnly: true, inList: true },
    ],
  });

  ctx.registerAdminResource({
    name: "settings",
    title: "쪽지 설정",
    itemLabel: "설정",
    basePath: "/admin/settings-list",
    order: 31,
    description: "발송 비용과 도배 방지 정책을 정합니다.",
    can: { create: false, delete: false },
    fields: [
      { name: "sendPoint", label: "발송 비용 (포인트)", type: "number", inList: true,
        help: "0이면 무료. 포인트 플러그인이 활성화되어 있어야 차감됩니다." },
      { name: "sendInterval", label: "같은 사람 재발송 간격 (초)", type: "number", inList: true },
      { name: "dailyLimit", label: "하루 발송 한도", type: "number", inList: true, help: "0이면 무제한" },
      { name: "maxLength", label: "최대 글자 수", type: "number" },
    ],
  });

  // ── 블록: 쪽지 화면 ─────────────────────────────────
  /**
   * 페이지 하나(slug "memo")가 받은함·보낸함·읽기·쓰기·차단목록을 처리한다.
   *
   * 본문은 서버 렌더에 담지 않는다 — 쪽지는 사적인 내용이므로
   * HTML에 박아 두면 캐시·프록시·브라우저 이력에 남을 위험이 커진다.
   * 껍데기만 서버가 내고 내용은 인증된 API 요청으로만 가져온다.
   */
  ctx.registerBlock({
    name: "memo",
    displayName: "쪽지함",
    propsSchema: {
      type: "object",
      properties: {},
      description: "페이지 주소를 'memo' 로 만들면 받은함·보낸함·쓰기가 모두 동작합니다",
    },
    render: async (_props, blockCtx) => {
      const { view, memoId } = resolveMemoView(blockCtx.pathTail);
      const path = String(blockCtx.path ?? "").replace(/^\/+|\/+$/g, "");
      const tail = String(blockCtx.pathTail ?? "").replace(/^\/+|\/+$/g, "");
      const base = tail && path.endsWith(tail)
        ? `/${path.slice(0, path.length - tail.length).replace(/\/+$/g, "")}`
        : `/${path || "memo"}`;
      return `${renderMemoShell(view, memoId, Boolean(blockCtx.user), base)}${memoScript()}${MEMO_CSS}`;
    },
  });

  // ── 블록: 안읽은 쪽지 배지 ──────────────────────────
  ctx.registerBlock({
    name: "unread-badge",
    displayName: "쪽지 알림",
    render: async (_props, blockCtx) => {
      if (!blockCtx.user) return "";
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM memo_messages
        WHERE receiver_id = ${blockCtx.user.id}::uuid AND receiver_deleted_at IS NULL AND is_read = false
      `);
      const count = Number(rows[0]?.n ?? 0);
      return `<a class="brick-memo-badge" href="/memo">쪽지${
        count > 0 ? ` <span class="brick-memo-count">${count}</span>` : ""
      }</a>${BADGE_CSS}`;
    },
  });

  return {};
});

/** 이메일 일부를 가린다 — 검색 결과로 회원 이메일이 수집되지 않게 */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

const BADGE_CSS = `
<style>
.brick-memo-badge{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:inherit;font-size:14px}
.brick-memo-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;background:var(--color-primary,#d0402c);color:var(--color-on-primary, #ffffff);border-radius:9px;font-size:11.5px;font-weight:700}
</style>`;

export { escapeHtml };
