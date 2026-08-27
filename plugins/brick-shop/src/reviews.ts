import { sql } from "drizzle-orm";
import { isUniqueViolation } from "@brick/plugin-sdk";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

/**
 * 상품 후기와 문의.
 *
 * 후기의 핵심은 **구매 검증**이다. 구매하지 않은 사람이 별점을 남기면
 * 평점이 신뢰를 잃는다 — 영카트를 쓰는 쇼핑몰이 가장 신경 쓰는 부분이다.
 */

export interface ReviewInput {
  rating: number;
  content: string;
  images?: string[];
}

/**
 * 구매 검증 — 이 회원이 이 상품을 실제로 구매했는가.
 *
 * 조건: 결제가 확인된 주문(paid 이후)에 해당 상품이 포함되어 있어야 한다.
 * 입금대기(pending)는 인정하지 않는다 — 주문만 하고 후기를 쓰는 것을 막는다.
 * 취소·환불된 주문도 인정하지 않는다.
 *
 * @returns 근거가 된 주문번호, 없으면 null
 */
export async function findPurchase(
  db: Db,
  params: { productId: string; userId: string },
): Promise<string | null> {
  const { rows } = await db.execute(sql`
    SELECT o.order_no
    FROM shop_order_items i
    JOIN shop_orders o ON o.id = i.order_id
    WHERE i.product_id = ${params.productId}::uuid
      AND o.user_id = ${params.userId}::uuid
      AND o.status IN ('paid', 'preparing', 'shipped', 'delivered')
    ORDER BY o.created_at DESC
    LIMIT 1
  `);
  return rows[0] ? String(rows[0].order_no) : null;
}

/** 후기 집계를 다시 계산한다 (증감 누적보다 정확하다) */
async function recountReviews(db: Db, productId: string): Promise<void> {
  await db.execute(sql`
    UPDATE shop_products p SET
      review_count = agg.n,
      rating_sum = agg.total
    FROM (
      SELECT count(*) AS n, coalesce(sum(rating), 0) AS total
      FROM shop_reviews
      WHERE product_id = ${productId}::uuid AND is_visible = true
    ) AS agg
    WHERE p.id = ${productId}::uuid
  `);
}

