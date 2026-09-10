import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { PRODUCT_STATUS_LABEL, ShopError, type Db } from "./types.js";

/**
 * 상품 붙여넣기 등록.
 *
 * 폼은 한 번에 하나다. 쇼핑몰을 옮겨 오는 날 상품 이백 개를 이백 번 입력할 수는 없다 —
 * 그래서 기존 가게는 이사를 포기하고, 설치형 CMS 는 "새로 시작하는 사람"만의 것이 된다.
 *
 * 원본은 대개 엑셀이므로 **붙여넣기**를 받는다. 엑셀에서 범위를 복사하면 탭으로 구분된
 * 텍스트가 그대로 오고, 파일로 받을 때 앞에 붙는 세 단계(다른 이름으로 저장 → 형식 고르기
 * → 업로드)가 사라진다.
 */

/** 열 이름 → 내부 필드. 한글·영문 둘 다 받는다 (엑셀 원본의 머리글이 무엇일지 모른다) */
const COLUMNS: Record<string, string> = {
  "주소": "slug", "slug": "slug", "코드": "slug", "상품코드": "slug",
  "상품명": "name", "이름": "name", "name": "name",
  "판매가": "price", "가격": "price", "price": "price",
  "정가": "listPrice", "소비자가": "listPrice", "list_price": "listPrice", "listprice": "listPrice",
  "재고": "stock", "stock": "stock",
  "상태": "status", "판매상태": "status", "status": "status",
  "요약": "summary", "간단설명": "summary", "summary": "summary",
  "설명": "description", "상세설명": "description", "description": "description",
  "분류": "category", "카테고리": "category", "category": "category",
  "대표이미지": "imageUrl", "이미지": "imageUrl", "image_url": "imageUrl", "image": "imageUrl",
  "진열순서": "sortOrder", "순서": "sortOrder", "sort_order": "sortOrder",
  "무료배송": "freeShipping", "free_shipping": "freeShipping",
};

/** 상태 한글 표기도 받는다 — 엑셀에는 "판매중"이라고 적혀 있다 */
const STATUS_BY_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(PRODUCT_STATUS_LABEL).map(([value, label]) => [label, value]),
);

export interface ImportResult {
  created: number;
  updated: number;
  failed: Array<{ line: number; message: string }>;
}

/**
 * 한 줄을 칸으로 나눈다.
 *
 * 탭이 있으면 탭이 구분자다(엑셀 복사가 그렇다). 없으면 쉼표이고, 그때는 따옴표 안의
 * 쉼표를 지켜야 한다 — 상품명에 쉼표가 들어간다("머그컵, 화이트").
 */
