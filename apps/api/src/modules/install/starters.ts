/**
 * 사이트 스타터 — 설치하면 기본 구성이 다 되어 있게.
 *
 * 지금까지 설치는 관리자 계정과 사이트 이름만 만들었다. **설치 직후 사이트를
 * 열면 아무것도 없고**, 운영자는 페이지·게시판·메뉴를 전부 손으로 만들어야
 * 했다. 대부분은 거기서 멈춘다 — 빈 화면 앞에서 무엇부터 해야 하는지 모른다.
 *
 * 설치할 때 사이트 유형을 고르면 그 유형의 기본 구성(홈 페이지 + 하위 페이지
 * + 게시판 + 메뉴 + 필요한 플러그인 활성화)이 통째로 만들어진다. 설치가
 * 끝나면 **이미 돌아가는 사이트**가 있고, 운영자가 할 일은 내용을 자기 것으로
 * 바꾸는 것뿐이다.
 *
 * ── 설계 판단 ────────────────────────────────────────
 *
 * **모든 내용은 일반 페이지·게시판·메뉴다.** 스타터 전용 개념을 만들지
 * 않는다 — 만들어진 것은 페이지 빌더와 메뉴 편집에서 똑같이 수정·삭제할 수
 * 있다. "기본 구성"이 특별 취급되면 수정하는 법을 따로 배워야 한다.
 *
 * **자리표시 문구임을 문구 자체가 말하게 한다.** "여기를 수정하세요" 대신
 * 실제로 쓸 법한 예문을 넣되, 사이트 이름을 섞어 자기 사이트임을 느끼게
 * 한다.
 *
 * **빈 사이트 선택지를 없애지 않는다.** 직접 만들고 싶은 사람에게 기본
 * 구성은 지울 것부터 생기는 짐이다.
 */
import { PRODUCT_ART, BANNER_ART, PROMO_ART, GALLERY_ART, OFFICE_ART } from "./sample-art.js";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";

export interface StarterDefinition {
  code: string;
  label: string;
  description: string;
  /** 활성화할 플러그인 (동봉된 것만) */
  plugins: string[];
  /** 만들어지는 것 안내 (설치 화면이 보여준다) */
  creates: string[];
  /**
   * 이 스타터에 맞는 동봉 테마. 없으면 기본 테마(default).
   *
   * 테마를 만들어 두고 스타터가 고르지 않으면 아무 의미가 없다 — 쇼핑몰을 골랐는데 커뮤니티
   * 레이아웃이 나오면 "테마를 바꿔야 한다"는 것 자체를 모른다. 운영자는 나중에 관리자 →
   * 테마에서 얼마든지 바꿀 수 있다(미리보기로 비교하고).
   */
  theme?: string;
  /**
   * 고를 수 있는 디자인(동봉 테마) — 첫 항목이 기본이다. 카페24 가 쇼핑몰을 만들 때 업종별 디자인부터 고르게 하는 것과 같은
   * 이유다: 식품 가게가 패션 편집숍의 모양으로 시작하면 바꿀 생각보다 "이 도구는 우리와 안 맞는다" 가 먼저 든다.
   * 색 셋(포인트·바탕·글자)은 설치 화면의 견본이다 — 설치 전이라 테마 파일을 읽지 않는다.
   */
  designs?: Array<{ theme: string; label: string; description: string; colors: [string, string, string] }>;
}

/**
 * 스타터 목록.
 *
 * 유형은 셋이면 충분하다. 선택지가 많을수록 고르다 지친다 — 설치 화면에서
 * 필요한 것은 "대충 이 방향"이고, 세부는 나중에 바꾼다.
 */
/** 쇼핑몰 샘플 분류 — 샘플 상품과 머리 메뉴의 하위 항목이 함께 쓴다(한 곳에 둔다: 이름이 갈라지면 메뉴가 빈 분류를 가리킨다) */
const SHOP_CATEGORIES = [
  { slug: "kitchen", name: "주방·다이닝" },
  { slug: "living", name: "리빙·패브릭" },
  { slug: "fragrance", name: "향·캔들" },
] as const;

export const STARTERS: StarterDefinition[] = [
  {
    code: "community",
    label: "커뮤니티",
    description: "공지사항·자유게시판·질문답변을 갖춘 게시판 중심 사이트",
    plugins: ["brick-board"],
    creates: ["홈 (최신글 모아보기 · 갤러리)", "소개 페이지", "게시판 4개 (갤러리 포함)", "헤더 메뉴"],
  },
  {
    code: "shop",
    label: "쇼핑몰",
    description: "상품 목록·장바구니·공지사항을 갖춘 판매 사이트",
    /*
     * 쇼핑몰의 기본 기능 — 카페24 기본 스킨에서 손님이 당연히 찾는 것: 고객센터(FAQ·1:1 문의)와 적립금.
     * 게시판·쇼핑몰만 켜 두면 머리의 "고객센터" 자리와 적립금이 비어, 운영자가 확장을 하나씩 찾아 켜야 했다.
     */
    plugins: ["brick-board", "brick-shop", "brick-helpdesk", "brick-point"],
    creates: ["홈 (배너 · 분류 · 신상품 · 기획전 · 베스트 · 진짜 후기 · 최근 본 상품 · 공지)", "샘플 상품 8개 · 분류 3개", "소개 · 이용 안내 · 이용약관 · 개인정보처리방침 페이지", "공지사항 게시판", "고객센터 (FAQ 예시 · 1:1 문의) · 적립금", "쇼핑몰 메뉴 · 푸터 메뉴"],
    theme: "storefront",
    designs: [
      { theme: "storefront", label: "스토어프런트", description: "종합몰 — 3단 헤더와 넓은 상품 격자", colors: ["#111318", "#ffffff", "#111318"] },
      { theme: "fresh", label: "프레시 마켓", description: "식품·생활 — 초록 포인트, 둥근 모서리", colors: ["#2e7d4f", "#fffdf8", "#1f2a22"] },
      { theme: "blossom", label: "블라썸", description: "뷰티·코스메틱 — 가운데 로고, 장밋빛", colors: ["#b8507a", "#fffbfa", "#2b2326"] },
      { theme: "mono", label: "모노", description: "패션·스트리트 — 흑백, 굵은 대문자, 세로 사진", colors: ["#111111", "#ffffff", "#e0282e"] },
      { theme: "boutique", label: "부티크", description: "편집숍 — 가운데 로고, 세리프 제목, 큰 여백", colors: ["#1d1a17", "#fdfcfa", "#f0ebe4"] },
    ],
  },
  {
    code: "company",
    label: "회사 홈페이지",
    description: "회사 소개·서비스 안내·공지·1:1 문의를 갖춘 안내 사이트",
    plugins: ["brick-board", "brick-helpdesk"],
    creates: ["홈", "회사 소개 · 서비스 페이지", "공지사항 게시판", "1:1 문의", "헤더 메뉴"],
    theme: "corporate",
  },
  {
    code: "blank",
    label: "빈 사이트",
    description: "아무것도 만들지 않습니다. 처음부터 직접 구성합니다.",
    plugins: [],
    creates: [],
  },
];