export async function createReview(
  db: Db,
  params: {
    productId: string;
    userId: string;
    authorName: string;
    input: ReviewInput;
    /** 구매 검증을 건너뛴다 (관리자용) */
    skipPurchaseCheck?: boolean;
  },
): Promise<{ id: string; orderNo: string | null }> {
  const rating = Math.floor(Number(params.input?.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ShopError(400, "별점은 1~5 사이여야 합니다.");
  }
  const content = String(params.input?.content ?? "").trim();
  if (content.length < 5) throw new ShopError(400, "후기를 5자 이상 작성해주세요.");
  if (content.length > 5000) throw new ShopError(400, "후기가 너무 깁니다. (5000자 이내)");

  // 이미지는 URL만 받는다 (업로드는 미디어 라이브러리가 담당)
  const images = (Array.isArray(params.input?.images) ? params.input.images : [])
    .map((u) => String(u).trim())
    .filter((u) => /^(\/|https?:\/\/)/.test(u))
    .slice(0, 5);

  const { rows: product } = await db.execute(sql`
    SELECT id, status FROM shop_products WHERE id = ${params.productId}::uuid LIMIT 1
  `);
  if (!product[0]) throw new ShopError(404, "상품을 찾을 수 없습니다.");

  let orderNo: string | null = null;
  if (!params.skipPurchaseCheck) {
    orderNo = await findPurchase(db, { productId: params.productId, userId: params.userId });
    if (!orderNo) {
      throw new ShopError(403, "구매하신 상품에만 후기를 작성할 수 있습니다.");
    }
  }

  const id = uuidv7();
  try {
    await db.execute(sql`
      INSERT INTO shop_reviews
        (id, product_id, user_id, author_name, order_no, rating, content, images)
      VALUES
        (${id}, ${params.productId}::uuid, ${params.userId}::uuid, ${params.authorName},
         ${orderNo}, ${rating}, ${content}, ${JSON.stringify(images)}::jsonb)
    `);
  } catch (err) {
    if (isUniqueViolation(err, "shop_reviews_once_idx")) {
      throw new ShopError(409, "이미 이 상품에 후기를 작성하셨습니다. 기존 후기를 수정해주세요.");
    }
    throw err;
  }

  await recountReviews(db, params.productId);
  return { id, orderNo };
}

export async function updateReview(
  db: Db,
  params: { reviewId: string; userId: string; isManager: boolean; input: ReviewInput },
): Promise<void> {
  const rating = Math.floor(Number(params.input?.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ShopError(400, "별점은 1~5 사이여야 합니다.");
  }
  const content = String(params.input?.content ?? "").trim();
  if (content.length < 5) throw new ShopError(400, "후기를 5자 이상 작성해주세요.");

  const images = (Array.isArray(params.input?.images) ? params.input.images : [])
    .map((u) => String(u).trim())
    .filter((u) => /^(\/|https?:\/\/)/.test(u))
    .slice(0, 5);

  const { rows } = await db.execute(sql`
    UPDATE shop_reviews SET
      rating = ${rating}, content = ${content},
      images = ${JSON.stringify(images)}::jsonb, updated_at = now()
    WHERE id = ${params.reviewId}::uuid
      AND (user_id = ${params.userId}::uuid OR ${params.isManager})
    RETURNING product_id
  `);
  if (!rows.length) throw new ShopError(403, "본인이 작성한 후기만 수정할 수 있습니다.");
  await recountReviews(db, String(rows[0].product_id));
}

export async function deleteReview(
  db: Db,
  params: { reviewId: string; userId: string; isManager: boolean },
): Promise<void> {
  const { rows } = await db.execute(sql`
    DELETE FROM shop_reviews
    WHERE id = ${params.reviewId}::uuid
      AND (user_id = ${params.userId}::uuid OR ${params.isManager})
    RETURNING product_id
  `);
  if (!rows.length) throw new ShopError(403, "본인이 작성한 후기만 삭제할 수 있습니다.");
  await recountReviews(db, String(rows[0].product_id));
}

/** 관리자: 후기 숨김/표시 토글 — 삭제보다 되돌리기 쉽다 */
export async function setReviewVisible(db: Db, reviewId: string, visible: boolean): Promise<void> {
  const { rows } = await db.execute(sql`
    UPDATE shop_reviews SET is_visible = ${visible}, updated_at = now()
    WHERE id = ${reviewId}::uuid RETURNING product_id
  `);
  if (!rows.length) throw new ShopError(404, "후기를 찾을 수 없습니다.");
  await recountReviews(db, String(rows[0].product_id));
}

/** 판매자 답변 */
export async function replyToReview(db: Db, reviewId: string, reply: string): Promise<void> {
  const text = String(reply ?? "").trim();
  const { rows } = await db.execute(sql`
    UPDATE shop_reviews SET
      admin_reply = ${text || null},
      admin_replied_at = ${text ? sql`now()` : sql`NULL`}
    WHERE id = ${reviewId}::uuid RETURNING id
  `);
  if (!rows.length) throw new ShopError(404, "후기를 찾을 수 없습니다.");
}

export async function listReviews(
  db: Db,
  params: { productId: string; page: number; viewerId?: string | null; isManager?: boolean },
) {
  const size = 10;
  const page = Math.max(1, params.page);
  // 관리자는 숨긴 후기도 본다 (숨김 처리를 확인·되돌리기 위해)
  const visibility = params.isManager ? sql`TRUE` : sql`r.is_visible = true`;

  const [items, counted, summary] = await Promise.all([
    db.execute(sql`
      SELECT r.id, r.user_id, r.author_name, r.rating, r.content, r.images,
             r.admin_reply, r.admin_replied_at, r.is_visible, r.order_no, r.created_at
      FROM shop_reviews r
      WHERE r.product_id = ${params.productId}::uuid AND ${visibility}
      ORDER BY r.created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}
    `).then((r) => r.rows),
    db.execute(sql`
      SELECT count(*) AS n FROM shop_reviews r
      WHERE r.product_id = ${params.productId}::uuid AND ${visibility}
    `).then((r) => Number(r.rows[0]?.n ?? 0)),
    // 별점 분포 — 상세 화면에 막대로 보여준다
    db.execute(sql`
      SELECT rating, count(*) AS n FROM shop_reviews
      WHERE product_id = ${params.productId}::uuid AND is_visible = true
      GROUP BY rating
    `).then((r) => r.rows),
  ]);

  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let sum = 0;
  for (const row of summary) {
    const rating = Number(row.rating);
    const n = Number(row.n);
    distribution[rating] = n;
    total += n;
    sum += rating * n;
  }

  return {
    items: items.map((r) => ({
      ...r,
      // 구매 확인 배지 — 신뢰의 근거이므로 여부만 노출하고 주문번호는 감춘다
      verified: Boolean(r.order_no),
      order_no: undefined,
      mine: Boolean(params.viewerId && String(r.user_id) === params.viewerId),
    })),
    total: counted,
    page,
    pageSize: size,
    average: total > 0 ? Math.round((sum / total) * 10) / 10 : 0,
    ratingCount: total,
    distribution,
  };
}

/* ══════════════════════════════════════════════════════
   문의
   ══════════════════════════════════════════════════════ */

export async function createInquiry(
  db: Db,
  params: {
    productId: string;
    userId: string;
    authorName: string;
    input: { title?: string; content?: string; isSecret?: boolean };
  },
): Promise<{ id: string }> {
  const title = String(params.input?.title ?? "").trim();
  const content = String(params.input?.content ?? "").trim();
  if (!title) throw new ShopError(400, "문의 제목을 입력해주세요.");
  if (title.length > 300) throw new ShopError(400, "제목이 너무 깁니다.");
  if (!content) throw new ShopError(400, "문의 내용을 입력해주세요.");
  if (content.length > 5000) throw new ShopError(400, "문의가 너무 깁니다. (5000자 이내)");

  const { rows: product } = await db.execute(sql`
    SELECT id FROM shop_products WHERE id = ${params.productId}::uuid LIMIT 1
  `);
  if (!product[0]) throw new ShopError(404, "상품을 찾을 수 없습니다.");

  const id = uuidv7();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO shop_inquiries (id, product_id, user_id, author_name, title, content, is_secret)
      VALUES (${id}, ${params.productId}::uuid, ${params.userId}::uuid, ${params.authorName},
              ${title}, ${content}, ${Boolean(params.input?.isSecret)})
    `);
    await tx.execute(sql`
      UPDATE shop_products SET inquiry_count =
        (SELECT count(*) FROM shop_inquiries q WHERE q.product_id = shop_products.id)
      WHERE id = ${params.productId}::uuid
    `);
  });
  return { id };
}

export async function listInquiries(
  db: Db,
  params: { productId: string; page: number; viewerId?: string | null; isManager?: boolean },
) {
  const size = 10;
  const page = Math.max(1, params.page);
  const { rows } = await db.execute(sql`
    SELECT id, user_id, author_name, title, content, is_secret, status,
           admin_reply, admin_replied_at, created_at
    FROM shop_inquiries
    WHERE product_id = ${params.productId}::uuid
    ORDER BY created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n FROM shop_inquiries WHERE product_id = ${params.productId}::uuid
  `);

  return {
    items: rows.map((q) => {
      const mine = Boolean(params.viewerId && String(q.user_id) === params.viewerId);
      // 비밀 문의는 작성자와 판매자만 내용을 본다.
      // 배송지·연락처를 적는 경우가 많아 노출되면 개인정보 유출이 된다.
      const hidden = q.is_secret && !mine && !params.isManager;
      return {
        ...q,
        mine,
        title: hidden ? "비밀 문의입니다." : q.title,
        content: hidden ? null : q.content,
        admin_reply: hidden ? null : q.admin_reply,
      };
    }),
    total: Number(cnt[0]?.n ?? 0),
    page,
    pageSize: size,
  };
}

export async function replyToInquiry(db: Db, inquiryId: string, reply: string): Promise<void> {
  const text = String(reply ?? "").trim();
  if (!text) throw new ShopError(400, "답변 내용을 입력해주세요.");
  const { rows } = await db.execute(sql`
    UPDATE shop_inquiries SET admin_reply = ${text}, admin_replied_at = now(), status = 'answered'
    WHERE id = ${inquiryId}::uuid RETURNING id, user_id
  `);
  if (!rows.length) throw new ShopError(404, "문의를 찾을 수 없습니다.");
}

export async function deleteInquiry(
  db: Db,
  params: { inquiryId: string; userId: string; isManager: boolean },
): Promise<void> {
  const { rows } = await db.execute(sql`
    DELETE FROM shop_inquiries
    WHERE id = ${params.inquiryId}::uuid
      AND (user_id = ${params.userId}::uuid OR ${params.isManager})
    RETURNING product_id
  `);
  if (!rows.length) throw new ShopError(403, "본인이 작성한 문의만 삭제할 수 있습니다.");
  await db.execute(sql`
    UPDATE shop_products SET inquiry_count =
      (SELECT count(*) FROM shop_inquiries q WHERE q.product_id = shop_products.id)
    WHERE id = ${String(rows[0].product_id)}::uuid
  `);
}
