/**
 * 재입고 알림.
 *
 * 품절 상품을 찾아온 손님에게 지금은 할 수 있는 것이 없다. 그 손님은 다시
 * 오지 않고, **팔 수 있었던 것을 못 판다.**
 *
 * 설계에서 조심한 것은 migrations/0011_restock.sql 주석에 적어 두었다 —
 * 스팸 도구가 되지 않게 하는 것과, 이 메일이 광고가 아니게 유지하는 것.
 */
import { sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { isUniqueViolation } from "@brick/plugin-sdk";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

/**
 * 한 번에 보내는 통수.
 *
 * 인기 상품 재입고면 신청자가 수천 명이다. 한꺼번에 보내면 SMTP 가 막고,
 * 요청 안에서 다 보내면 타임아웃이 난다.
 */
const BATCH = 20;
const BATCH_DELAY_MS = 1000;

export const RESTOCK_QUEUE_JOB = "shop.restock.notify";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`restock:${ip}`).digest("hex").slice(0, 64);
}

/**
 * 신청.
 *
 * **품절이 아닌 상품에는 신청을 받지 않는다.** 받아두면 재입고 이벤트가
 * 발생하지 않아 영원히 대기 상태로 남고, 손님은 기다리다 잊는다.
 */
export async function requestRestockAlert(
  db: Db,
  params: {
    productSlug: string;
    optionId?: string | null;
    email?: string;
    user: { id: string; email?: string } | null;
    ip?: string;
  },
): Promise<{ id: string; email: string; productName: string; optionName: string | null }> {
  const { rows } = await db.execute(sql`
    SELECT id, name, status, stock FROM shop_products
    WHERE slug = ${params.productSlug} AND status IN ('selling', 'soldout') LIMIT 1
  `);
  const product = rows[0];
  if (!product) throw new ShopError(404, "상품을 찾을 수 없습니다.");

  const productId = String(product.id);
  let optionId: string | null = null;
  let optionName: string | null = null;
  let soldOut: boolean;

  if (params.optionId) {
    const { rows: opts } = await db.execute(sql`
      SELECT id, name, stock, is_active FROM shop_product_options
      WHERE id = ${params.optionId}::uuid AND product_id = ${productId}::uuid LIMIT 1
    `);
    const opt = opts[0];
    if (!opt) throw new ShopError(404, "옵션을 찾을 수 없습니다.");
    if (opt.is_active === false) throw new ShopError(400, "판매하지 않는 옵션입니다.");
    optionId = String(opt.id);
    optionName = String(opt.name);
    // 옵션 재고가 지정되지 않았으면(NULL) 무한 재고이므로 품절이 아니다
    soldOut = opt.stock !== null && Number(opt.stock) <= 0;
  } else {
    const { rows: anyOpt } = await db.execute(sql`
      SELECT count(*) AS n FROM shop_product_options
      WHERE product_id = ${productId}::uuid AND is_active = true
    `);
    // 옵션이 있는 상품은 옵션을 골라야 한다 — "M 사이즈만 품절"인 경우가
    // 대부분이고, 상품 단위로 받으면 L 이 들어왔을 때 잘못된 알림이 간다
    if (Number(anyOpt[0]?.n ?? 0) > 0) {
      throw new ShopError(400, "옵션을 선택해주세요.");
    }
    soldOut = String(product.status) === "soldout"
      || (product.stock !== null && Number(product.stock) <= 0);
  }

  if (!soldOut) {
    throw new ShopError(400, "품절된 상품에만 재입고 알림을 신청할 수 있습니다.");
  }

  const email = String(params.email ?? params.user?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ShopError(400, "알림 받을 이메일을 입력해주세요.");

  const id = uuidv7();
  const token = randomBytes(32).toString("base64url");

  try {
    await db.execute(sql`
      INSERT INTO shop_restock_alerts
        (id, product_id, option_id, user_id, email, token, status, ip_hash)
      VALUES
        (${id}, ${productId}::uuid, ${optionId}::uuid, ${params.user?.id ?? null}::uuid,
         ${email}, ${token}, 'pending', ${hashIp(params.ip)})
    `);
  } catch (err) {
    if (isUniqueViolation(err, "shop_restock_once_idx")) {
      throw new ShopError(409, "이미 재입고 알림을 신청하셨습니다.");
    }
    throw err;
  }

  return { id, email, productName: String(product.name), optionName };
}

/** 내 신청 목록 (회원) */
export async function listMyRestockAlerts(db: Db, userId: string) {
  const { rows } = await db.execute(sql`
    SELECT a.id, a.email, a.status, a.created_at, a.notified_at, a.token,
           p.slug, p.name AS product_name, p.status AS product_status,
           o.name AS option_name
    FROM shop_restock_alerts a
    JOIN shop_products p ON p.id = a.product_id
    LEFT JOIN shop_product_options o ON o.id = a.option_id
    WHERE a.user_id = ${userId}::uuid AND a.status <> 'cancelled'
    ORDER BY a.created_at DESC
    LIMIT 100
  `);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      productSlug: String(r.slug),
      productName: String(r.product_name),
      optionName: r.option_name ? String(r.option_name) : null,
      email: String(r.email),
      status: String(r.status),
      createdAt: r.created_at,
      notifiedAt: r.notified_at,
      cancelPath: `/shop/restock/cancel/${String(r.token)}`,
    })),
  };
}