export function findStarter(code: string): StarterDefinition | null {
  return STARTERS.find((s) => s.code === code) ?? null;
}

/** 페이지 블록 노드 (pages.blocks 의 형태) */
interface Node {
  block: string;
  props: Record<string, unknown>;
}

interface SeedContext {
  db: BrickDb;
  siteName: string;
  /** 설치 화면에서 고른 디자인 — 스타터의 `designs` 에 있는 것만 받는다(없으면 스타터 기본) */
  theme?: string;
  /** 플러그인 활성화 — loader.activate 를 주입받는다 (순환 의존을 피한다) */
  activatePlugin: (name: string) => Promise<void>;
  log: (message: string) => void;
  /**
   * 샘플 이미지를 미디어에 넣는다 — 실제 업로드와 같은 경로를 쓰므로 미디어 화면에도
   * 보이고 운영자가 지울 수 있다. 이미지 처리(sharp)를 못 쓰면 null 을 돌려준다.
   */
  /** 샘플 사진을 미디어에 넣고 원본·목록용(썸네일) 주소를 준다. sharp 가 없으면 null */
  addSampleImage?: (name: string, svg: string, size?: { width: number; height: number }) => Promise<{ url: string; thumbUrl: string | null } | null>;
}

/**
 * 스타터 적용.
 *
 * 설치 트랜잭션 안에서 부르지 않는다 — 플러그인 활성화는 마이그레이션을
 * 돌리므로 오래 걸릴 수 있고, 실패해도 **설치 자체는 성공해야 한다.**
 * 기본 구성이 반쯤 만들어진 것은 고칠 수 있지만, 설치가 실패하면 처음부터다.
 */
export async function applyStarter(code: string, ctx: SeedContext): Promise<{ applied: string[] }> {
  const starter = findStarter(code);
  if (!starter || starter.code === "blank") return { applied: [] };

  const applied: string[] = [];

  // ── 1. 플러그인 활성화 ──
  // 페이지가 참조하는 블록(latest-multi, product-list)이 여기서 등록된다.
  // 활성화가 실패한 플러그인의 블록은 "unknown block" 주석으로 렌더되므로
  // 사이트가 깨지지는 않는다 (ADR-62 에서 그렇게 만들었다).
  for (const name of starter.plugins) {
    try {
      await ctx.activatePlugin(name);
      applied.push(`플러그인 ${name}`);
    } catch (err) {
      ctx.log(`스타터: 플러그인 ${name} 활성화 실패 — ${String(err)}`);
    }
  }

  // ── 2. 게시판 ──
  const boards = starterBoards(starter.code);
  for (const b of boards) {
    try {
      await ctx.db.execute(sql`
        INSERT INTO board_boards (id, slug, title, description, read_role, write_role, list_style)
        VALUES (${uuidv7()}, ${b.slug}, ${b.title}, ${b.description},
                ${b.readRole}, ${b.writeRole}, ${b.listStyle ?? "basic"})
        ON CONFLICT (slug) DO NOTHING
      `);
      applied.push(`게시판 ${b.title}`);
    } catch (err) {
      ctx.log(`스타터: 게시판 ${b.slug} 생성 실패 — ${String(err)}`);
    }
  }

  // ── 3. 샘플 상품 ──
  // 페이지보다 먼저다 — 홈 배너가 샘플 사진의 URL 을 쓴다(images).
  // 쇼핑몰을 골랐는데 진열대가 비어 있으면 "무엇이 잘못됐나" 부터 의심하게 된다.
  // 카페24·그누보드가 샘플 상품을 넣는 이유다 — 이름에 (샘플) 을 달아 지우기 쉽게 한다.
  const images: SampleImages = {};
  if (starter.code === "shop") {
    try {
      const seeded = await seedShopSamples(ctx, images);
      if (seeded) applied.push(`샘플 상품 ${seeded}개`);
    } catch (err) {
      ctx.log(`스타터: 샘플 상품 생성 실패 — ${String(err)}`);
    }
  }

  // ── 3-1. 커뮤니티·회사 그림 ──
  // 쇼핑몰만 첫 화면이 채워져 있었다 — 갤러리 게시판은 빈 상자, 회사 소개의 사진 자리는 글만이었다.
  try {
    if (starter.code === "community") {
      for (const [key, draw] of Object.entries(GALLERY_ART)) {
        const added = await ctx.addSampleImage?.(`gallery-${key}.jpg`, draw(), { width: 1200, height: 900 });
        if (added) images[`gallery-${key}`] = added.url;
      }
    }
    if (starter.code === "company") {
      const added = await ctx.addSampleImage?.("office.jpg", OFFICE_ART(), { width: 1200, height: 800 });
      if (added) images.office = added.url;
    }
  } catch (err) {
    ctx.log(`스타터: 예시 그림 생성 실패 — ${String(err)}`);
  }

  // ── 3-2. 예시 글 ──
  // 홈의 최신글 위젯이 모두 "게시물이 없습니다" 로 끝나면 사이트가 고장 난 것처럼 보인다(설치해 보니 커뮤니티 홈의 위젯
  // 넷이 전부 비어 있었다). 그누보드·XE 가 예시 글을 넣는 이유다. 제목에 "(예시)" 를 달고 본문에 지우는 곳을 적는다.
  try {
    const n = await seedSamplePosts(ctx, starter.code, images);
    if (n) applied.push(`예시 글 ${n}개`);
  } catch (err) {
    ctx.log(`스타터: 예시 글 생성 실패 — ${String(err)}`);
  }

  // ── 3-3. 고객센터 FAQ 예시 ──
  // 고객센터 화면이 "등록된 FAQ 가 없습니다" 로 열리면 고장 난 것처럼 보인다 — 배송·교환·결제·회원 넷을 넣는다
  if (starter.plugins.includes("brick-helpdesk")) {
    try {
      const n = await seedSampleFaqs(ctx, starter.code);
      if (n) applied.push(`FAQ 예시 ${n}개`);
    } catch (err) {
      ctx.log(`스타터: FAQ 예시 생성 실패 — ${String(err)}`);
    }
  }

  // ── 4. 페이지 ──
  for (const p of [...starterPages(starter.code, ctx.siteName, images), ...policyPages(starter.code, ctx.siteName)]) {
    try {
      await ctx.db.execute(sql`
        INSERT INTO pages (id, slug, title, blocks, plain_text, status, seo, published_at)
        VALUES (${uuidv7()}, ${p.slug}, ${p.title}, ${JSON.stringify(p.blocks)}::jsonb,
                ${p.plainText}, 'published', '{}'::jsonb, now())
        ON CONFLICT (slug) DO NOTHING
      `);
      applied.push(`페이지 ${p.title}`);
    } catch (err) {
      ctx.log(`스타터: 페이지 ${p.slug} 생성 실패 — ${String(err)}`);
    }
  }

  // ── 5. 테마 ──
  // 스타터에 맞는 동봉 테마를 켠다. 운영자가 이미 골라 둔 것이 있으면 건드리지 않는다
  // (설치 직후에는 없지만, 이 함수가 두 번 불려도 안전해야 한다).
  const chosen = ctx.theme && starter.designs?.some((d) => d.theme === ctx.theme) ? ctx.theme : starter.theme;
  if (chosen) {
    try {
      /*
       * 설치가 이미 theme.active = "default" 를 넣어 둔다(스타터는 그 뒤에 돈다).
       * 그래서 "값이 없을 때만"이 아니라 **아직 기본값일 때** 바꾼다 — 운영자가 고른 흔적이
       * 있으면(다른 테마) 건드리지 않는다.
       */
      const { rows: cur } = await ctx.db.execute(sql`SELECT value FROM site_settings WHERE key = 'theme.active' LIMIT 1`);
      const current = cur.length ? String(cur[0].value ?? "") : "";
      if (!current || current === "default") {
        await ctx.db.execute(sql`
          INSERT INTO site_settings (key, value, updated_at)
          VALUES ('theme.active', ${JSON.stringify(chosen)}::jsonb, now())
          ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(chosen)}::jsonb, updated_at = now()
        `);
        applied.push(`테마 ${chosen}`);
      }
    } catch (err) {
      ctx.log(`스타터: 테마 ${chosen} 적용 실패 — ${String(err)}`);
    }
  }

  // ── 6. 메뉴 ──
  // 마지막에 만든다 — 위에서 만든 것들을 가리키므로.
  const menu = starterMenu(starter.code);
  if (menu.length) {
    try {
      // menus.location 에는 유니크 제약이 없으므로 ON CONFLICT 로는 중복을
      // 못 막는다 — 이미 있으면 건드리지 않는다 (운영자가 만든 메뉴를 덮으면
      // 안 된다. 설치는 한 번이지만 방어는 값이 싸다).
      const { rows: existing } = await ctx.db.execute(sql`
        SELECT 1 FROM menus WHERE location = 'header' LIMIT 1
      `);
      if (!existing.length) {
        await ctx.db.execute(sql`
          INSERT INTO menus (id, location, items)
          VALUES (${uuidv7()}, 'header', ${JSON.stringify(menu)}::jsonb)
        `);
        applied.push(`헤더 메뉴 (${menu.length}개 항목)`);
      }
    } catch (err) {
      ctx.log(`스타터: 메뉴 생성 실패 — ${String(err)}`);
    }
  }

  // ── 7. 푸터 메뉴 ──
  // 이용약관 · 개인정보처리방침은 머리 메뉴에 올리지 않지만 **어느 화면에서나 닿아야 한다**(처리방침은 법이 공개를 요구한다)
  const footer = starterFooterMenu(starter.code);
  if (footer.length) {
    try {
      const { rows: existing } = await ctx.db.execute(sql`SELECT 1 FROM menus WHERE location = 'footer' LIMIT 1`);
      if (!existing.length) {
        await ctx.db.execute(sql`
          INSERT INTO menus (id, location, items)
          VALUES (${uuidv7()}, 'footer', ${JSON.stringify(footer)}::jsonb)
        `);
        applied.push(`푸터 메뉴 (${footer.length}개 항목)`);
      }
    } catch (err) {
      ctx.log(`스타터: 푸터 메뉴 생성 실패 — ${String(err)}`);
    }
  }

  return { applied };
}

