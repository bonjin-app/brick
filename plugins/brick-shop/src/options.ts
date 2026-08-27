import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./types.js";
import { ShopError } from "./types.js";

/**
 * 상품 옵션 관리.
 *
 * 왜 텍스트로 편집하는가:
 *   선언적 관리 화면(ADR-12)은 "부모에 종속된 목록"을 편집할 수 없다.
 *   옵션마다 별도 리소스를 만들면 상품을 고르는 UI가 필요한데, 선언적 스키마의
 *   select는 정적 목록만 지원한다.
 *
 *   그래서 상품 폼에 한 줄에 하나씩 적는 방식을 쓴다:
 *     색상: 빨강|1000|10
 *     색상: 파랑|0|5
 *     무광 마감||3
 *
 *   형식: 이름|추가금|재고   (추가금·재고는 생략 가능, 재고를 비우면 무한)
 *   한국 쇼핑몰에서 흔히 쓰는 방식이고, 옵션이 수십 개여도 붙여넣기로 관리된다.
 */

export interface ParsedOption {
  name: string;
  extraPrice: number;
  stock: number | null;
}

/** 텍스트 → 옵션 목록. 형식이 틀리면 어느 줄인지 알려준다 */
export function parseOptions(text: string): ParsedOption[] {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length > 100) throw new ShopError(400, "옵션은 100개까지 등록할 수 있습니다.");

  const seen = new Set<string>();
  return lines.map((line, index) => {
    const parts = line.split("|").map((p) => p.trim());
    const name = parts[0];
    if (!name) throw new ShopError(400, `${index + 1}번째 옵션: 이름이 비어 있습니다.`);
    if (name.length > 200) throw new ShopError(400, `${index + 1}번째 옵션: 이름이 너무 깁니다.`);

    const key = name.toLowerCase();
    if (seen.has(key)) throw new ShopError(400, `옵션 이름이 중복되었습니다: ${name}`);
    seen.add(key);

    // 추가금: 비우면 0. 음수(할인 옵션)도 허용하되 상품가를 넘지 못하게 하는 것은
    // 주문 시점의 금액 계산이 담당한다(단가가 음수가 되면 거기서 걸린다).
    const extraRaw = parts[1] ?? "";
    const extraPrice = extraRaw === "" ? 0 : Math.floor(Number(extraRaw));
    if (!Number.isFinite(extraPrice)) {
      throw new ShopError(400, `${index + 1}번째 옵션 "${name}": 추가금이 숫자가 아닙니다.`);
    }

    // 재고: 비우면 무한(null)
    const stockRaw = parts[2] ?? "";
    const stock = stockRaw === "" ? null : Math.floor(Number(stockRaw));
    if (stock !== null && (!Number.isFinite(stock) || stock < 0)) {
      throw new ShopError(400, `${index + 1}번째 옵션 "${name}": 재고가 올바르지 않습니다.`);
    }

    return { name, extraPrice, stock };
  });
}

/** 옵션 목록 → 텍스트 (관리 화면이 편집할 형태로) */
export function formatOptions(
  rows: Array<{ name: unknown; extra_price: unknown; stock: unknown }>,
): string {
  return rows
    .map((r) => {
      const extra = Number(r.extra_price ?? 0);
      const stock = r.stock === null || r.stock === undefined ? "" : String(Number(r.stock));
      // 뒤쪽 빈 칸은 생략해 읽기 쉽게 (이름만 있으면 이름만)
      if (!extra && stock === "") return String(r.name);
      return `${String(r.name)}|${extra}|${stock}`;
    })
    .join("\n");
}

/**
 * 옵션 동기화.
 *
 * 전부 지우고 다시 넣지 않는다 — 그러면 장바구니에 담긴 옵션의 id가 사라져
 * (ON DELETE SET NULL) 고객의 장바구니가 조용히 망가진다.
 * 이름으로 짝지어 **기존 것은 갱신**하고, 사라진 것만 지운다.
 */
export async function syncOptions(db: Db, productId: string, parsed: ParsedOption[]): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows: existing } = await tx.execute(sql`
      SELECT id, name FROM shop_product_options WHERE product_id = ${productId}::uuid
    `);
    const byName = new Map(existing.map((r) => [String(r.name).toLowerCase(), String(r.id)]));
    const keep = new Set<string>();

    for (const [index, opt] of parsed.entries()) {
      const key = opt.name.toLowerCase();
      const id = byName.get(key);
      if (id) {
        keep.add(id);
        await tx.execute(sql`
          UPDATE shop_product_options SET
            name = ${opt.name}, extra_price = ${opt.extraPrice}, stock = ${opt.stock},
            sort_order = ${index}, is_active = true
          WHERE id = ${id}::uuid
        `);
      } else {
        const newId = uuidv7();
        keep.add(newId);
        await tx.execute(sql`
          INSERT INTO shop_product_options (id, product_id, name, extra_price, stock, sort_order, is_active)
          VALUES (${newId}, ${productId}::uuid, ${opt.name}, ${opt.extraPrice}, ${opt.stock}, ${index}, true)
        `);
      }
    }

    // 목록에서 사라진 옵션은 제거한다.
    // 주문 항목은 option_name을 스냅샷으로 갖고 있으므로 과거 주문 내역은 온전하다.
    for (const [, id] of byName) {
      if (!keep.has(id)) {
        await tx.execute(sql`DELETE FROM shop_product_options WHERE id = ${id}::uuid`);
      }
    }
  });
}

/**
 * 이미지 URL 목록 파싱 — 한 줄에 하나.
 * 미디어 라이브러리에서 업로드한 뒤 URL을 붙여넣는 흐름을 전제한다.
 */
export function parseImages(text: string): string[] {
  const urls = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (urls.length > 20) throw new ShopError(400, "이미지는 20장까지 등록할 수 있습니다.");

  for (const url of urls) {
    // 상대 경로(/uploads/...) 또는 http(s)만 허용한다.
    // javascript: 같은 스킴이 img src에 들어가는 것을 막는다.
    if (!/^(\/|https?:\/\/)/.test(url)) {
      throw new ShopError(400, `이미지 주소가 올바르지 않습니다: ${url.slice(0, 60)}`);
    }
    if (url.length > 1000) throw new ShopError(400, "이미지 주소가 너무 깁니다.");
  }
  return urls;
}
