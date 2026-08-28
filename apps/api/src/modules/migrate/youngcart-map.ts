/**
 * 영카트5 → Brick 커머스 매핑.
 *
 * 영카트는 그누보드5 위에 얹힌 쇼핑몰이고 테이블 접두어를 공유한다
 * (`g5_shop_item`, `g5_shop_order`, ...). 그래서 같은 덤프 하나로 회원·게시판과
 * 상품·주문을 함께 옮길 수 있다.
 *
 * 이 파일이 다루는 것은 "어떤 컬럼이 어디로"가 아니라 **구조가 다른 지점**이다.
 */

/** 영카트 상품 상태 → Brick 상태 */
export function itemStatus(row: {
  it_use?: string | null;
  it_soldout?: string | null;
  it_stock_qty?: string | null;
}): "selling" | "soldout" | "hidden" {
  // it_use = 0 이면 판매하지 않는 상품이다. draft 가 아니라 hidden 으로 둔다 —
  // draft 는 "아직 안 만든 것"이고, 이건 "팔다가 내린 것"이다.
  if (String(row.it_use ?? "1") !== "1") return "hidden";
  if (String(row.it_soldout ?? "0") === "1") return "soldout";
  // 재고 0을 품절로 자동 전환하지 않는다 — 영카트에서 재고를 관리하지 않는
  // 상품(it_stock_qty = 0 이지만 계속 파는)이 흔하다. it_soldout 이 판단 기준이다.
  return "selling";
}

/**
 * 영카트 주문 상태 → Brick 상태.
 *
 * 영카트는 한글 문자열을 그대로 저장한다(od_status = '주문', '입금', ...).
 * 알 수 없는 값은 pending 으로 떨어뜨린다 — 임의로 '완료'로 보면 배송하지 않은
 * 주문이 완료 처리되고, 매출 통계가 부풀려진다.
 */
export function orderStatus(raw: string | null | undefined): {
  status: string;
  paymentStatus: string;
} {
  const s = String(raw ?? "").trim();
  switch (s) {
    case "주문":
      return { status: "pending", paymentStatus: "unpaid" };
    case "입금":
      return { status: "paid", paymentStatus: "paid" };
    case "준비":
      return { status: "preparing", paymentStatus: "paid" };
    case "배송":
      return { status: "shipped", paymentStatus: "paid" };
    case "완료":
      return { status: "delivered", paymentStatus: "paid" };
    case "취소":
      return { status: "cancelled", paymentStatus: "unpaid" };
    case "반품":
    case "품절":
      // 품절은 영카트에서 "주문은 받았는데 재고가 없어 취소한" 상태다.
      // 환불이 필요할 수 있으므로 refunded 로 본다.
      return { status: "refunded", paymentStatus: "refunded" };
    default:
      return { status: "pending", paymentStatus: "unpaid" };
  }
}

/**
 * 영카트 결제수단 → Brick.
 *
 * od_settle_case 는 '무통장' · '카드' · '가상계좌' · '계좌이체' · '휴대폰' 등이다.
 * Brick 은 게이트웨이 이름을 쓰므로 정확히 대응하지 않는다 —
 * **과거 주문의 결제수단은 기록일 뿐** 재결제에 쓰이지 않으므로,
 * 원문을 보존하고 알 수 없는 것은 bank_transfer 로 둔다.
 */
export function paymentMethod(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "bank_transfer";
  // 원문을 30자 이내로 그대로 남긴다. 통계에서 "카드 결제 비중"을 볼 수 있다.
  return s.slice(0, 30);
}

/**
 * 영카트 분류 id → Brick slug.
 *
 * 영카트의 ca_id 는 계층을 문자열 길이로 표현한다:
 *   "10"     → 대분류
 *   "1010"   → 그 아래 중분류
 *   "101010" → 소분류
 *
 * 즉 부모는 **앞자리를 자른 값**이다. 이걸 알아야 계층을 복원할 수 있다.
 */
export function categoryParentId(caId: string): string | null {
  const id = String(caId ?? "").trim();
  // 영카트 기본 설정은 2자리 단위다. 2자리면 최상위.
  if (id.length <= 2) return null;
  return id.slice(0, id.length - 2);
}

export function categorySlug(caId: string): string {
  const id = String(caId ?? "").replace(/[^a-zA-Z0-9]/g, "");
  return `cat-${id || "0"}`.slice(0, 100);
}