/** 푸터 메뉴 — 약관과 정책, 그리고 손님이 아래에서 찾는 길(이용 안내·고객센터) */
function starterFooterMenu(code: string): MenuEntry[] {
  if (code !== "community" && code !== "shop" && code !== "company") return [];
  return [
    { label: "이용약관", url: "/terms" },
    { label: "개인정보처리방침", url: "/privacy" },
    ...(code === "shop" ? [{ label: "이용 안내", url: "/guide" }, { label: "고객센터", url: "/help" }] : []),
    ...(code === "company" ? [{ label: "문의하기", url: "/support" }] : []),
  ];
}

/**
 * 이용약관 · 개인정보처리방침 화면.
 *
 * 이용약관은 가입 화면에서만 읽을 수 있었고, **개인정보처리방침은 어디에도 없었다** — 개인정보보호법 제30조는
 * 처리방침을 정해 홈페이지에 공개하라고 정한다. 이용약관 화면은 관리자 → 약관의 그 행을 그린다(core/agreement —
 * 개정하면 그대로 따라간다). 처리방침은 고쳐 쓸 초안이다: 이 시스템이 실제로 받는 항목(회원·주문·문의·접속 기록)과
 * 법정 보관 기간을 채워 두고, 가게만 아는 것([ ] 칸)은 운영자가 채운다. 법률 자문을 대신하지 않는다고 본문에 적는다.
 */