/**
 * 해지 — 토큰으로만.
 *
 * 로그인 없이 되어야 한다. 비회원도 신청할 수 있고, 잘못 신청된 사람이
 * 로그인해서 해지하라는 것은 해지 경로가 없는 것과 같다.
 */
export async function cancelRestockAlert(db: Db, token: string): Promise<{ ok: true }> {
  const { rows } = await db.execute(sql`
    UPDATE shop_restock_alerts SET status = 'cancelled', cancelled_at = now()
    WHERE token = ${String(token ?? "")} AND status = 'pending'
    RETURNING id
  `);
  // 이미 해지된 것도 성공으로 본다 — 링크를 두 번 눌렀을 때 오류를 보여주면
  // 해지가 안 된 줄 알고 다시 시도한다
  if (!rows.length) {
    const { rows: exists } = await db.execute(sql`
      SELECT 1 FROM shop_restock_alerts WHERE token = ${String(token ?? "")} LIMIT 1
    `);
    if (!exists.length) throw new ShopError(404, "알림 신청을 찾을 수 없습니다.");
  }
  return { ok: true };
}

/**
 * 재입고를 감지해 대기자를 찾는다.
 *
 * 재고 변경 후에 부른다. **품절이 풀렸는가**만 본다 — 재고 숫자가 오르내리는
 * 것마다 반응하면 오차 수정에도 메일이 간다.
 *
 * 신청은 발송 시 소진되므로 0→1→0→1 이 반복돼도 사람마다 한 번만 받는다.
 */