/**
 * 영카트 상품 id → Brick slug.
 *
 * it_id 는 `20240115123456` 같은 타임스탬프 문자열이다. 주소에 그대로 쓰면
 * 읽을 수 없으므로 상품명에서 slug 를 만들되, 한글은 남길 수 없으니
 * **id 를 접미사로 붙여 유일성을 보장**한다.
 *
 * 왜 상품명만으로 안 되는가: 한글 상품명은 slug 규칙(영문 소문자·숫자·하이픈)에
 * 맞는 문자가 하나도 없는 경우가 많다. 그러면 전부 같은 slug 가 되어 충돌한다.
 */
export function itemSlug(itId: string, name: string): string {
  const base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
  const id = String(itId ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(-14);
  return base ? `${base}-${id}`.slice(0, 150) : `item-${id}`;
}

/**
 * 영카트 옵션 문자열 파싱.
 *
 * 상품에는 `it_option_subject` (옵션 제목, `\n` 구분)와 `it_option_1..` 에
 * 선택지가 들어 있다. 그리고 실제 옵션 조합은 `g5_shop_item_option` 에 있다.
 *
 * 조합형 옵션(색상+사이즈)은 Brick 의 단층 옵션 모델로 표현할 수 없다.
 * 그래서 **조합을 하나의 옵션 이름으로 펼친다** — "빨강,L" → "빨강,L".
 * 영카트도 화면에서는 조합을 한 줄로 보여주므로 사용자가 보는 것은 같다.
 */
export interface YcOption {
  name: string;
  extraPrice: number;
  stock: number | null;
}

export function parseItemOption(row: {
  io_id?: string | null;
  io_price?: string | null;
  io_stock_qty?: string | null;
  io_use?: string | null;
}): YcOption | null {
  const name = String(row.io_id ?? "").trim();
  if (!name) return null;
  if (String(row.io_use ?? "1") !== "1") return null;
  const extraPrice = Math.floor(Number(row.io_price ?? 0)) || 0;
  const stockRaw = row.io_stock_qty;
  const stock =
    stockRaw === null || stockRaw === undefined || String(stockRaw).trim() === ""
      ? null
      : Math.max(0, Math.floor(Number(stockRaw)) || 0);
  return { name: name.slice(0, 200), extraPrice, stock };
}

/**
 * 영카트 우편번호 → Brick.
 *
 * 구버전은 od_zip1(3자리) + od_zip2(3자리)로 나뉘어 있고, 신버전은 od_zip(5자리)다.
 * 둘 다 받아야 한다 — 오래된 사이트가 옮겨오는 것이 이 도구의 목적이다.
 */
export function postcode(row: {
  od_zip?: string | null;
  od_zip1?: string | null;
  od_zip2?: string | null;
}): string {
  const single = String(row.od_zip ?? "").replace(/\D/g, "");
  if (single.length === 5) return single;
  const a = String(row.od_zip1 ?? "").replace(/\D/g, "");
  const b = String(row.od_zip2 ?? "").replace(/\D/g, "");
  if (a && b) return `${a}-${b}`;
  return single || a || "00000";
}

/** 주소 세 칸을 합친다 (영카트는 기본주소·상세주소·참고항목으로 나뉜다) */
export function address(row: {
  od_addr1?: string | null;
  od_addr2?: string | null;
  od_addr3?: string | null;
}): { address1: string; address2: string | null } {
  const a1 = String(row.od_addr1 ?? "").trim();
  const rest = [row.od_addr2, row.od_addr3]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return {
    address1: (a1 || "(주소 없음)").slice(0, 300),
    address2: rest ? rest.slice(0, 300) : null,
  };
}

/**
 * 상품 이미지 목록.
 *
 * 영카트는 it_img1 ~ it_img10 에 **파일명만** 저장하고 실제 파일은
 * `data/item/<파일명>` 에 있다. 파일을 옮기는 것은 사용자 몫이므로
 * 경로만 만들어 둔다 — 리버스 프록시로 /data/item/ 을 넘기거나
 * uploads/ 로 복사하면 뜬다(문서에 적었다).
 */
export function itemImages(row: Record<string, string | null>): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 10; i += 1) {
    const name = String(row[`it_img${i}`] ?? "").trim();
    if (!name) continue;
    out.push(`/data/item/${name}`);
  }
  return out;
}

export const YC_TABLES = {
  category: "shop_category",
  item: "shop_item",
  itemOption: "shop_item_option",
  order: "shop_order",
  /** 주문 항목 — 영카트는 장바구니 테이블이 주문 항목을 겸한다 */
  cart: "shop_cart",
  itemUse: "shop_item_use",
  itemQa: "shop_item_qa",
} as const;

/** 덤프에 영카트가 있는가 */
export function hasYoungcart(tables: Map<string, unknown>, prefix: string): boolean {
  return tables.has(`${prefix}${YC_TABLES.item}`) && tables.has(`${prefix}${YC_TABLES.order}`);
}