function policyPages(code: string, siteName: string): Array<{ slug: string; title: string; blocks: Node[]; plainText: string }> {
  if (code !== "community" && code !== "shop" && code !== "company") return [];
  const shop = code === "shop";
  const sec = (title: string, ...lines: string[]) => `<h2>${title}</h2>${lines.map((l) => `<p>${l}</p>`).join("")}`;
  const html = [
    `<p><strong>※ 이 문서는 초안입니다.</strong> [ ] 칸을 채우고 실제로 받는 항목에 맞게 고쳐 쓰세요(관리자 → 페이지 → 개인정보처리방침). 법률 자문을 대신하지 않습니다.</p>`,
    `<p>${siteName}(이하 "사이트")는 개인정보 보호법에 따라 이용자의 개인정보를 보호하고 관련 고충을 신속하게 처리하기 위해 다음과 같이 개인정보 처리방침을 둡니다.</p>`,
    sec("1. 처리하는 개인정보의 항목",
      "회원가입: (필수) 이메일, 비밀번호(암호화하여 저장), 닉네임 · (선택) 연락처, 생일, 프로필 사진",
      ...(shop ? ["주문·배송: 주문자 이름·연락처·이메일, 받는 분 이름·연락처·주소, 배송 요청사항 · 결제는 결제대행사가 처리하며 사이트는 카드번호를 저장하지 않습니다"] : []),
      "문의: 이름, 이메일, 문의 내용",
      "자동 수집: 접속 기록, 쿠키(로그인 유지" + (shop ? "·장바구니" : "") + ")"),
    sec("2. 처리 목적",
      "회원 식별과 서비스 제공, 문의 응대, 부정 이용 방지" + (shop ? ", 주문 처리·배송·교환/반품·대금 결제와 환불" : "")),
    sec("3. 보유 및 이용 기간",
      "회원 탈퇴 시 지체 없이 파기합니다. 다만 관계 법령에 따라 보존해야 하는 정보는 그 기간 동안 보관한 뒤 파기합니다.",
      ...(shop ? ["계약 또는 청약철회 등에 관한 기록 · 대금결제 및 재화 등의 공급에 관한 기록: 5년 (전자상거래법)", "소비자의 불만 또는 분쟁처리에 관한 기록: 3년 (전자상거래법)"] : []),
      "웹사이트 방문 기록(로그인 기록): 3개월 (통신비밀보호법)"),
    sec("4. 개인정보의 제3자 제공",
      "이용자의 동의가 있거나 법령에 근거가 있는 경우를 제외하고 개인정보를 제3자에게 제공하지 않습니다. [제공하는 곳이 있다면 받는 자·목적·항목·보유 기간을 적으세요]"),
    sec("5. 개인정보 처리의 위탁",
      shop ? "[예: 결제대행 — ○○페이먼츠(결제 처리) · 배송 — ○○택배(상품 배송) · 문자·알림톡 발송 — ○○(주문 안내)]" : "[위탁하는 업무가 있다면 수탁자와 업무 내용을 적으세요]"),
    sec("6. 파기 절차 및 방법",
      "보유 기간이 끝나거나 처리 목적을 이룬 개인정보는 지체 없이 파기합니다. 전자 파일은 복구할 수 없는 방법으로 지우고, 종이 문서는 분쇄하거나 소각합니다."),
    sec("7. 정보주체의 권리와 행사 방법",
      "이용자는 언제든지 개인정보의 열람·정정·삭제·처리정지를 요구할 수 있습니다. 마이페이지에서 직접 하거나 아래 개인정보 보호책임자에게 요청하면 지체 없이 처리합니다. 회원 탈퇴는 마이페이지에서 할 수 있습니다."),
    sec("8. 안전성 확보 조치",
      "비밀번호의 암호화 저장, 관리자 접근 권한의 최소화, 접속 기록의 보관, 보안 업데이트 적용"),
    sec("9. 쿠키의 설치·운영 및 거부",
      "로그인 상태 유지" + (shop ? "와 장바구니" : "") + "를 위해 쿠키를 씁니다. 브라우저 설정에서 쿠키를 거부할 수 있으나, 그 경우 로그인이 필요한 서비스를 이용하기 어려울 수 있습니다."),
    sec("10. 개인정보 보호책임자",
      "이름: [ ] · 연락처: [ ] · 이메일: [ ]",
      "개인정보 침해에 대한 신고·상담은 개인정보침해신고센터(privacy.kisa.or.kr, 국번 없이 118)에도 할 수 있습니다."),
    sec("11. 시행일", "이 처리방침은 [ ]년 [ ]월 [ ]일부터 적용됩니다."),
  ].join("");
  return [
    { slug: "terms", title: "이용약관", blocks: [{ block: "core/agreement", props: { kind: "terms" } }], plainText: "이용약관" },
    { slug: "privacy", title: "개인정보처리방침", blocks: [{ block: "core/rich-text", props: { html } }], plainText: "개인정보처리방침 개인정보 처리방침" },
  ];
}

/** 고객센터 FAQ 예시 — 손님이 가장 많이 묻는 넷. 질문에 (예시) 를 달아 지울 것을 찾기 쉽게 한다 */
async function seedSampleFaqs(ctx: SeedContext, code: string): Promise<number> {
  const { rows: existing } = await ctx.db.execute(sql`SELECT 1 FROM help_faqs LIMIT 1`);
  if (existing.length) return 0;
  const shop = code === "shop";
  const groups: Array<{ slug: string; name: string; items: Array<[string, string]> }> = [
    ...(shop ? [
      { slug: "delivery", name: "배송", items: [
        ["배송은 얼마나 걸리나요? (예시)", "결제 확인 후 보통 1~3일 안에 받으실 수 있습니다. 주말·공휴일은 제외됩니다. 배송비는 상품 상세의 구매안내를 확인해 주세요."],
        ["주문한 상품이 어디쯤 왔는지 알 수 있나요? (예시)", "발송되면 주문 내역에 운송장 번호가 표시됩니다. 비회원은 맨 위의 주문조회에서 주문번호로 찾을 수 있습니다."],
      ] as Array<[string, string]> },
      { slug: "return", name: "교환·반품", items: [
        ["교환·반품은 언제까지 신청할 수 있나요? (예시)", "상품을 받은 날부터 7일 안에 주문 내역에서 신청할 수 있습니다."],
        ["반품 배송비는 누가 내나요? (예시)", "단순 변심은 손님이, 상품 불량·오배송은 저희가 부담합니다. 금액은 구매안내에 적혀 있습니다."],
      ] as Array<[string, string]> },
      { slug: "payment", name: "결제", items: [
        ["무통장입금은 언제까지 해야 하나요? (예시)", "주문 완료 화면과 안내 메일에 적힌 입금 기한까지 입금해 주세요. 기한이 지나면 주문이 자동으로 취소됩니다."],
      ] as Array<[string, string]> },
    ] : []),
    { slug: "member", name: "회원", items: [
      ["비밀번호를 잊어버렸어요. (예시)", "로그인 화면의 '비밀번호를 잊으셨나요?' 를 누르면 가입한 이메일로 재설정 링크를 보내 드립니다."],
      ["회원 탈퇴는 어떻게 하나요? (예시)", "마이페이지에서 탈퇴할 수 있습니다. 법령에 따라 보관해야 하는 거래 기록을 빼고 개인정보는 지체 없이 파기합니다."],
    ] },
  ];
  let n = 0;
  for (const [gi, g] of groups.entries()) {
    const catId = uuidv7();
    await ctx.db.execute(sql`
      INSERT INTO help_faq_categories (id, name, slug, sort_order) VALUES (${catId}, ${g.name}, ${g.slug}, ${gi})
      ON CONFLICT (slug) DO NOTHING
    `);
    const { rows: cat } = await ctx.db.execute(sql`SELECT id FROM help_faq_categories WHERE slug = ${g.slug} LIMIT 1`);
    for (const [ii, [q, a]] of g.items.entries()) {
      await ctx.db.execute(sql`
        INSERT INTO help_faqs (id, category_id, question, answer, sort_order)
        VALUES (${uuidv7()}, ${String(cat[0]?.id ?? catId)}::uuid, ${q}, ${`<p>${a}</p>`}, ${ii})
      `);
      n++;
    }
  }
  return n;
}

// ════════════════════════════════════════════════════
//  유형별 정의
// ════════════════════════════════════════════════════

function starterBoards(code: string): Array<{
  slug: string; title: string; description: string; readRole: string; writeRole: string;
  /** 목록 스킨 (기본 basic) */
  listStyle?: string;
}> {
  // 공지사항은 모든 유형에 있다 — 없는 사이트가 없다.
  // 쓰기는 manager 다: 공지에 아무나 쓰면 공지가 아니다.
  const notice = {
    slug: "notice", title: "공지사항", description: "사이트 소식을 알립니다.",
    readRole: "guest", writeRole: "manager",
  };
  switch (code) {
    case "community":
      return [
        notice,
        { slug: "free", title: "자유게시판", description: "자유롭게 이야기를 나누는 곳입니다.",
          readRole: "guest", writeRole: "member" },
        { slug: "qna", title: "질문답변", description: "궁금한 것을 묻고 답합니다.",
          readRole: "guest", writeRole: "member" },
        // 갤러리 — 사진이 주인공인 게시판. 목록 스킨이 다른 것을 스타터가 보여준다
        { slug: "gallery", title: "갤러리", description: "사진과 함께 이야기를 남기는 곳입니다.",
          readRole: "guest", writeRole: "member", listStyle: "gallery" },
      ];
    case "shop":
    case "company":
      return [notice];
    default:
      return [];
  }
}