function splitLine(line: string, sep: string): string[] {
  if (sep === "\t") return line.split("\t").map((c) => c.trim());
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // "" 는 따옴표 하나
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { cells.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const truthy = (v: string): boolean => ["1", "y", "yes", "true", "o", "예", "y/n".slice(0, 1)].includes(v.toLowerCase());

/**
 * 붙여넣은 표를 상품으로 넣는다. **주소(slug)가 있으면 수정, 없으면 등록**이다 —
 * 같은 파일을 두 번 붙여넣어도 상품이 두 벌 생기지 않는다.
 *
 * 실패한 줄은 건너뛰고 나머지를 넣는다. 오타 하나로 이백 줄을 막으면 운영자는 어느 줄이
 * 문제인지 찾다가 그만둔다 — 대신 몇 번째 줄이 왜 실패했는지 정확히 돌려준다.
 */
export async function importProducts(db: Db, text: string, maxRows = 500): Promise<ImportResult> {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new ShopError(400, "머리글 한 줄과 상품 한 줄 이상이 필요합니다.");
  if (lines.length - 1 > maxRows) throw new ShopError(400, `한 번에 ${maxRows}줄까지 넣을 수 있습니다.`);

  const sep = lines[0].includes("\t") ? "\t" : ",";
  const header = splitLine(lines[0], sep).map((h) => COLUMNS[h.toLowerCase()] ?? COLUMNS[h] ?? "");
  if (!header.includes("slug") || !header.includes("name")) {
    throw new ShopError(400, "머리글에 주소(slug)와 상품명이 있어야 합니다.");
  }

  // 분류는 이름으로 적는다(운영자가 uuid 를 알 리 없다) — 미리 읽어 맞춘다
  const { rows: cats } = await db.execute(sql`SELECT id, name FROM shop_categories`);
  const catByName = new Map(cats.map((c) => [String(c.name).trim(), String(c.id)]));

  const result: ImportResult = { created: 0, updated: 0, failed: [] };
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], sep);
    const row: Record<string, string> = {};
    header.forEach((field, n) => { if (field) row[field] = cells[n] ?? ""; });
    // 줄 번호는 **붙여넣은 그대로**다 (머리글이 1번 줄) — 운영자가 엑셀에서 찾아야 한다
    const line = i + 1;
    try {
      const slug = row.slug?.trim();
      const name = row.name?.trim();
      if (!slug || !name) throw new Error("주소(slug)와 상품명은 비울 수 없습니다.");
      if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("주소는 영문 소문자·숫자·하이픈만 됩니다.");
      const price = Math.round(Number(String(row.price ?? "").replace(/[,\s원]/g, "")));
      if (!Number.isFinite(price) || price < 0) throw new Error("판매가가 숫자가 아닙니다.");

      const listRaw = String(row.listPrice ?? "").replace(/[,\s원]/g, "");
      const listPrice = listRaw ? Math.round(Number(listRaw)) : null;
      if (listPrice !== null && !Number.isFinite(listPrice)) throw new Error("정가가 숫자가 아닙니다.");
      const stockRaw = String(row.stock ?? "").replace(/[,\s개]/g, "");
      const stock = stockRaw ? Math.round(Number(stockRaw)) : null;
      if (stock !== null && !Number.isFinite(stock)) throw new Error("재고가 숫자가 아닙니다.");

      const statusRaw = String(row.status ?? "").trim();
      const status = !statusRaw ? "selling"
        : statusRaw in PRODUCT_STATUS_LABEL ? statusRaw
        : STATUS_BY_LABEL[statusRaw];
      if (!status) throw new Error(`모르는 판매 상태입니다: ${statusRaw}`);

      const catName = String(row.category ?? "").trim();
      const categoryId = catName ? catByName.get(catName) : null;
      if (catName && !categoryId) throw new Error(`없는 분류입니다: ${catName}`);

      const sortRaw = String(row.sortOrder ?? "").trim();
      const sortOrder = sortRaw ? Math.round(Number(sortRaw)) : 0;
      if (!Number.isFinite(sortOrder)) throw new Error("진열순서가 숫자가 아닙니다.");

      const { rows: found } = await db.execute(sql`SELECT id FROM shop_products WHERE slug = ${slug} LIMIT 1`);
      const existing = found[0]?.id ? String(found[0].id) : null;
      const common = {
        name,
        price,
        listPrice,
        stock,
        status,
        summary: String(row.summary ?? "").trim() || null,
        description: String(row.description ?? "").trim() || "",
        imageUrl: String(row.imageUrl ?? "").trim() || null,
        categoryId: categoryId ?? null,
        freeShipping: truthy(String(row.freeShipping ?? "")),
        sortOrder,
      };

      if (existing) {
        await db.execute(sql`
          UPDATE shop_products SET
            name = ${common.name}, price = ${common.price}, list_price = ${common.listPrice},
            stock = ${common.stock}, status = ${common.status}, summary = ${common.summary},
            description = ${common.description}, image_url = ${common.imageUrl},
            category_id = ${common.categoryId}::uuid, free_shipping = ${common.freeShipping},
            sort_order = ${common.sortOrder}, updated_at = now()
          WHERE id = ${existing}::uuid
        `);
        result.updated++;
      } else {
        await db.execute(sql`
          INSERT INTO shop_products
            (id, slug, name, price, list_price, stock, status, summary, description,
             image_url, category_id, free_shipping, sort_order)
          VALUES
            (${uuidv7()}, ${slug}, ${common.name}, ${common.price}, ${common.listPrice},
             ${common.stock}, ${common.status}, ${common.summary}, ${common.description},
             ${common.imageUrl}, ${common.categoryId}::uuid, ${common.freeShipping}, ${common.sortOrder})
        `);
        result.created++;
      }
    } catch (err) {
      result.failed.push({ line, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
