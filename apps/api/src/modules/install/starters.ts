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
}

/**
 * 스타터 목록.
 *
 * 유형은 셋이면 충분하다. 선택지가 많을수록 고르다 지친다 — 설치 화면에서
 * 필요한 것은 "대충 이 방향"이고, 세부는 나중에 바꾼다.
 */
export const STARTERS: StarterDefinition[] = [
  {
    code: "community",
    label: "커뮤니티",
    description: "공지사항·자유게시판·질문답변을 갖춘 게시판 중심 사이트",
    plugins: ["brick-board"],
    creates: ["홈 (최신글 모아보기)", "소개 페이지", "게시판 3개", "헤더 메뉴"],
  },
  {
    code: "shop",
    label: "쇼핑몰",
    description: "상품 목록·장바구니·공지사항을 갖춘 판매 사이트",
    plugins: ["brick-board", "brick-shop"],
    creates: ["홈 (상품 목록 + 공지)", "소개 페이지", "공지사항 게시판", "쇼핑몰 메뉴"],
  },
  {
    code: "company",
    label: "회사 홈페이지",
    description: "회사 소개·서비스 안내·공지·1:1 문의를 갖춘 안내 사이트",
    plugins: ["brick-board", "brick-helpdesk"],
    creates: ["홈", "회사 소개 · 서비스 페이지", "공지사항 게시판", "1:1 문의", "헤더 메뉴"],
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
  /** 플러그인 활성화 — loader.activate 를 주입받는다 (순환 의존을 피한다) */
  activatePlugin: (name: string) => Promise<void>;
  log: (message: string) => void;
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
        INSERT INTO board_boards (id, slug, title, description, read_role, write_role)
        VALUES (${uuidv7()}, ${b.slug}, ${b.title}, ${b.description},
                ${b.readRole}, ${b.writeRole})
        ON CONFLICT (slug) DO NOTHING
      `);
      applied.push(`게시판 ${b.title}`);
    } catch (err) {
      ctx.log(`스타터: 게시판 ${b.slug} 생성 실패 — ${String(err)}`);
    }
  }

  // ── 3. 페이지 ──
  for (const p of starterPages(starter.code, ctx.siteName)) {
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

  // ── 4. 메뉴 ──
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

  return { applied };
}

// ════════════════════════════════════════════════════
//  유형별 정의
// ════════════════════════════════════════════════════

function starterBoards(code: string): Array<{
  slug: string; title: string; description: string; readRole: string; writeRole: string;
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
      ];
    case "shop":
    case "company":
      return [notice];
    default:
      return [];
  }
}

function starterPages(code: string, siteName: string): Array<{
  slug: string; title: string; blocks: Node[]; plainText: string;
}> {
  const h = (text: string, level = 1): Node => ({ block: "core/heading", props: { text, level } });
  const p = (text: string): Node => ({ block: "core/paragraph", props: { text } });
  const spacer = (): Node => ({ block: "core/spacer", props: {} });

  // 소개 페이지 — 모든 유형에 있다. 자리표시 문구는 실제로 쓸 법한 예문으로.
  const about = {
    slug: "about",
    title: "소개",
    blocks: [
      h(`${siteName} 소개`),
      p(`${siteName}에 오신 것을 환영합니다. 이 문단을 사이트 소개로 바꿔주세요 — 관리자 → 페이지 → 소개 에서 수정할 수 있습니다.`),
    ],
    plainText: `${siteName} 소개`,
  };

  switch (code) {
    case "community":
      return [
        {
          slug: "home",
          title: "홈",
          blocks: [
            h(siteName),
            p("커뮤니티에 오신 것을 환영합니다. 아래는 게시판의 최신 글입니다."),
            spacer(),
            // 스타터가 만든 게시판 세 개를 나란히 — 메인 화면의 완성형을 보여준다
            { block: "brick-board/latest-multi",
              props: { boards: "notice,free,qna", limit: 5, columns: 3 } },
          ],
          plainText: `${siteName} 커뮤니티 최신글`,
        },
        about,
      ];
    case "shop":
      return [
        {
          slug: "home",
          title: "홈",
          blocks: [
            h(siteName),
            p("상품을 준비 중입니다. 관리자 → 쇼핑몰 → 상품 에서 첫 상품을 등록해보세요."),
            spacer(),
            { block: "brick-shop/product-list",
              props: { limit: 8, columns: 4, sort: "recent", title: "새로 나온 상품" } },
            spacer(),
            { block: "brick-board/latest-posts",
              props: { board: "notice", limit: 5, title: "공지사항" } },
          ],
          plainText: `${siteName} 상품`,
        },
        about,
        {
          slug: "guide",
          title: "이용 안내",
          blocks: [
            h("이용 안내"),
            h("주문과 배송", 2),
            p("주문 후 2~3일 안에 배송됩니다. 이 내용을 실제 배송 정책으로 바꿔주세요."),
            h("교환과 반품", 2),
            p("상품 수령 후 7일 이내에 신청할 수 있습니다. 단순 변심은 왕복 배송비가 발생합니다."),
          ],
          plainText: "이용 안내 주문 배송 교환 반품",
        },
      ];
    case "company":
      return [
        {
          slug: "home",
          title: "홈",
          blocks: [
            h(siteName),
            p(`${siteName}의 공식 홈페이지입니다. 이 문단을 회사의 한 줄 소개로 바꿔주세요.`),
            spacer(),
            { block: "brick-board/latest-posts",
              props: { board: "notice", limit: 5, title: "공지사항" } },
          ],
          plainText: `${siteName} 홈페이지`,
        },
        about,
        {
          slug: "services",
          title: "서비스",
          blocks: [
            h("서비스"),
            p("제공하는 서비스를 소개해주세요. 항목이 여럿이면 단 나누기 블록이 어울립니다."),
          ],
          plainText: "서비스 소개",
        },
        {
          slug: "support",
          title: "문의하기",
          blocks: [
            h("문의하기"),
            p("궁금한 점을 남겨주시면 답변드립니다."),
            // 1:1 문의 화면 — brick-helpdesk 가 활성화되어 있으면 여기서 접수된다
            { block: "brick-helpdesk/tickets", props: {} },
          ],
          plainText: "문의하기 1:1 문의",
        },
      ];
    default:
      return [];
  }
}

function starterMenu(code: string): Array<{ label: string; url: string }> {
  switch (code) {
    case "community":
      return [
        { label: "공지사항", url: "/board/notice" },
        { label: "자유게시판", url: "/board/free" },
        { label: "질문답변", url: "/board/qna" },
        { label: "소개", url: "/about" },
      ];
    case "shop":
      return [
        { label: "상품", url: "/shop" },
        { label: "공지사항", url: "/board/notice" },
        { label: "이용 안내", url: "/guide" },
        { label: "소개", url: "/about" },
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