/**
 * 샘플 사진의 URL — 시딩(seedShopSamples)이 채우고 홈 배너가 읽는다(키: 상품 slug · `banner-*` · `promo-*`).
 *
 * 전에는 모듈 전역 변수였다 — 설치를 두 번 부르면(시험) 앞 설치의 주소가 남았다. 이제 설치마다 새로 만든다.
 * 시딩이 실패하면 비어 있고, 그때 배너 블록은 아무것도 그리지 않는다(빈 배너가 보이는 것보다 낫다).
 */
type SampleImages = Record<string, string>;

function starterPages(code: string, siteName: string, img: SampleImages = {}): Array<{
  slug: string; title: string; blocks: Node[]; plainText: string;
}> {
  const p = (text: string): Node => ({ block: "core/paragraph", props: { text } });
  /**
   * 히어로 — **홈의 첫 블록으로 놓는다.** 이때 테마는 페이지 제목 h1 을 그리지
   * 않고 히어로의 제목이 그 자리를 맡는다(이중 제목 방지, page-render 참조).
   * "문단 하나 + 최신글"인 홈은 문서처럼 보인다. 첫 화면이 사이트의 얼굴이다.
   */
  const hero = (props: Record<string, unknown>): Node => ({ block: "core/hero", props });
  const features = (title: string, items: string[]): Node => ({
    block: "core/features",
    props: { title, items: items.join("\n") },
  });
  const faq = (title: string, items: string[]): Node => ({
    block: "core/faq",
    props: { title, items: items.join("\n") },
  });
  const cta = (props: Record<string, unknown>): Node => ({ block: "core/cta", props });

  /**
   * 라우팅 페이지 — 메뉴가 가리키는 주소가 실제로 렌더되게 한다.
   *
   * /board/notice 는 slug "board" 페이지의 board 블록이 pathTail 로
   * 라우팅해야 뜬다. 이 페이지가 없으면 **스타터의 메뉴가 404 를 가리킨다** —
   * 실제로 그랬고, 스모크가 게시판 경로 검증을 우회해서 놓쳤었다.
   */
  const boardRouter = {
    slug: "board",
    title: "게시판",
    blocks: [{ block: "brick-board/board", props: {} }],
    plainText: "게시판",
  };
  const shopRouter = {
    slug: "shop",
    title: "쇼핑몰",
    // storefront 블록이 목록·상세·장바구니·기획전을 URL 로 전환한다
    blocks: [{ block: "brick-shop/storefront", props: {} }],
    plainText: "쇼핑몰 상품",
  };

  /**
   * 소개 페이지 — 모든 유형에 있다.
   *
   * 히어로를 첫 블록으로 두지 않는다: 소개는 제목("소개")이 h1 으로 있는 편이
   * 자연스럽고, 랜딩 얼굴은 홈이 맡는다. 대신 **문단 하나로 끝내지 않는다** —
   * 특징 카드와 FAQ 로 "이런 식으로 채우면 된다"를 보여준다. 빈 페이지보다
   * 고칠 페이지가 낫다.
   */
  const about = {
    slug: "about",
    title: "소개",
    blocks: [
      p(`${siteName}에 오신 것을 환영합니다. 이 문단을 사이트 소개로 바꿔주세요 — 관리자 → 페이지 → 소개 에서 수정할 수 있습니다.`),
      features("우리가 하는 일", [
        "첫 번째 | 무엇을 하는 곳인지 한 줄로 적습니다. | | star",
        "두 번째 | 누구에게 도움이 되는지 적습니다. | | user",
        "세 번째 | 어떻게 하면 되는지 적습니다. | | arrow",
      ]),
      faq("자주 묻는 질문", [
        "회원가입은 어떻게 하나요? | 오른쪽 위 회원가입 버튼을 누르고 이메일을 인증하면 끝입니다.",
        "문의는 어디로 하면 되나요? | 이 문답을 실제 연락처 안내로 바꿔주세요.",
      ]),
    ],
    plainText: `${siteName} 소개 우리가 하는 일 자주 묻는 질문`,
  };

  switch (code) {
    case "community":
      return [
        {
          slug: "home",
          title: siteName,
          blocks: [
            hero({
              eyebrow: "커뮤니티",
              title: siteName,
              text: "이웃과 이야기를 나누는 곳입니다. 이 문구를 사이트 한 줄 소개로 바꿔주세요.",
              ctaLabel: "이야기 둘러보기",
              ctaUrl: "/board/free",
              altLabel: "소개",
              altUrl: "/about",
            }),
            // 스타터가 만든 게시판 세 개를 나란히 — 메인 화면의 완성형을 보여준다
            { block: "brick-board/latest-multi",
              props: { boards: "notice,free,qna", limit: 5, columns: 3 } },
            // 갤러리 게시판을 홈에서는 갤러리 스킨으로 — 사진이 있는 홈이 "문서"와 다르다
            { block: "brick-board/board", props: { board: "gallery", listStyle: "gallery" } },
            cta({
              title: "함께 이야기하실 분을 기다립니다",
              text: "회원가입하면 글과 댓글을 남길 수 있습니다.",
              buttonLabel: "회원가입",
              buttonUrl: "/register",
            }),
          ],
          plainText: `${siteName} 커뮤니티 최신글`,
        },
        about,
        boardRouter,
      ];
    case "shop":
      return [
        {
          slug: "home",
          title: siteName,
          blocks: [
            // "준비 중입니다"는 첫 상품을 등록하는 순간 거짓말이 된다 — 상품
            // 목록 블록이 빈 상태 안내를 스스로 그리므로, 여기는 상품 유무와
            // 무관하게 참인 소개 문구를 둔다 (바꾸라는 힌트 포함).
            /*
             * 쇼핑몰 홈의 첫 화면은 배너다 — 카페24·메이크샵이 그렇고, 계절마다 밀 것이 바뀌기
             * 때문이다. 샘플 상품의 사진을 그대로 써서 **설치 직후에도 빈 배너가 아니게** 한다
             * (사진은 seedShopSamples 가 미디어에 넣는다. 없으면 이 블록은 아무것도 안 그린다).
             */
            {
              block: "core/banner-slider",
              props: {
                items: [
                  `${img["banner-living"] ?? ""} | 머무는 계절, 가을 리빙 | 쿠션·화병·패브릭 신상품을 만나보세요 — 이 배너는 관리자 → 페이지에서 바꿉니다 | /shop?category=living`,
                  `${img["banner-kitchen"] ?? ""} | 매일 쓰는 그릇 | 손에 익는 도자기 식기 컬렉션 | /shop?category=kitchen`,
                  `${img["banner-scent"] ?? ""} | 향으로 기억되는 집 | 소이 향초·디퓨저 최대 20% | /shop?category=fragrance`,
                ].filter((line) => !line.startsWith(" |")).join("\n"),
                height: 520,
                interval: 5,
                full: true,
              },
            },
            // 분류 바로가기 — 첫 화면에서 "무엇을 파는 가게인가" 가 보여야 한다
            { block: "brick-shop/category-list", props: {} },
            { block: "brick-shop/product-list",
              props: { limit: 8, columns: 4, sort: "recent", title: "NEW ARRIVALS", subtitle: "이번 주에 새로 들어온 상품", moreUrl: "/shop?sort=recent" } },
            // 동시에 보여야 하는 기획전은 슬라이드가 아니라 칸으로 나란히 둔다
            { block: "core/promo-banners", props: {
              items: [
                `${img["promo-gift"] ?? ""} | GIFT | 마음을 담은 선물 세트 | /shop | dark`,
                `${img["promo-sale"] ?? ""} | SALE | 시즌 오프, 최대 20% 할인 | /shop?sort=price_asc | light`,
              ].filter((line) => !line.startsWith(" |")).join("\n"),
              ratio: "2/1",
            } },
            // 신상품과 베스트를 나란히 두는 것이 쇼핑몰 홈의 기본 구성이다
            { block: "brick-shop/product-list",
              props: { limit: 4, columns: 4, sort: "popular", title: "BEST SELLER", subtitle: "지금 가장 많이 찾는 상품", moreUrl: "/shop?sort=popular" } },
            features("", [
              "빠른 배송 | 오후 2시 이전 주문은 당일 출발합니다. | | truck",
              "안전한 결제 | 카드·계좌이체·간편결제를 지원합니다. | | shield",
              "7일 내 교환·반품 | 받아보시고 마음에 들지 않으면 보내주세요. | | check",
            ]),
            /*
             * 후기 — **손님이 실제로 남긴 것만.** 예전에는 지어낸 이름과 문장(core/testimonials 예시)이었고,
             * 그대로 문을 열면 거짓 후기가 된다(표시광고법). 후기가 아직 없으면 이 자리는 그려지지 않는다.
             */
            { block: "brick-shop/review-highlights", props: { title: "REVIEW", subtitle: "손님이 직접 남긴 후기", limit: 4 } },
            // 최근 본 상품 — 본 것이 있을 때만 그려진다
            { block: "brick-shop/recent-views", props: { limit: 6 } },
            { block: "brick-board/latest-posts",
              props: { board: "notice", limit: 5, title: "공지사항" } },
          ],
          plainText: `${siteName} 상품 후기`,
        },
        about,
        {
          slug: "guide",
          title: "이용 안내",
          // 이용 안내는 문답 형식이 읽기 쉽다 — 손님은 자기 질문만 펴서 본다
          blocks: [
            {
              block: "core/notice",
              props: {
                tone: "info",
                text: "아래 내용은 예시입니다. 실제 배송·교환 정책으로 바꿔주세요 — 전자상거래법상 표시 의무가 있는 항목입니다.",
              },
            },
            /*
             * 배송비·무료배송 기준·반품 배송비는 **설정에서 그린다** — 글자로 적어 두었더니 "3만원 이상 무료" 라고
             * 쓰여 있는데 설정은 5만원이었다. 상품 상세의 구매 안내와 같은 블록이다.
             */
            { block: "brick-shop/purchase-guide", props: {} },
            faq("주문과 결제", [
              "주문을 취소할 수 있나요? | 상품이 발송되기 전까지는 주문 내역에서 바로 취소할 수 있습니다.",
              "비회원도 주문을 조회할 수 있나요? | 맨 위의 주문조회에서 주문번호로 찾을 수 있습니다.",
              "교환·반품은 어디서 신청하나요? | 주문 내역에서 해당 상품의 교환·반품 신청 버튼을 누르시면 됩니다.",
            ]),
          ],
          plainText: "이용 안내 주문 배송 교환 반품 배송비",
        },
        boardRouter,
        shopRouter,
      ];
    case "company":
      return [
        {
          slug: "home",
          title: siteName,
          blocks: [
            hero({
              eyebrow: siteName,
              title: "고객의 문제를 해결합니다",
              text: `${siteName}의 공식 홈페이지입니다. 이 문구를 회사의 한 줄 소개로 바꿔주세요.`,
              ctaLabel: "문의하기",
              ctaUrl: "/support",
              altLabel: "회사 소개",
              altUrl: "/about",
            }),
            features("주요 서비스", [
              "첫 번째 서비스 | 무엇을 제공하는지 한 줄로 적습니다. | /services | chat",
              "두 번째 서비스 | 어떤 문제를 푸는지 적습니다. | /services | shield",
              "세 번째 서비스 | 왜 우리에게 맡기면 되는지 적습니다. | /services | clock",
            ]),
            { block: "core/stats", props: { items: "2012 | 창립\n1,200+ | 함께한 고객\n98% | 재계약률\n24시간 | 문의 응답" } },
            { block: "core/media-text", props: {
              eyebrow: "우리의 방식",
              title: "문제를 먼저 듣고, 그다음 만듭니다",
              text: "이 자리에 회사 사진을 넣고(관리자 → 미디어) 소개 문단을 적어주세요. 지금 그림은 스타터가 넣은 예시입니다.",
              ctaLabel: "회사 소개", ctaUrl: "/about",
              ...(img.office ? { image: img.office, alt: "작업 공간" } : {}),
            } },
            { block: "brick-board/latest-posts",
              props: { board: "notice", limit: 5, title: "공지사항" } },
            cta({
              title: "도움이 필요하신가요?",
              text: "1:1 문의를 남기시면 담당자가 확인 후 답변드립니다.",
              buttonLabel: "문의 남기기",
              buttonUrl: "/support",
            }),
          ],
          plainText: `${siteName} 홈페이지 주요 서비스`,
        },
        about,
        {
          slug: "services",
          title: "서비스",
          blocks: [
            p("제공하는 서비스를 소개해주세요. 아래 카드는 관리자 → 페이지 → 서비스 에서 한 줄에 하나씩 고칠 수 있습니다."),
            features("", [
              "컨설팅 | 현황을 진단하고 개선 방향을 제안합니다. | | chat",
              "구축 | 필요한 시스템을 만들어 드립니다. | | check",
              "운영 지원 | 만든 뒤에도 함께 돌봅니다. | | shield",
            ]),
            cta({
              title: "어떤 것이 필요한지 아직 모르셔도 됩니다",
              text: "상황을 알려주시면 맞는 방법을 함께 찾습니다.",
              buttonLabel: "문의하기",
              buttonUrl: "/support",
            }),
          ],
          plainText: "서비스 소개 컨설팅 구축 운영 지원",
        },
        {
          slug: "support",
          title: "문의하기",
          blocks: [
            p("궁금한 점을 남겨주시면 답변드립니다."),
            // 1:1 문의 화면 — brick-helpdesk 가 활성화되어 있으면 여기서 접수된다
            { block: "brick-helpdesk/tickets", props: {} },
          ],
          plainText: "문의하기 1:1 문의",
        },
        boardRouter,
      ];
    default:
      return [];
  }
}

