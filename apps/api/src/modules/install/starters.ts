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
  /**
   * 이 스타터에 맞는 동봉 테마. 없으면 기본 테마(default).
   *
   * 테마를 만들어 두고 스타터가 고르지 않으면 아무 의미가 없다 — 쇼핑몰을 골랐는데 커뮤니티
   * 레이아웃이 나오면 "테마를 바꿔야 한다"는 것 자체를 모른다. 운영자는 나중에 관리자 →
   * 테마에서 얼마든지 바꿀 수 있다(미리보기로 비교하고).
   */
  theme?: string;
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
    creates: ["홈 (최신글 모아보기 · 갤러리)", "소개 페이지", "게시판 4개 (갤러리 포함)", "헤더 메뉴"],
  },
  {
    code: "shop",
    label: "쇼핑몰",
    description: "상품 목록·장바구니·공지사항을 갖춘 판매 사이트",
    plugins: ["brick-board", "brick-shop"],
    creates: ["홈 (상품 목록 + 공지)", "소개 페이지", "공지사항 게시판", "쇼핑몰 메뉴"],
    theme: "storefront",
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
  /** 플러그인 활성화 — loader.activate 를 주입받는다 (순환 의존을 피한다) */
  activatePlugin: (name: string) => Promise<void>;
  log: (message: string) => void;
  /**
   * 샘플 이미지를 미디어에 넣는다 — 실제 업로드와 같은 경로를 쓰므로 미디어 화면에도
   * 보이고 운영자가 지울 수 있다. 이미지 처리(sharp)를 못 쓰면 null 을 돌려준다.
   */
  addSampleImage?: (name: string, svg: string) => Promise<string | null>;
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
  // 페이지보다 먼저다 — 홈 배너가 샘플 사진의 URL 을 쓴다(SAMPLE_IMG).
  // 쇼핑몰을 골랐는데 진열대가 비어 있으면 "무엇이 잘못됐나" 부터 의심하게 된다.
  // 카페24·그누보드가 샘플 상품을 넣는 이유다 — 이름에 (샘플) 을 달아 지우기 쉽게 한다.
  if (starter.code === "shop") {
    try {
      const seeded = await seedShopSamples(ctx);
      if (seeded) applied.push(`샘플 상품 ${seeded}개`);
    } catch (err) {
      ctx.log(`스타터: 샘플 상품 생성 실패 — ${String(err)}`);
    }
  }

  // ── 4. 페이지 ──
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

  // ── 5. 테마 ──
  // 스타터에 맞는 동봉 테마를 켠다. 운영자가 이미 골라 둔 것이 있으면 건드리지 않는다
  // (설치 직후에는 없지만, 이 함수가 두 번 불려도 안전해야 한다).
  if (starter.theme) {
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
          VALUES ('theme.active', ${JSON.stringify(starter.theme)}::jsonb, now())
          ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(starter.theme)}::jsonb, updated_at = now()
        `);
        applied.push(`테마 ${starter.theme}`);
      }
    } catch (err) {
      ctx.log(`스타터: 테마 ${starter.theme} 적용 실패 — ${String(err)}`);
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

  return { applied };
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
 * 샘플 상품 사진의 URL — 시딩(seedShopSamples)이 채우고 홈 배너가 읽는다.
 *
 * 페이지 생성이 시딩보다 먼저라면 비어 있고, 그때 배너 블록은 아무것도 그리지 않는다
 * (빈 배너가 보이는 것보다 낫다). 그래서 applyStarter 에서 상품 시딩을 페이지보다 앞에 둔다.
 */
const SAMPLE_IMG: { mug: string; tote: string; candle: string } = { mug: "", tote: "", candle: "" };

function starterPages(code: string, siteName: string): Array<{
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
                  `${SAMPLE_IMG.mug} | ${siteName} | 이 배너를 계절 상품이나 이벤트로 바꿔주세요 | /shop`,
                  `${SAMPLE_IMG.tote} | 새로 들어온 물건 | 관리자 → 페이지 에서 배너를 고칩니다 | /shop`,
                ].join("\n"),
                height: 420,
                interval: 5,
                full: true,
              },
            },
            { block: "brick-shop/product-list",
              props: { limit: 8, columns: 4, sort: "recent", title: "새로 나온 상품" } },
            // 신상품과 베스트를 나란히 두는 것이 쇼핑몰 홈의 기본 구성이다
            { block: "brick-shop/product-list",
              props: { limit: 4, columns: 4, sort: "popular", title: "인기 상품" } },
            features("", [
              "빠른 배송 | 오후 2시 이전 주문은 당일 출발합니다. | | truck",
              "안전한 결제 | 카드·계좌이체·간편결제를 지원합니다. | | shield",
              "7일 내 교환·반품 | 받아보시고 마음에 들지 않으면 보내주세요. | | check",
            ]),
            { block: "core/testimonials", props: {
              title: "먼저 써 본 분들의 이야기",
              items: [
                "포장이 꼼꼼하고 배송이 빨랐어요. 재구매 의사 있습니다. | 김민수 | 서울",
                "문의에 답이 빨라서 믿고 살 수 있었어요. | 이서연 | 부산",
                "사진보다 실물이 더 좋았습니다. | 박지훈 | 대구",
              ].join("\n"),
            } },
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
            faq("주문과 배송", [
              "배송은 얼마나 걸리나요? | 주문 후 2~3일 안에 받으실 수 있습니다. 주말과 공휴일은 제외됩니다.",
              "배송비는 얼마인가요? | 3만원 이상 주문은 무료, 그 미만은 3,000원입니다.",
              "주문을 취소할 수 있나요? | 상품이 발송되기 전까지는 주문 내역에서 바로 취소할 수 있습니다.",
            ]),
            faq("교환과 반품", [
              "언제까지 신청할 수 있나요? | 상품을 받은 날부터 7일 이내입니다.",
              "배송비는 누가 내나요? | 단순 변심은 왕복 배송비를 손님이, 상품 하자나 오배송은 저희가 부담합니다.",
              "어디서 신청하나요? | 주문 내역에서 해당 상품의 교환·반품 신청 버튼을 누르시면 됩니다.",
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
              text: "이 자리에 회사 사진을 넣고(관리자 → 미디어) 소개 문단을 적어주세요. 이미지가 없으면 글만 보입니다.",
              ctaLabel: "회사 소개", ctaUrl: "/about",
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

function starterMenu(code: string): Array<{ label: string; url: string }> {
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

/**
 * 쇼핑몰 샘플 상품.
 *
 * 세 개만 넣는다 — 격자가 어떻게 보이는지, 할인 표시(정가·판매가)와 품절이 어떻게
 * 그려지는지 한 화면에서 보이는 최소한이다. 이름에 "(샘플)" 을 달아 운영자가 지울
 * 것을 찾기 쉽게 하고, 설명에 무엇을 하면 되는지 적는다.
 *
 * 사진은 테마 자산을 가리키지 않는다(테마를 바꾸면 깨진다) — **미디어에 실제로 넣는다.**
 * 그러면 미디어 화면에도 보이고, 지우는 방법이 다른 사진과 같다.
 */
async function seedShopSamples(ctx: SeedContext): Promise<number> {
  const { rows: existing } = await ctx.db.execute(sql`SELECT 1 FROM shop_products LIMIT 1`);
  if (existing.length) return 0; // 이미 상품이 있으면 건드리지 않는다

  const samples = [
    { slug: "sample-mug", name: "머그컵 (샘플)", price: 12000, listPrice: 15000, stock: 40,
      summary: "손에 감기는 두께의 무광 머그.", from: "#e8e2d8", to: "#c9bfae" },
    { slug: "sample-tote", name: "캔버스 토트백 (샘플)", price: 28000, listPrice: null, stock: 12,
      summary: "무게를 견디는 12온스 캔버스.", from: "#dfe4ea", to: "#b8c1cc" },
    { slug: "sample-candle", name: "향초 (샘플)", price: 19000, listPrice: 24000, stock: 0,
      summary: "삼나무와 마른 풀 향. 40시간.", from: "#efe3df", to: "#d3b8ae" },
  ];

  // 상품 설명은 HTML 이다 — 마크다운을 쓰면 별표가 그대로 보인다(실제로 그랬다)
  const body =
    "<p>이 상품은 <strong>스타터가 넣은 샘플</strong>입니다. 관리자 → 상품에서 수정하거나 지우세요.</p>" +
    "<p>사진도 미디어에 함께 들어가 있습니다 — 실제 상품 사진을 올리면 그대로 바뀝니다.</p>";

  let count = 0;
  for (const [i, p] of samples.entries()) {
    // 사진 자리를 비워 두면 격자가 회색 네모로 보인다 — 상품마다 다른 색의 카드를 만들어 둔다
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${p.from}"/><stop offset="1" stop-color="${p.to}"/></linearGradient></defs>` +
      `<rect width="1000" height="1000" fill="url(#g)"/></svg>`;
    const imageUrl = (await ctx.addSampleImage?.(`${p.slug}.jpg`, svg)) ?? null;
    // 홈 배너가 이 사진을 쓴다 (아래 페이지 생성 단계에서 읽는다)
    if (imageUrl) {
      if (p.slug === "sample-mug") SAMPLE_IMG.mug = imageUrl;
      if (p.slug === "sample-tote") SAMPLE_IMG.tote = imageUrl;
      if (p.slug === "sample-candle") SAMPLE_IMG.candle = imageUrl;
    }

    await ctx.db.execute(sql`
      INSERT INTO shop_products
        (id, slug, name, summary, description, image_url, price, list_price, stock, status, sort_order)
      VALUES
        (${uuidv7()}, ${p.slug}, ${p.name}, ${p.summary}, ${body}, ${imageUrl},
         ${p.price}, ${p.listPrice}, ${p.stock},
         ${p.stock === 0 ? "soldout" : "selling"}, ${i})
      ON CONFLICT (slug) DO NOTHING
    `);
    count++;
  }
  return count;
}