export async function findRestockTargets(
  db: Db,
  params: { productId: string; optionId?: string | null },
): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT count(*) AS n FROM shop_restock_alerts
    WHERE product_id = ${params.productId}::uuid
      AND status = 'pending'
      AND ${
        params.optionId
          ? sql`option_id = ${params.optionId}::uuid`
          : sql`option_id IS NULL`
      }
  `);
  return Number(rows[0]?.n ?? 0);
}

/**
 * 알림 발송.
 *
 * 큐 워커에서 돈다. **행을 먼저 잡아 notified 로 바꾸고 보낸다** — 반대로
 * 하면 발송 중 서버가 죽었을 때 같은 사람에게 두 번 간다. 두 번 가는 것이
 * 안 가는 것보다 나쁘다(스팸으로 신고된다).
 */
export async function sendRestockNotifications(
  db: Db,
  params: {
    productId: string;
    optionId: string | null;
    siteUrl: string;
    siteName: string;
    send: (msg: { to: string; subject: string; text: string }) => Promise<boolean>;
    log?: (message: string) => void;
  },
): Promise<{ sent: number; failed: number }> {
  const { rows: info } = await db.execute(sql`
    SELECT p.slug, p.name, p.price, o.name AS option_name
    FROM shop_products p
    LEFT JOIN shop_product_options o
      ON o.id = ${params.optionId}::uuid AND o.product_id = p.id
    WHERE p.id = ${params.productId}::uuid LIMIT 1
  `);
  const product = info[0];
  if (!product) return { sent: 0, failed: 0 };

  const productUrl = `${params.siteUrl.replace(/\/$/, "")}/shop/${String(product.slug)}`;
  const label = product.option_name
    ? `${String(product.name)} (${String(product.option_name)})`
    : String(product.name);

  let sent = 0;
  let failed = 0;

  for (;;) {
    // 먼저 소진 표시를 하고 가져온다. 트랜잭션 없이도 한 행이 두 워커에게
    // 가지 않는다 — UPDATE ... RETURNING 이 원자적이다.
    const { rows: batch } = await db.execute(sql`
      UPDATE shop_restock_alerts SET status = 'notified', notified_at = now()
      WHERE id IN (
        SELECT id FROM shop_restock_alerts
        WHERE product_id = ${params.productId}::uuid
          AND status = 'pending'
          AND ${
            params.optionId
              ? sql`option_id = ${params.optionId}::uuid`
              : sql`option_id IS NULL`
          }
        ORDER BY created_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, email, token
    `);
    if (!batch.length) break;

    for (const row of batch) {
      const cancelUrl = `${params.siteUrl.replace(/\/$/, "")}/shop/restock/cancel/${String(row.token)}`;
      const text = [
        `${label} 상품이 재입고되었습니다.`,
        "",
        `가격: ${Number(product.price).toLocaleString("ko-KR")}원`,
        `바로 보기: ${productUrl}`,
        "",
        "─────────────────────────────────────",
        `이 메일은 ${params.siteName}에서 재입고 알림을 신청하신 분께 1회 발송됩니다.`,
        "신청하지 않으셨다면 아래 링크를 눌러 알림을 해지해주세요:",
        cancelUrl,
      ].join("\n");

      try {
        // 광고가 아니므로 (광고) 표기를 붙이지 않는다. 손님이 요청한 정보다.
        // 그래서 본문에도 **다른 상품을 넣지 않는다** — 넣으면 광고가 되고
        // 수신 동의가 필요해진다 (ADR-50 과 같은 판단).
        const ok = await params.send({
          to: String(row.email),
          subject: `[재입고] ${label}`,
          text,
        });
        if (ok) sent += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        params.log?.(`재입고 알림 발송 실패 (${String(row.email).slice(0, 3)}***): ${String(err)}`);
      }
    }

    if (batch.length === BATCH) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return { sent, failed };
}

/**
 * 재입고 스윕 — 대기자가 있는데 재고가 들어온 조합을 찾는다.
 *
 * ── 왜 스윕인가 ──────────────────────────────────────
 *
 * 재고가 오르는 지점이 여러 곳이다: 주문 취소, 반품 완료, 관리자의 상품·옵션
 * 수정, 영카트 이전 도구, 그리고 앞으로 생길 것들. **각 지점에 알림 호출을
 * 붙이면 반드시 하나를 빠뜨린다** — 그리고 빠뜨린 경로로 재입고된 상품의
 * 대기자는 영원히 알림을 못 받는데, 아무도 그것을 눈치채지 못한다.
 *
 * 주기적으로 "대기자가 있는데 재고가 있는 조합"을 찾으면 **경로와 무관하게**
 * 잡힌다. 직접 SQL 로 재고를 넣어도 잡힌다.
 *
 * 재입고 알림에 몇 분의 지연은 아무 문제가 없다.
 */
export async function sweepRestock(
  db: Db,
): Promise<Array<{ productId: string; optionId: string | null; waiting: number }>> {
  const { rows } = await db.execute(sql`
    SELECT a.product_id, a.option_id, count(*) AS waiting
    FROM shop_restock_alerts a
    JOIN shop_products p ON p.id = a.product_id
    LEFT JOIN shop_product_options o ON o.id = a.option_id
    WHERE a.status = 'pending'
      -- 상품이 팔 수 있는 상태여야 한다. draft·hidden 으로 내렸으면
      -- 재고가 있어도 알림을 보내면 안 된다 (눌러도 살 수 없다).
      AND p.status IN ('selling', 'soldout')
      AND CASE
            -- 옵션 신청: 그 옵션의 재고를 본다.
            -- 재고가 NULL 이면 무한 재고이므로 살 수 있다.
            WHEN a.option_id IS NOT NULL
              THEN o.id IS NOT NULL AND o.is_active = true
                   AND (o.stock IS NULL OR o.stock > 0)
            -- 옵션 없는 신청: 상품 재고를 본다.
            -- status 가 soldout 이면 재고가 있어도 파는 것이 아니다 —
            -- 운영자가 일부러 내린 것이므로 존중한다.
            ELSE p.status = 'selling' AND (p.stock IS NULL OR p.stock > 0)
          END
    GROUP BY a.product_id, a.option_id
    ORDER BY waiting DESC
    LIMIT 50
  `);
  return rows.map((r) => ({
    productId: String(r.product_id),
    optionId: r.option_id ? String(r.option_id) : null,
    waiting: Number(r.waiting),
  }));
}

/** 관리자 목록 — 어떤 상품을 기다리는 사람이 많은지 본다 */
export async function listRestockDemand(db: Db, params: { page?: number }) {
  const page = Math.max(1, Math.floor(Number(params.page ?? 1)));
  const { rows } = await db.execute(sql`
    SELECT p.id AS product_id, p.slug, p.name AS product_name, p.status,
           o.id AS option_id, o.name AS option_name,
           count(*) AS waiting,
           min(a.created_at) AS first_at
    FROM shop_restock_alerts a
    JOIN shop_products p ON p.id = a.product_id
    LEFT JOIN shop_product_options o ON o.id = a.option_id
    WHERE a.status = 'pending'
    GROUP BY p.id, p.slug, p.name, p.status, o.id, o.name
    ORDER BY waiting DESC, first_at
    LIMIT 30 OFFSET ${(page - 1) * 30}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n FROM (
      SELECT 1 FROM shop_restock_alerts a WHERE a.status = 'pending'
      GROUP BY a.product_id, a.option_id
    ) t
  `);
  return {
    items: rows.map((r) => ({
      productId: String(r.product_id),
      productSlug: String(r.slug),
      productName: String(r.product_name),
      productStatus: String(r.status),
      optionId: r.option_id ? String(r.option_id) : null,
      optionName: r.option_name ? String(r.option_name) : null,
      /** 기다리는 사람 수 — 재입고 우선순위를 정하는 근거다 */
      waiting: Number(r.waiting),
      firstRequestedAt: r.first_at,
    })),
    total: Number(cnt[0]?.n ?? 0),
    page,
    pageSize: 30,
  };
}

/**
 * 회원 탈퇴 시 삭제 — `registerDataEraser` 가 부른다.
 *
 * 비회원 신청(user_id = NULL)은 남는다. 이메일로 지우면 같은 주소를 쓰는
 * 다른 사람의 신청을 지울 수 있고, 어차피 다음 재입고에 소진된다.
 */
export async function eraseRestockAlerts(
  tx: Db,
  userId: string,
): Promise<string[]> {
  const { rows } = await tx.execute(sql`
    DELETE FROM shop_restock_alerts WHERE user_id = ${userId}::uuid RETURNING id
  `);
  return rows.length ? [`재입고 알림 신청 ${rows.length}건 삭제`] : [];
}