interface MenuEntry {
  label: string;
  url: string;
  children?: Array<{ label: string; url: string }>;
}

function starterMenu(code: string): MenuEntry[] {
  switch (code) {
    case "community":
      return [
        { label: "공지사항", url: "/board/notice" },
        { label: "자유게시판", url: "/board/free" },
        { label: "질문답변", url: "/board/qna" },
        { label: "갤러리", url: "/board/gallery" },
        { label: "소개", url: "/about" },
      ];
    case "shop":
      return [
        /*
         * 상품 아래에 하위 메뉴를 미리 만들어 둔다 — **2단 메뉴가 있다는 것을 보여 주려고**다.
         * 관리자 → 메뉴에서 "하위 추가"가 있는 줄 모르면 분류가 늘어도 한 줄에 계속 붙인다.
         * 링크는 정렬 파라미터라 분류를 안 만들어도 동작한다(빈 하위 메뉴가 아니다).
         */
        {
          label: "상품",
          url: "/shop",
          children: [
            { label: "전체 상품", url: "/shop" },
            { label: "새로 나온 상품", url: "/shop?sort=recent" },
            { label: "인기 상품", url: "/shop?sort=popular" },
            // 샘플 분류 — 분류를 지우면 이 줄도 관리자 → 메뉴에서 지운다
            ...SHOP_CATEGORIES.map((c) => ({ label: c.name, url: `/shop?category=${c.slug}` })),
          ],
        },
        { label: "신상품", url: "/shop?sort=recent" },
        { label: "베스트", url: "/shop?sort=popular" },
        { label: "공지사항", url: "/board/notice" },
        { label: "고객센터", url: "/help" },
      ];
    case "company":
      return [
        { label: "회사 소개", url: "/about" },
        { label: "서비스", url: "/services" },
        { label: "공지사항", url: "/board/notice" },
        { label: "문의하기", url: "/support" },
      ];
    default:
      return [];
  }
}

/**
 * 쇼핑몰 샘플 — 분류 셋 · 상품 여덟 · 배너 셋 · 기획전 둘.
 *
 * 여덟 개인 이유: 4열 격자가 두 줄 찬다. 셋일 때는 한 줄도 다 차지 않아 테마가 어떻게 보일지 판단할 수 없었다.
 * 할인(정가·판매가)·품절·NEW 표시가 한 화면에서 모두 보이게 섞는다. 이름에 "(샘플)" 을 달아 지울 것을 찾기 쉽게 한다.
 *
 * 사진은 테마 자산을 가리키지 않는다(테마를 바꾸면 깨진다) — **미디어에 실제로 넣는다.**
 * 그러면 미디어 화면에도 보이고, 지우는 방법이 다른 사진과 같다. 그림은 sample-art.ts.
 */
async function seedShopSamples(ctx: SeedContext, images: SampleImages): Promise<number> {
  const { rows: existing } = await ctx.db.execute(sql`SELECT 1 FROM shop_products LIMIT 1`);
  if (existing.length) return 0; // 이미 상품이 있으면 건드리지 않는다

  // 분류 — 홈의 분류 바로가기와 상품 목록의 왼쪽 레일이 이것을 쓴다
  const categories = SHOP_CATEGORIES;
  const categoryId: Record<string, string> = {};
  for (const [i, c] of categories.entries()) {
    const id = uuidv7();
    const { rows } = await ctx.db.execute(sql`
      INSERT INTO shop_categories (id, slug, name, sort_order)
      VALUES (${id}, ${c.slug}, ${c.name}, ${i})
      ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
      RETURNING id
    `);
    categoryId[c.slug] = String(rows[0]?.id ?? id);
  }

  const samples = [
    { slug: "sample-mug", art: "mug", category: "kitchen", name: "무광 스톤 머그 (샘플)", price: 12000, listPrice: 15000, stock: 40,
      summary: "손에 감기는 두께의 무광 머그. 350ml." },
    { slug: "sample-plate", art: "plate", category: "kitchen", name: "세라믹 식기 3종 세트 (샘플)", price: 32000, listPrice: null, stock: 25,
      summary: "접시 둘과 볼 하나, 전자레인지 사용 가능." },
    { slug: "sample-board", art: "board", category: "kitchen", name: "원목 커팅보드 (샘플)", price: 24000, listPrice: 29000, stock: 18,
      summary: "통원목 월넛, 서빙 플레이트로도." },
    { slug: "sample-tote", art: "tote", category: "living", name: "캔버스 토트백 (샘플)", price: 28000, listPrice: null, stock: 12,
      summary: "무게를 견디는 12온스 캔버스." },
    { slug: "sample-cushion", art: "cushion", category: "living", name: "린넨 쿠션 커버 (샘플)", price: 22000, listPrice: null, stock: 30,
      summary: "워싱 린넨 100%, 45×45cm." },
    { slug: "sample-vase", art: "vase", category: "living", name: "세라믹 화병 (샘플)", price: 36000, listPrice: 42000, stock: 8,
      summary: "손으로 빚은 둥근 화병. 드라이플라워 포함." },
    { slug: "sample-candle", art: "candle", category: "fragrance", name: "소이 향초 (샘플)", price: 19000, listPrice: 24000, stock: 0,
      summary: "삼나무와 마른 풀 향. 40시간." },
    { slug: "sample-diffuser", art: "diffuser", category: "fragrance", name: "리드 디퓨저 (샘플)", price: 27000, listPrice: null, stock: 22,
      summary: "숲속 이끼 향, 200ml · 약 3개월." },
  ];

  // 상품 설명은 HTML 이다 — 마크다운을 쓰면 별표가 그대로 보인다(실제로 그랬다)
  const body =
    "<p>이 상품은 <strong>스타터가 넣은 샘플</strong>입니다. 관리자 → 상품에서 수정하거나 지우세요.</p>" +
    "<p>사진도 미디어에 함께 들어가 있습니다 — 실제 상품 사진을 올리면 그대로 바뀝니다.</p>";

  let count = 0;
  for (const [i, p] of samples.entries()) {
    const added = (await ctx.addSampleImage?.(`${p.slug}.jpg`, PRODUCT_ART[p.art]!())) ?? null;
    if (added) images[p.slug] = added.url;
    await ctx.db.execute(sql`
      INSERT INTO shop_products
        (id, slug, name, summary, description, image_url, thumb_url, price, list_price, stock, status, sort_order, category_id)
      VALUES
        (${uuidv7()}, ${p.slug}, ${p.name}, ${p.summary}, ${body}, ${added?.url ?? null}, ${added?.thumbUrl ?? null},
         ${p.price}, ${p.listPrice}, ${p.stock},
         ${p.stock === 0 ? "soldout" : "selling"}, ${i}, ${categoryId[p.category] ?? null}::uuid)
      ON CONFLICT (slug) DO NOTHING
    `);
    count++;
  }

  // 배너·기획전 그림 — 상품이 아니라 홈 페이지가 쓴다
  for (const [key, draw] of Object.entries(BANNER_ART)) {
    const added = await ctx.addSampleImage?.(`banner-${key}.jpg`, draw(), { width: 1920, height: 720 });
    if (added) images[`banner-${key}`] = added.url;
  }
  for (const [key, draw] of Object.entries(PROMO_ART)) {
    const added = await ctx.addSampleImage?.(`promo-${key}.jpg`, draw(), { width: 960, height: 480 });
    if (added) images[`promo-${key}`] = added.url;
  }
  return count;
}

/**
 * 예시 글 — 유형마다 홈의 최신글 위젯이 비지 않을 만큼만.
 *
 * 쓰는 이는 설치한 관리자다(비회원·가짜 회원을 만들지 않는다 — 탈퇴·개인정보 파기 대상이 늘어난다). 제목에 "(예시)" 를
 * 달고 본문 끝에 지우는 곳을 적어, 실제 운영에 앞서 찾아 지우기 쉽게 한다. 날짜는 며칠에 걸쳐 흩어 목록 순서가 자연스럽게.
 * 스레드 칸은 게시판이 글을 쓸 때와 같게 채운다(thread_id = 자기 id, thread_path 비움, depth 0).
 */
async function seedSamplePosts(ctx: SeedContext, code: string, img: SampleImages): Promise<number> {
  const { rows: admins } = await ctx.db.execute(sql`
    SELECT id, display_name FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1
  `);
  const admin = admins[0];
  if (!admin) return 0;
  const note = `<p><small>스타터가 넣은 예시 글입니다. 관리자 → 게시판에서 지우거나 고치세요.</small></p>`;
  const p = (...lines: string[]) => lines.map((l) => `<p>${l}</p>`).join("") + note;
  const picture = (key: string, alt: string) => (img[key] ? `<p><img src="${img[key]}" alt="${alt}" /></p>` : "");

  type Sample = { board: string; title: string; content: string; notice?: boolean; daysAgo: number; answer?: string };
  const notice = (title: string, content: string, daysAgo: number): Sample => ({ board: "notice", title, content, notice: true, daysAgo });
  const posts: Sample[] =
    code === "community" ? [
      notice("커뮤니티를 열었습니다 (예시)", p("이웃과 이야기를 나누는 공간을 열었습니다.", "처음 오셨다면 자유게시판에 가입 인사를 남겨 주세요."), 6),
      { board: "free", title: "가입 인사 드립니다 (예시)", content: p("오늘 가입했습니다. 잘 부탁드립니다!"), daysAgo: 5 },
      { board: "free", title: "주말 산책 코스 추천해요 (예시)", content: p("강변 따라 걷는 길이 한 시간 정도 걸리는데, 해 질 녘이 가장 좋습니다."), daysAgo: 3 },
      { board: "free", title: "요즘 읽는 책 이야기 (예시)", content: p("짧은 소설집을 읽고 있는데 출퇴근길에 한 편씩 읽기 좋네요."), daysAgo: 1 },
      { board: "qna", title: "알림은 어디서 보나요? (예시)", content: p("댓글이 달리면 어디서 확인할 수 있나요?"), daysAgo: 4,
        answer: "머리의 종 모양(알림)을 누르면 모아 볼 수 있습니다. 메일로도 함께 보내 드립니다." },
      { board: "qna", title: "프로필 사진을 바꾸고 싶어요 (예시)", content: p("회원 정보에서 사진을 바꿀 수 있나요?"), daysAgo: 2,
        answer: "회원 정보(내 정보)에서 사진을 올리면 바로 바뀝니다." },
      { board: "gallery", title: "새벽 산 (예시)", content: picture("gallery-mountain", "새벽 산") + p("해 뜨기 전 능선."), daysAgo: 6 },
      { board: "gallery", title: "여름 바다 (예시)", content: picture("gallery-sea", "여름 바다") + p("돛단배가 지나가던 오후."), daysAgo: 4 },
      { board: "gallery", title: "도시의 밤 (예시)", content: picture("gallery-city", "도시의 밤") + p("퇴근길 창밖."), daysAgo: 2 },
      { board: "gallery", title: "가을 숲 (예시)", content: picture("gallery-forest", "가을 숲") + p("단풍이 한창입니다."), daysAgo: 1 },
    ]
    : code === "shop" ? [
      notice("배송 안내 (예시)", p("오후 2시 이전 주문은 당일 출발합니다. 주말·공휴일 주문은 다음 영업일에 보냅니다."), 3),
      notice("오픈 기념 이벤트 (예시)", p("오픈을 기념해 첫 주문에 쓸 수 있는 쿠폰을 드립니다. 실제 이벤트로 바꿔 주세요."), 1),
    ]
    : code === "company" ? [
      notice("홈페이지를 새로 열었습니다 (예시)", p("회사 소식과 서비스 안내를 이곳에서 전해 드립니다."), 4),
      notice("고객센터 운영 시간 안내 (예시)", p("평일 오전 9시부터 오후 6시까지 운영합니다. 1:1 문의는 언제든 남겨 주세요."), 1),
    ]
    : [];
  if (!posts.length) return 0;

  const { rows: boards } = await ctx.db.execute(sql`SELECT id, slug FROM board_boards`);
  const boardId = new Map(boards.map((b) => [String(b.slug), String(b.id)]));
  let count = 0;
  for (const post of posts) {
    const bid = boardId.get(post.board);
    if (!bid) continue;
    const id = uuidv7();
    const thumb = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(post.content)?.[1] ?? null;
    const at = sql`now() - make_interval(days => ${post.daysAgo}, hours => ${(count * 7) % 24})`;
    await ctx.db.execute(sql`
      INSERT INTO board_posts
        (id, board_id, author_id, author_name, title, content, is_notice, thread_id, thread_created_at, thread_path, depth,
         thumb_url, created_at, updated_at)
      VALUES
        (${id}, ${bid}::uuid, ${String(admin.id)}::uuid, ${String(admin.display_name)}, ${post.title}, ${post.content},
         ${Boolean(post.notice)}, ${id}::uuid, ${at}, '', 0, ${thumb}, ${at}, ${at})
    `);
    if (post.answer) {
      await ctx.db.execute(sql`
        INSERT INTO board_comments (id, post_id, author_id, author_name, content, created_at)
        VALUES (${uuidv7()}, ${id}::uuid, ${String(admin.id)}::uuid, ${String(admin.display_name)}, ${post.answer}, ${at} + interval '2 hours')
      `);
      await ctx.db.execute(sql`UPDATE board_posts SET comment_count = 1 WHERE id = ${id}::uuid`);
    }
    count++;
  }
  return count;
}

