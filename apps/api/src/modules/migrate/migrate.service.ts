import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import { detectPrefix, parseTables, readRows, type DumpRow, type DumpTable } from "./dump-parser.js";
import {
  DEFAULT_LEVEL_MAPPING, boardLevelToRole, convertContent, gnuAttachmentKey, gnuExtraFields,
  gnuExtraValues, gnuLinks, guessContentType, levelToRole, normalizeEmail,
  normalizeSlug, parseGnuDate, rewriteLegacyMediaUrls, wrapLegacyHash,
  type LevelMapping, type MigratePlan,
} from "./gnuboard-map.js";
import {
  YC_TABLES, address, categoryParentId, categorySlug, hasYoungcart, itemImages,
  itemSlug, itemStatus, orderStatus, parseItemOption, paymentMethod, postcode,
} from "./youngcart-map.js";

/**
 * 그누보드5 → Brick 데이터 이전.
 *
 * 설계에서 가장 중요한 것: **리허설이 먼저다.**
 * 이전은 되돌리기 어렵다. 회원 이메일이 겹치거나 레벨 매핑이 어긋나면
 * "관리자였던 사람이 일반 회원이 되는" 결과가 조용히 만들어진다.
 * 그래서 analyze() 가 무엇이 몇 건 옮겨지고 무엇이 안 옮겨지는지 먼저 보고한다.
 *
 * 두 번째로 중요한 것: **비밀번호를 보존한다.**
 * 이전 후 전원이 비밀번호를 다시 만들어야 하면 상당수가 돌아오지 않는다.
 * 원본 해시를 그대로 저장하고, 첫 로그인에 성공하면 argon2 로 승급한다
 * (apps/api/src/modules/auth/legacy-hash.ts).
 */

export interface AnalyzeResult {
  /** 감지한 테이블 접두어 (g5_ 등) */
  prefix: string;
  /** 덤프에서 찾은 테이블 수 */
  tableCount: number;
  members: { total: number; withEmail: number; withoutEmail: number; conflicts: string[] };
  /** 레벨 분포 → 어떤 역할로 접히는지 */
  levels: Array<{ level: number; count: number; role: string }>;
  boards: Array<{
    table: string;
    slug: string;
    title: string;
    posts: number;
    comments: number;
    readRole: string;
    writeRole: string;
    /** 게시글 테이블이 덤프에 있는가 */
    hasData: boolean;
  }>;
  points: { members: number; total: number };
  /**
   * 영카트(쇼핑몰) — 덤프에 있으면 채워진다.
   * 없으면 null 이고, 화면은 쇼핑몰 절을 감춘다.
   */
  shop: {
    categories: number;
    products: number;
    /** 판매중 · 품절 · 숨김 분포 */
    productStatus: Record<string, number>;
    options: number;
    orders: number;
    orderItems: number;
    /** 주문 상태 분포 → Brick 상태로 어떻게 접히는지 */
    orderStatus: Array<{ from: string; to: string; count: number }>;
    revenue: number;
  } | null;
  /** 옮겨지지 않는 것 — 미리 알려야 한다 */
  skipped: string[];
  warnings: string[];
}

export interface RunResult {
  members: { created: number; skipped: number };
  boards: { created: number; skipped: number };
  posts: { created: number };
  comments: { created: number };
  /** 첨부파일 · 게시판 그룹 · 내용관리(페이지) */
  attachments: { created: number };
  groups: { created: number };
  contents: { created: number };
  /** 추천 기록 · 위시리스트 */
  votes: { created: number };
  wishlist: { created: number };
  points: { granted: number; total: number };
  shop: {
    categories: number;
    products: number;
    options: number;
    orders: number;
    orderItems: number;
    skipped: number;
  };
  warnings: string[];
  durationMs: number;
}

/** 한 번에 INSERT 하는 행 수 — 너무 크면 파라미터 한도에 걸린다 */
const BATCH = 200;

@Injectable()
export class MigrateService {
  private readonly log = new Logger("Migrate");

  constructor(
    @Inject(DB) private readonly db: BrickDb,
    private readonly plugins: PluginLoaderService,
  ) {}

  /**
   * 리허설 — 아무것도 쓰지 않고 무엇이 옮겨질지 보고한다.
   *
   * 사용자가 조정해야 하는 것을 드러내는 것이 목적이다:
   *  - 레벨 매핑이 맞는가 (관리자가 몇 명이 되는가)
   *  - 이메일이 겹치는 회원이 있는가
   *  - 게시판 권한이 어떻게 접히는가
   */
  async analyze(dump: string, mapping: LevelMapping = DEFAULT_LEVEL_MAPPING): Promise<AnalyzeResult> {
    // 설치 전에는 users 테이블이 없다. 이전 도구를 먼저 실행하는 사람이 있으므로
    // SQL 오류를 그대로 던지지 않고 무엇을 해야 하는지 알려준다.
    if (!(await this.tableExists("users"))) {
      throw new BadRequestException(
        "사이트를 먼저 설치해주세요. 이전은 설치가 끝난 Brick 에 데이터를 넣는 작업입니다.",
      );
    }

    const tables = parseTables(dump);
    if (!tables.size) {
      throw new BadRequestException(
        "덤프에서 CREATE TABLE 을 찾지 못했습니다. mysqldump 로 만든 SQL 파일인지 확인해주세요.",
      );
    }
    const prefix = detectPrefix(tables);
    if (!tables.has(`${prefix}member`)) {
      throw new BadRequestException(
        "그누보드 회원 테이블(member)을 찾지 못했습니다. 그누보드5 덤프가 맞는지 확인해주세요.",
      );
    }

    const skipped: string[] = [];
    const warnings: string[] = [];

    // ── 회원 ──
    const levelCounts = new Map<number, number>();
    let total = 0;
    let withEmail = 0;
    const emails = new Map<string, number>();
    for (const row of readRows(dump, `${prefix}member`, tables)) {
      total += 1;
      const level = Number(row.mb_level ?? 1) || 1;
      levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
      const raw = String(row.mb_email ?? "").trim().toLowerCase();
      if (raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        withEmail += 1;
        emails.set(raw, (emails.get(raw) ?? 0) + 1);
      }
      if (!wrapLegacyHash(String(row.mb_password ?? ""))) {
        // 개수만 세고 목록은 만들지 않는다 — 회원 아이디 목록이 화면에 뜰 이유가 없다
      }
    }

    // 덤프 안에서 겹치는 이메일 + 이미 Brick 에 있는 이메일
    const dupInDump = [...emails.entries()].filter(([, n]) => n > 1).map(([e]) => e);
    const existing = await this.findExistingEmails([...emails.keys()]);
    const conflicts = [...new Set([...dupInDump, ...existing])].slice(0, 50);

    const unknownHash = [...readRows(dump, `${prefix}member`, tables)].filter(
      (r) => !wrapLegacyHash(String(r.mb_password ?? "")),
    ).length;
    if (unknownHash > 0) {
      warnings.push(
        `회원 ${unknownHash}명은 비밀번호 형식을 알 수 없어 비밀번호 로그인이 막힙니다. ` +
          `비밀번호 재설정 메일로 안내해야 합니다.`,
      );
    }
    if (existing.length) {
      warnings.push(
        `이미 Brick 에 있는 이메일 ${existing.length}건은 건너뜁니다. ` +
          `같은 사람이면 이전 후 수동으로 연결해야 합니다.`,
      );
    }
    if (dupInDump.length) {
      warnings.push(
        `덤프 안에서 이메일이 겹치는 회원이 ${dupInDump.length}건 있습니다 ` +
          `(그누보드는 이메일 중복을 허용합니다). 첫 번째만 이전됩니다.`,
      );
    }

    // ── 게시판 ──
    const boards: AnalyzeResult["boards"] = [];
    if (tables.has(`${prefix}board`)) {
      for (const row of readRows(dump, `${prefix}board`, tables)) {
        const table = String(row.bo_table ?? "");
        if (!table) continue;
        const writeTable = `${prefix}write_${table}`;
        const hasData = tables.has(writeTable);
        let posts = 0;
        let comments = 0;
        if (hasData) {
          for (const w of readRows(dump, writeTable, tables)) {
            if (Number(w.wr_is_comment ?? 0) === 1) comments += 1;
            else posts += 1;
          }
        }
        boards.push({
          table,
          slug: normalizeSlug(table),
          title: String(row.bo_subject ?? table),
          posts,
          comments,
          readRole: boardLevelToRole(Number(row.bo_read_level ?? 1) || 1, mapping),
          writeRole: boardLevelToRole(Number(row.bo_write_level ?? 2) || 2, mapping),
          hasData,
        });
      }
      const missing = boards.filter((b) => !b.hasData);
      if (missing.length) {
        warnings.push(
          `게시판 ${missing.length}개는 글 테이블이 덤프에 없습니다 ` +
            `(${missing.slice(0, 3).map((b) => b.table).join(", ")}). 게시판만 만들어집니다.`,
        );
      }
    } else {
      warnings.push("게시판 테이블(board)이 없어 게시판을 옮기지 않습니다.");
    }

    // ── 포인트 ──
    let pointMembers = 0;
    let pointTotal = 0;
    if (tables.has(`${prefix}point`)) {
      const perMember = new Map<string, number>();
      for (const row of readRows(dump, `${prefix}point`, tables)) {
        const id = String(row.mb_id ?? "");
        const amount = Number(row.po_point ?? 0) || 0;
        perMember.set(id, (perMember.get(id) ?? 0) + amount);
      }
      for (const [, v] of perMember) {
        if (v > 0) {
          pointMembers += 1;
          pointTotal += v;
        }
      }
      if (!this.plugins.dataErasers.some((e) => e.plugin === "brick-point")) {
        warnings.push(
          "포인트 플러그인이 활성화되지 않아 포인트를 옮길 수 없습니다. " +
            "관리자 → 플러그인에서 brick-point 를 켜고 다시 시도해주세요.",
        );
      }
    }

    // ── 영카트 (쇼핑몰) ──
    let shop: AnalyzeResult["shop"] = null;
    if (hasYoungcart(tables, prefix)) {
      const productStatus: Record<string, number> = { selling: 0, soldout: 0, hidden: 0 };
      let products = 0;
      for (const row of readRows(dump, `${prefix}${YC_TABLES.item}`, tables)) {
        products += 1;
        const st = itemStatus(row as never);
        productStatus[st] = (productStatus[st] ?? 0) + 1;
      }

      let categories = 0;
      if (tables.has(`${prefix}${YC_TABLES.category}`)) {
        for (const _ of readRows(dump, `${prefix}${YC_TABLES.category}`, tables)) categories += 1;
      }

      let options = 0;
      if (tables.has(`${prefix}${YC_TABLES.itemOption}`)) {
        for (const row of readRows(dump, `${prefix}${YC_TABLES.itemOption}`, tables)) {
          if (parseItemOption(row as never)) options += 1;
        }
      }

      const statusCounts = new Map<string, { to: string; count: number }>();
      let orders = 0;
      let revenue = 0;
      for (const row of readRows(dump, `${prefix}${YC_TABLES.order}`, tables)) {
        orders += 1;
        const raw = String(row.od_status ?? "").trim() || "(없음)";
        const mapped = orderStatus(row.od_status);
        const entry = statusCounts.get(raw) ?? { to: mapped.status, count: 0 };
        entry.count += 1;
        statusCounts.set(raw, entry);
        // 취소·반품은 매출에서 뺀다 — 부풀린 숫자를 보여주면 리허설의 의미가 없다
        if (mapped.status !== "cancelled" && mapped.status !== "refunded") {
          revenue += Math.max(0, Math.floor(Number(row.od_receipt_price ?? 0)) || 0);
        }
      }

      let orderItems = 0;
      if (tables.has(`${prefix}shop_coupon`)) {
        skipped.push(
          `${prefix}shop_coupon — 쿠폰 · 발급 조건(대상 회원·상품·기간)의 구조가 달라 수동 이전을 권합니다`,
        );
      }
      if (tables.has(`${prefix}shop_event`)) {
        skipped.push(`${prefix}shop_event — 기획전 · 진열 구성이 달라 관리자에서 새로 만드는 편이 빠릅니다`);
      }
      if (tables.has(`${prefix}${YC_TABLES.cart}`)) {
        for (const row of readRows(dump, `${prefix}${YC_TABLES.cart}`, tables)) {
          // 영카트는 장바구니와 주문 항목을 같은 테이블에 둔다.
          // od_id 가 있으면 주문된 것이고, 없으면 아직 장바구니다(옮기지 않는다).
          if (String(row.od_id ?? "").trim()) orderItems += 1;
        }
      }

      shop = {
        categories,
        products,
        productStatus,
        options,
        orders,
        orderItems,
        orderStatus: [...statusCounts.entries()]
          .map(([from, v]) => ({ from, to: v.to, count: v.count }))
          .sort((a, b) => b.count - a.count),
        revenue,
      };

      if (!(await this.tableExists("shop_products"))) {
        warnings.push(
          "쇼핑몰 플러그인이 활성화되지 않아 상품·주문을 옮길 수 없습니다. " +
            "관리자 → 플러그인에서 brick-shop 을 켜고 다시 시도해주세요.",
        );
      }
      const unknown = shop.orderStatus.filter((s) => s.to === "pending" && s.from !== "주문");
      if (unknown.length) {
        warnings.push(
          `알 수 없는 주문 상태 ${unknown.map((u) => `${u.from}(${u.count}건)`).join(", ")}는 ` +
            `'입금대기'로 옮겨집니다. 임의로 '완료'로 보면 배송하지 않은 주문이 완료되고 ` +
            `매출 통계가 부풀려집니다.`,
        );
      }
      warnings.push(
        "상품 이미지 파일은 DB에 없습니다. 옛 서버의 data/item/ 을 uploads/item/ 으로 " +
          "복사해야 이미지가 보입니다 — 주소는 자동으로 바꿔 두었습니다 (docs/migrate-gnuboard.md).",
      );
    }

    /*
     * 첨부파일은 기록만 옮길 수 있다 — 파일 내용은 DB 에 없다.
     * 이 말을 안 하면 운영자는 목록에 보이는 파일이 왜 안 열리는지 알 수 없다.
     */
    if (tables.has(`${prefix}board_file`)) {
      warnings.push(
        "게시글 첨부파일은 DB에 기록만 있습니다. 옛 서버의 data/file/ 을 uploads/ 로 " +
          "복사해야 실제로 내려받을 수 있습니다 (docs/migrate-gnuboard.md).",
      );
    }

    // ── 옮기지 않는 것 ──
    // 있는데 안 옮기는 것을 명시한다. 없다고 착각하고 나중에 발견하는 것이 최악이다.
    const skipCandidates: Array<[string, string]> = [
      ["memo", "쪽지 — 사적 대화이고 이전 후 맥락이 없다"],
      ["scrap", "스크랩 — 게시글 id 가 달라져 연결할 수 없다"],
      // Brick 에도 설문조사가 있지만 옮기지 않는다 — 지난 설문의 표는 그 시점의
      // 여론 기록이고, 새 사이트에서 이어서 투표받을 대상이 아니다.
      // 진행 중인 설문이 있으면 관리자에서 새로 만드는 것이 맞다.
      ["poll", "설문조사 — 지난 표는 그 시점의 기록이라 이어받을 대상이 아닙니다"],
      ["qa_content", "1:1 문의 — 구조가 달라 자동 변환이 위험하다"],
      ["faq", "FAQ — 분류 구조가 달라 수동 이전을 권한다"],
      ["popular", "인기검색어"],
      ["group_member", "그룹 접근 회원 — 그누보드는 회원을 하나씩 지정하지만 Brick 의 그룹 권한은 등급으로 정합니다"],
      ["faq_master", "FAQ 분류 — FAQ 본문과 함께 수동 이전을 권합니다"],
      ["auth", "관리 권한 — 그누보드는 메뉴마다 권한을 주지만 Brick 은 역할(관리자·운영자)로 정합니다"],
      ["config", "기본 설정 — 값의 뜻이 서로 달라 옮기면 틀린 설정이 됩니다 (사업자정보만 가져옵니다)"],
      ["mail", "회원 메일 발송 이력 — 지난 발송 기록이고 이어받을 대상이 아닙니다"],
      /*
       * 메뉴는 옮기지 않는다.
       *
       * 그누보드 메뉴는 옛 사이트의 주소(`/bbs/board.php?bo_table=free`)를 가리키고,
       * 우리 주소 체계는 다르다. 자동으로 바꾸면 끊긴 링크가 메뉴에 남는데,
       * 그건 없는 것보다 나쁘다 — 손님이 먼저 누른다.
       * (게시판·페이지는 이미 옮겨졌으므로 관리자 → 메뉴에서 고르기만 하면 된다)
       */
      ["menu", "메뉴 — 옛 주소를 가리켜 그대로 옮기면 끊긴 링크가 됩니다 (관리자 → 메뉴에서 새로 만드세요)"],
      ["visit", "방문 기록 — IP 원문이 들어 있어 옮기지 않는다"],
      ["login", "접속 기록"],
      ["autosave", "자동저장"],
    ];
    for (const [name, why] of skipCandidates) {
      if (tables.has(`${prefix}${name}`)) skipped.push(`${prefix}${name} — ${why}`);
    }
    // 영카트가 있어도 옮기지 않는 것들
    if (shop) {
      if (tables.has(`${prefix}${YC_TABLES.itemUse}`)) {
        skipped.push(
          `${prefix}${YC_TABLES.itemUse} — 상품 후기 · 구매 검증을 다시 할 수 없어 옮기지 않습니다`,
        );
      }
      if (tables.has(`${prefix}${YC_TABLES.itemQa}`)) {
        skipped.push(`${prefix}${YC_TABLES.itemQa} — 상품 문의 · 개인정보가 포함되어 있습니다`);
      }
      if (tables.has(`${prefix}shop_coupon`)) {
        skipped.push(
          `${prefix}shop_coupon — 쿠폰 · 발급 조건(대상 회원·상품·기간)의 구조가 달라 수동 이전을 권합니다`,
        );
      }
      if (tables.has(`${prefix}shop_event`)) {
        skipped.push(`${prefix}shop_event — 기획전 · 진열 구성이 달라 관리자에서 새로 만드는 편이 빠릅니다`);
      }
      if (tables.has(`${prefix}${YC_TABLES.cart}`)) {
        skipped.push(`${prefix}${YC_TABLES.cart} 중 주문되지 않은 장바구니 — 옮길 의미가 없습니다`);
      }
    }

    return {
      prefix,
      tableCount: tables.size,
      members: { total, withEmail, withoutEmail: total - withEmail, conflicts },
      levels: [...levelCounts.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([level, count]) => ({ level, count, role: levelToRole(level, mapping) })),
      boards,
      points: { members: pointMembers, total: pointTotal },
      shop,
      skipped,
      warnings,
    };
  }

  /**
   * 실제 이전.
   *
   * 트랜잭션 하나로 감싸지 않는다. 십만 건을 한 트랜잭션에 넣으면 WAL 이 부풀고
   * 실패 시 롤백에 그만큼 시간이 걸린다. 대신 **단계별로 멱등**하게 만든다 —
   * 이미 있는 회원·게시판은 건너뛰므로 다시 실행해도 중복이 생기지 않는다.
   */
  async run(dump: string, plan: MigratePlan): Promise<RunResult> {
    if (!(await this.tableExists("users"))) {
      throw new BadRequestException(
        "사이트를 먼저 설치해주세요. 이전은 설치가 끝난 Brick 에 데이터를 넣는 작업입니다.",
      );
    }
    const started = Date.now();
    const tables = parseTables(dump);
    const prefix = plan.prefix || detectPrefix(tables);
    if (!tables.has(`${prefix}member`)) {
      throw new BadRequestException("회원 테이블을 찾지 못했습니다.");
    }

    const warnings: string[] = [];
    const result: RunResult = {
      members: { created: 0, skipped: 0 },
      boards: { created: 0, skipped: 0 },
      posts: { created: 0 },
      comments: { created: 0 },
      attachments: { created: 0 },
      groups: { created: 0 },
      contents: { created: 0 },
      votes: { created: 0 },
      wishlist: { created: 0 },
      points: { granted: 0, total: 0 },
      shop: { categories: 0, products: 0, options: 0, orders: 0, orderItems: 0, skipped: 0 },
      warnings,
      durationMs: 0,
    };

    /** 그누보드 회원 아이디 → Brick uuid. 게시글 작성자를 연결하는 데 쓴다 */
    const memberMap = new Map<string, string>();

    if (plan.members) {
      await this.importMembers(dump, tables, prefix, plan, memberMap, result, warnings);
    }

    /*
     * 게시판 그룹을 먼저 만든다 — 게시판이 `gr_id` 로 여기를 가리킨다.
     * 그룹이 없으면 옮긴 사이트의 게시판이 전부 한 덩어리로 평평해진다.
     */
    const groupMap = new Map<string, string>();
    if (tables.has(`${prefix}group`)) {
      await this.importGroups(dump, tables, prefix, groupMap, result, warnings);
    }

    if (tables.has(`${prefix}board`)) {
      await this.importBoards(dump, tables, prefix, plan, memberMap, result, warnings, groupMap);
    }

    /*
     * 내용관리 — 그누보드의 `g5_content` 는 회사소개·이용안내 같은 **정적 페이지**다.
     * 우리 페이지와 같은 것인데 옮기지 않아서, 이전한 사이트는 회사소개가
     * 통째로 사라진 채 시작했다(그리고 사라졌다는 말도 없었다).
     */
    if (tables.has(`${prefix}content`)) {
      await this.importContents(dump, tables, prefix, result, warnings);
    }

    /*
     * 기본설정(`g5_config`)에서 **사업자정보만** 가져온다.
     *
     * 나머지 설정(회원가입 정책·스킨·메일 서버)은 뜻이 서로 달라 옮기면 오히려
     * 틀린 값이 들어간다. 그런데 사업자정보는 다르다 — 전자상거래법 제13조가
     * 초기 화면에 표시하라고 정한 항목이고, 우리에게 **같은 자리**가 있으며,
     * 비어 있으면 대시보드가 경고하는 값이다. 옛 사이트에 이미 적혀 있는 것을
     * 두고 운영자에게 다시 치라고 할 이유가 없다.
     */
    if (tables.has(`${prefix}config`)) {
      await this.importBusinessInfo(dump, tables, prefix, warnings);
    }

    if (plan.points && tables.has(`${prefix}point`)) {
      await this.importPoints(dump, tables, prefix, memberMap, result, warnings);
    }

    if (plan.shop !== false && hasYoungcart(tables, prefix)) {
      await this.importShop(dump, tables, prefix, memberMap, result, warnings, plan);
    }

    result.durationMs = Date.now() - started;
    this.log.log(
      `이전 완료: 회원 ${result.members.created} · 게시판 ${result.boards.created} · ` +
        `글 ${result.posts.created} · 댓글 ${result.comments.created} · ` +
        `상품 ${result.shop.products} · 주문 ${result.shop.orders} (${result.durationMs}ms)`,
    );
    return result;
  }

  /* ── 회원 ────────────────────────────────────────── */

  private async importMembers(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    plan: MigratePlan,
    memberMap: Map<string, string>,
    result: RunResult,
    warnings: string[],
  ): Promise<void> {
    const seenEmails = new Set<string>();
    let batch: Array<Record<string, unknown>> = [];
    let noHash = 0;

    const flush = async () => {
      if (!batch.length) return;
      // 이메일 충돌은 개별 행에서만 실패해야 한다. 배치 하나가 통째로 실패하면
      // 멀쩡한 999건이 함께 버려진다 — ON CONFLICT 로 건너뛴다.
      for (const m of batch) {
        try {
          await this.db.execute(sql`
            INSERT INTO users
              (id, email, password_hash, display_name, role, is_active,
               age_confirmed, marketing_opt_in, created_at, updated_at)
            VALUES
              (${m.id}, ${m.email}, ${m.passwordHash}, ${m.displayName}, ${m.role},
               ${m.isActive}, true, false, ${m.createdAt}, now())
            ON CONFLICT (email) DO NOTHING
          `);
          const { rows } = await this.db.execute(sql`
            SELECT id FROM users WHERE email = ${m.email} LIMIT 1
          `);
          const id = rows[0] ? String(rows[0].id) : null;
          if (id === String(m.id)) result.members.created += 1;
          else result.members.skipped += 1;
          if (id) memberMap.set(String(m.gnuId), id);
        } catch (err) {
          result.members.skipped += 1;
          this.log.warn(`회원 이전 실패 (${String(m.gnuId)}): ${String(err)}`);
        }
      }
      batch = [];
    };

    for (const row of readRows(dump, `${prefix}member`, tables)) {
      const gnuId = String(row.mb_id ?? "").trim();
      if (!gnuId) continue;

      const email = normalizeEmail(row.mb_email, gnuId);
      // 덤프 안에서 겹치면 첫 번째만 — 그누보드는 이메일 중복을 허용한다
      if (seenEmails.has(email)) {
        result.members.skipped += 1;
        continue;
      }
      seenEmails.add(email);

      const legacy = wrapLegacyHash(String(row.mb_password ?? ""));
      if (!legacy) noHash += 1;

      batch.push({
        id: uuidv7(),
        gnuId,
        email,
        // 형식을 모르는 해시는 쓸 수 없는 값으로 둔다 — 임의로 추측해 검증하면
        // 잘못된 비밀번호를 통과시킬 수 있다. 재설정 메일로 안내해야 한다.
        passwordHash: legacy ?? `unusable:${uuidv7()}`,
        displayName: String(row.mb_nick ?? row.mb_name ?? gnuId).slice(0, 100),
        role: levelToRole(Number(row.mb_level ?? 1) || 1, plan.levelMapping),
        // 그누보드의 mb_leave_date 가 있으면 탈퇴한 회원이다
        isActive: !String(row.mb_leave_date ?? "").trim(),
        createdAt: parseGnuDate(row.mb_datetime) ?? new Date(),
      });

      if (batch.length >= BATCH) await flush();
    }
    await flush();

    if (noHash > 0) {
      warnings.push(
        `회원 ${noHash}명은 비밀번호 형식을 알 수 없어 비밀번호 로그인이 막혔습니다. ` +
          `비밀번호 재설정을 안내해주세요.`,
      );
    }
  }

  /* ── 게시판 · 게시글 ─────────────────────────────── */

  private async importBoards(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    plan: MigratePlan,
    memberMap: Map<string, string>,
    result: RunResult,
    warnings: string[],
    groupMap: Map<string, string>,
  ): Promise<void> {
    // 게시판 플러그인이 없으면 게시판을 만들 수 없다
    const hasBoard = await this.tableExists("board_boards");
    if (!hasBoard) {
      warnings.push(
        "게시판 플러그인이 활성화되지 않아 게시판을 옮기지 않았습니다. " +
          "관리자 → 플러그인에서 brick-board 를 켜고 다시 실행해주세요.",
      );
      return;
    }

    for (const row of readRows(dump, `${prefix}board`, tables)) {
      const table = String(row.bo_table ?? "");
      if (!table) continue;
      if (plan.boards.length && !plan.boards.includes(table)) continue;

      const slug = normalizeSlug(table);
      const { rows: existing } = await this.db.execute(sql`
        SELECT id FROM board_boards WHERE slug = ${slug} LIMIT 1
      `);
      let boardId: string;
      if (existing[0]) {
        // 멱등: 이미 있으면 그 게시판에 글만 채운다
        boardId = String(existing[0].id);
        result.boards.skipped += 1;
      } else {
        boardId = uuidv7();
        /*
         * 여분 필드 — 그누보드는 칸 이름을 bo_1_subj ~ bo_10_subj 에, 값을 글의
         * wr_1 ~ wr_10 에 둔다. 연락처·지역·학번처럼 **실제 내용**이 거기 들어
         * 있는 사이트가 많은데, 예전에는 이 이전에서 통째로 버려졌다 — 글은
         * 옮겨지고 그 옆의 값만 소리 없이 사라졌다.
         *
         * (설명을 sql 템플릿 **밖에** 둔다: 리터럴 안의 백틱 하나가 리터럴을 닫는다)
         */
        await this.db.execute(sql`
          INSERT INTO board_boards
            (id, slug, title, description, read_role, write_role, comment_role, download_role,
             page_size, allow_reply, allow_secret, allow_upload, extra_fields, group_id,
             is_visible, created_at)
          VALUES
            (${boardId}, ${slug}, ${String(row.bo_subject ?? table).slice(0, 200)},
             ${String(row.bo_content_head ?? "").slice(0, 1000) || null},
             ${boardLevelToRole(Number(row.bo_read_level ?? 1) || 1, plan.levelMapping)},
             ${boardLevelToRole(Number(row.bo_write_level ?? 2) || 2, plan.levelMapping)},
             ${boardLevelToRole(Number(row.bo_comment_level ?? 2) || 2, plan.levelMapping)},
             ${boardLevelToRole(Number(row.bo_download_level ?? 2) || 2, plan.levelMapping)},
             ${Math.min(100, Math.max(5, Number(row.bo_page_rows ?? 20) || 20))},
             ${Number(row.bo_use_reply ?? 1) !== 0},
             ${Number(row.bo_use_secret ?? 0) !== 0},
             ${Number(row.bo_upload_count ?? 0) > 0},
             ${JSON.stringify(gnuExtraFields(row))}::jsonb,
             ${groupMap.get(String(row.gr_id ?? "")) ?? null}::uuid,
             true, now())
        `);
        result.boards.created += 1;
      }

      const writeTable = `${prefix}write_${table}`;
      if (tables.has(writeTable)) {
        // 게시판이 정의한 여분 필드만 글에서 가져온다 — 이름 없는 칸의 값은 보여줄 자리가 없다
        await this.importPosts(dump, tables, writeTable, boardId, memberMap, result, plan,
          gnuExtraFields(row).map((f) => f.key), table, prefix);
      }
    }
  }

  /**
   * 게시글과 댓글.
   *
   * 그누보드는 글과 댓글을 같은 테이블에 둔다(wr_is_comment 로 구분).
   * 댓글은 wr_parent 로 원글을 가리키므로, 원글을 먼저 넣고 id 지도를 만든 뒤
   * 댓글을 넣는다.
   */
  private async importPosts(
    dump: string,
    tables: Map<string, DumpTable>,
    writeTable: string,
    boardId: string,
    memberMap: Map<string, string>,
    result: RunResult,
    plan: MigratePlan,
    /** 이 게시판이 쓰는 여분 필드 키 (f1…) — 없으면 글의 wr_N 도 가져오지 않는다 */
    extraKeys: string[] = [],
    /** 그누보드 쪽 게시판 이름 (첨부파일이 `g5_board_file` 에서 이 이름으로 묶여 있다) */
    boTable = "",
    prefix = "",
  ): Promise<void> {
    // 본문의 /data/ 이미지 주소를 /uploads/ 로 — 안 바꾸면 옮긴 사이트의
    // 이미지가 전부 깨진다. 리버스 프록시를 쓰는 운영자만 끈다.
    const fixMedia = (html: string): string =>
      plan.imageRewrite === false ? html : rewriteLegacyMediaUrls(html, plan.oldBaseUrl);
    /** 그누보드 wr_id → Brick uuid */
    const postMap = new Map<string, string>();

    // 1단계: 원글
    for (const row of readRows(dump, writeTable, tables)) {
      if (Number(row.wr_is_comment ?? 0) === 1) continue;
      const wrId = String(row.wr_id ?? "");
      if (!wrId) continue;

      const id = uuidv7();
      const authorId = memberMap.get(String(row.mb_id ?? "")) ?? null;
      const created = parseGnuDate(row.wr_datetime) ?? new Date();

      await this.db.execute(sql`
        INSERT INTO board_posts
          (id, board_id, author_id, author_name, title, content, category,
           is_notice, is_secret, thread_id, thread_created_at, thread_path, depth,
           view_count, up_count, comment_count, links, extra, created_at, updated_at)
        VALUES
          (${id}, ${boardId}::uuid,
           ${authorId ? sql`${authorId}::uuid` : sql`NULL`},
           ${String(row.wr_name ?? "이름없음").slice(0, 100)},
           ${String(row.wr_subject ?? "(제목 없음)").slice(0, 300)},
           ${fixMedia(convertContent(row.wr_content, row.wr_option))},
           ${String(row.ca_name ?? "").slice(0, 50) || null},
           ${String(row.wr_option ?? "").includes("notice")},
           ${String(row.wr_option ?? "").includes("secret")},
           ${id}::uuid, ${created}, ${id}, 0,
           ${Math.max(0, Number(row.wr_hit ?? 0) || 0)},
           ${Math.max(0, Number(row.wr_good ?? 0) || 0)},
           0,
           ${JSON.stringify(gnuLinks(row))}::jsonb,
           ${JSON.stringify(gnuExtraValues(row, extraKeys))}::jsonb,
           ${created}, ${created})
      `);
      postMap.set(wrId, id);
      result.posts.created += 1;
    }

    // 2단계: 댓글
    for (const row of readRows(dump, writeTable, tables)) {
      if (Number(row.wr_is_comment ?? 0) !== 1) continue;
      const parent = postMap.get(String(row.wr_parent ?? ""));
      // 원글이 없는 댓글은 버린다 — 어디에 붙일지 알 수 없다
      if (!parent) continue;

      const authorId = memberMap.get(String(row.mb_id ?? "")) ?? null;
      const created = parseGnuDate(row.wr_datetime) ?? new Date();
      await this.db.execute(sql`
        INSERT INTO board_comments
          (id, post_id, author_id, author_name, content, is_secret, created_at)
        VALUES
          (${uuidv7()}, ${parent}::uuid,
           ${authorId ? sql`${authorId}::uuid` : sql`NULL`},
           ${String(row.wr_name ?? "이름없음").slice(0, 100)},
           ${String(row.wr_content ?? "")},
           ${String(row.wr_option ?? "").includes("secret")},
           ${created})
      `);
      result.comments.created += 1;
    }

    // 댓글 수를 다시 센다 — 하나씩 증가시키면 중간에 실패했을 때 어긋난다
    if (postMap.size) {
      await this.db.execute(sql`
        UPDATE board_posts p SET comment_count = (
          SELECT count(*) FROM board_comments c WHERE c.post_id = p.id
        ) WHERE p.board_id = ${boardId}::uuid
      `);
    }

    await this.importAttachments(dump, tables, prefix, boTable, boardId, postMap, result);
    await this.importVotes(dump, tables, prefix, boTable, memberMap, postMap, result);
  }

  /**
   * 추천·비추천 기록(`g5_board_good`).
   *
   * 글의 추천 **수**는 이미 옮긴다(`wr_good`). 하지만 누가 눌렀는지를 옮기지
   * 않으면 "추천 12" 인 글에 같은 회원이 또 추천할 수 있고, 화면은 "추천함"
   * 표시를 못 한다 — 숫자는 이월됐는데 내 기록만 사라진 상태다.
   */
  private async importVotes(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    boTable: string,
    memberMap: Map<string, string>,
    postMap: Map<string, string>,
    result: RunResult,
  ): Promise<void> {
    const table = `${prefix}board_good`;
    if (!boTable || !postMap.size || !tables.has(table)) return;
    if (!(await this.tableExists("board_votes"))) return;
    let created = 0;
    for (const row of readRows(dump, table, tables)) {
      if (String(row.bo_table ?? "") !== boTable) continue;
      const postId = postMap.get(String(row.wr_id ?? ""));
      const userId = memberMap.get(String(row.mb_id ?? "").trim());
      if (!postId || !userId) continue;
      // 그누보드는 good / nogood 두 값을 문자열로 둔다
      const value = String(row.bg_flag ?? "good").trim() === "nogood" ? -1 : 1;
      const { rows } = await this.db.execute(sql`
        INSERT INTO board_votes (post_id, user_id, value, created_at)
        VALUES (${postId}::uuid, ${userId}::uuid, ${value}, ${parseGnuDate(row.bg_datetime) ?? new Date()})
        ON CONFLICT (post_id, user_id) DO NOTHING
        RETURNING post_id
      `);
      if (rows.length) created += 1;
    }
    if (created) result.votes.created += created;
  }

  /* ── 첨부파일 ────────────────────────────────────── */

  /**
   * 게시글 첨부파일(`g5_board_file`).
   *
   * **옮기지 않으면 자료실 게시판이 빈 껍데기가 된다.** 글은 그대로 있는데
   * 내려받을 것이 하나도 없고, 없어졌다는 말조차 없었다.
   *
   * 파일 **내용**은 DB 에 없다 — 옛 서버의 `data/file/` 을 `uploads/` 로 복사해야
   * 한다(본문 이미지 주소를 이미 그 규칙으로 바꾸고 있고, 안내에도 적혀 있다).
   * 여기서는 그 파일을 가리키는 기록만 만든다. 복사를 안 하면 목록에는 보이고
   * 누르면 없다 — 그래도 "있었다는 사실" 이 남는 편이 통째로 사라지는 것보다 낫다.
   */
  private async importAttachments(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    boTable: string,
    boardId: string,
    postMap: Map<string, string>,
    result: RunResult,
  ): Promise<void> {
    const fileTable = `${prefix}board_file`;
    if (!boTable || !postMap.size || !tables.has(fileTable)) return;
    if (!(await this.tableExists("board_attachments"))) return;

    let created = 0;
    for (const row of readRows(dump, fileTable, tables)) {
      if (String(row.bo_table ?? "") !== boTable) continue;
      const postId = postMap.get(String(row.wr_id ?? ""));
      if (!postId) continue;
      const stored = String(row.bf_file ?? "").trim();
      if (!stored) continue;
      const source = String(row.bf_source ?? stored).slice(0, 500);
      await this.db.execute(sql`
        INSERT INTO board_attachments
          (id, post_id, storage_key, file_name, content_type, size, download_count, sort_order)
        VALUES (${uuidv7()}, ${postId}::uuid, ${gnuAttachmentKey(boTable, stored)},
                ${source}, ${guessContentType(source)},
                ${Math.max(0, Math.floor(Number(row.bf_filesize ?? 0)) || 0)},
                ${Math.max(0, Math.floor(Number(row.bf_download ?? 0)) || 0)},
                ${Math.floor(Number(row.bf_no ?? 0)) || 0})
      `);
      created += 1;
    }
    if (!created) return;
    result.attachments.created += created;
    /*
     * 옮긴 뒤에도 한 번 더 말한다.
     *
     * 분석 단계의 안내는 실행 전에 읽고 잊는다. 정작 "목록에는 보이는데 눌러도
     * 안 열린다" 를 만나는 것은 옮긴 **뒤**이고, 그때 눈앞에 있는 것은 이 결과다.
     */
    if (!result.warnings.some((w) => w.includes("data/file/"))) {
      result.warnings.push(
        `첨부 기록 ${created}건을 옮겼습니다. 파일 내용은 DB 에 없으므로 옛 서버의 ` +
          "data/file/ 을 uploads/ 로 복사해야 실제로 내려받을 수 있습니다.",
      );
    }
    // 첨부 수는 다시 센다 — 글 목록의 클립 표시가 이 값을 본다
    await this.db.execute(sql`
      UPDATE board_posts p SET file_count = (
        SELECT count(*) FROM board_attachments a WHERE a.post_id = p.id
      ) WHERE p.board_id = ${boardId}::uuid
    `);
  }

  /* ── 포인트 ──────────────────────────────────────── */

  /**
   * 포인트 잔액을 옮긴다.
   *
   * 원장을 그대로 옮기지 않는다. 그누보드의 포인트 이력에는 이미 소멸된 것과
   * 유효한 것이 섞여 있고, Brick 의 FIFO 소비 모델과 구조가 다르다.
   * **현재 잔액 하나를 이월 적립으로 넣는다** — 금액이 맞는 것이 이력이
   * 맞는 것보다 중요하다. 이력은 그누보드 쪽에 남아 있다.
   */
  /* ── 사업자정보 ──────────────────────────────────── */

  /**
   * `g5_config` 의 사업자정보 → `site.business_info`.
   *
   * 이미 채워져 있으면 덮지 않는다 — 설치하면서 적었을 수 있고, 그쪽이 더 최신이다.
   */
  private async importBusinessInfo(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    warnings: string[],
  ): Promise<void> {
    const [row] = readRows(dump, `${prefix}config`, tables);
    if (!row) return;
    const pick = (key: string) => String(row[key] ?? "").trim();
    const next = {
      companyName: pick("cf_company_name"),
      representative: pick("cf_ceo_name"),
      businessNo: pick("cf_company_saupja_no"),
      mailOrderNo: pick("cf_company_tongsin_no"),
      address: pick("cf_company_addr"),
      phone: pick("cf_company_tel"),
      email: pick("cf_admin_email"),
      privacyOfficer: pick("cf_privacy_officer"),
    };
    if (!Object.values(next).some(Boolean)) return;

    const { rows: cur } = await this.db.execute(sql`
      SELECT value FROM site_settings WHERE key = 'site.business_info' LIMIT 1
    `);
    const existing = (cur[0]?.value ?? {}) as Record<string, unknown>;
    if (Object.values(existing).some((v) => String(v ?? "").trim())) return;

    // 비어 있는 항목은 넣지 않는다 — 빈 문자열로 덮으면 "적었는데 안 보인다" 가 된다
    const value = Object.fromEntries(Object.entries(next).filter(([, v]) => v));
    await this.db.execute(sql`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ('site.business_info', ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
    `);
    warnings.push(
      `사업자정보를 옛 설정에서 가져왔습니다(${Object.keys(value).length}개 항목). ` +
        "관리자 → 설정에서 확인하세요 — 법이 정한 표시 항목입니다.",
    );
  }

  /* ── 게시판 그룹 ─────────────────────────────────── */

  /**
   * 그누보드의 게시판 그룹(`g5_group`).
   *
   * 옮기지 않으면 게시판 스무 개가 한 덩어리로 늘어선다 — 원래 사이트의
   * 구조가 사라지고, 운영자가 화면에서 하나씩 다시 묶어야 한다.
   */
  private async importGroups(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    groupMap: Map<string, string>,
    result: RunResult,
    warnings: string[],
  ): Promise<void> {
    if (!(await this.tableExists("board_groups"))) return;
    for (const row of readRows(dump, `${prefix}group`, tables)) {
      const grId = String(row.gr_id ?? "").trim();
      if (!grId) continue;
      const slug = normalizeSlug(grId);
      const id = uuidv7();
      const { rows } = await this.db.execute(sql`
        INSERT INTO board_groups (id, slug, title, sort_order)
        VALUES (${id}, ${slug}, ${String(row.gr_subject ?? grId).slice(0, 200)},
                ${Math.floor(Number(row.gr_order ?? 0)) || 0})
        ON CONFLICT (slug) DO UPDATE SET slug = board_groups.slug
        RETURNING id
      `);
      // 이미 있는 슬러그면 그 그룹에 붙인다 — 두 번 돌려도 그룹이 늘어나지 않는다
      const groupId = String(rows[0]?.id ?? id);
      groupMap.set(grId, groupId);
      if (groupId === id) result.groups.created += 1;
    }
    if (result.groups.created) warnings.push(`게시판 그룹 ${result.groups.created}개를 만들었습니다.`);
  }

  /* ── 내용관리(정적 페이지) ───────────────────────── */

  /**
   * 그누보드의 내용관리(`g5_content`) → Brick 페이지.
   *
   * 회사소개·이용안내·오시는길처럼 **글이 아닌 페이지**가 여기 있다. 우리에게
   * 같은 것(pages)이 있는데도 옮기지 않아서, 이전한 사이트는 그 페이지들이
   * 통째로 사라진 채 시작했다.
   *
   * 본문은 `core/rich-text` 블록 하나로 넣는다 — 원문이 HTML 이고, 그것을
   * 블록으로 쪼개는 일은 사람이 보면서 할 일이다. 평문이면 줄바꿈을 살린다.
   */
  private async importContents(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    result: RunResult,
    warnings: string[],
  ): Promise<void> {
    for (const row of readRows(dump, `${prefix}content`, tables)) {
      const coId = String(row.co_id ?? "").trim();
      if (!coId) continue;
      const slug = normalizeSlug(coId);
      const title = String(row.co_subject ?? coId).slice(0, 500);
      const html = convertContent(row.co_content, String(row.co_html ?? "") === "0" ? "" : "html1");
      const blocks = [{ block: "core/rich-text", props: { html: rewriteLegacyMediaUrls(html) } }];
      const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 10000);
      const { rows } = await this.db.execute(sql`
        INSERT INTO pages (id, slug, title, blocks, plain_text, status, seo, published_at)
        VALUES (${uuidv7()}, ${slug}, ${title}, ${JSON.stringify(blocks)}::jsonb,
                ${plain}, 'published', '{}'::jsonb, now())
        ON CONFLICT (slug) DO NOTHING
        RETURNING id
      `);
      // 이미 그 주소에 페이지가 있으면 덮지 않는다 — 운영자가 만든 것이 우선이다
      if (rows.length) result.contents.created += 1;
    }
    if (result.contents.created) {
      warnings.push(
        `내용관리 ${result.contents.created}개를 페이지로 옮겼습니다. 원문 HTML 을 그대로 넣었으니 ` +
          "관리자 → 페이지에서 확인하세요.",
      );
    }
  }

  private async importPoints(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    memberMap: Map<string, string>,
    result: RunResult,
    warnings: string[],
  ): Promise<void> {
    if (!(await this.tableExists("point_ledger"))) {
      warnings.push(
        "포인트 플러그인이 활성화되지 않아 포인트를 옮기지 않았습니다. " +
          "brick-point 를 켜고 다시 실행해주세요.",
      );
      return;
    }

    const balances = new Map<string, number>();
    for (const row of readRows(dump, `${prefix}point`, tables)) {
      const gnuId = String(row.mb_id ?? "");
      if (!gnuId) continue;
      balances.set(gnuId, (balances.get(gnuId) ?? 0) + (Number(row.po_point ?? 0) || 0));
    }

    for (const [gnuId, amount] of balances) {
      if (amount <= 0) continue;
      const userId = memberMap.get(gnuId);
      if (!userId) continue;

      // 멱등: 같은 회원의 이월 적립은 한 번만.
      // point_ledger_once_idx 가 (user_id, kind, ref_type, ref_id) 를 유니크로
      // 잡으므로 ref 를 이전 출처로 채우면 다시 실행해도 중복이 생기지 않는다.
      // 만료를 두지 않는다 — 그누보드에서 언제 적립된 것인지 알 수 없으므로
      // 임의의 만료일을 붙이면 남의 포인트를 마음대로 소멸시키는 것이 된다.
      try {
        const { rows } = await this.db.execute(sql`
          INSERT INTO point_ledger
            (id, user_id, amount, remaining, kind, reason, ref_type, ref_id, created_at)
          VALUES
            (${uuidv7()}, ${userId}::uuid, ${amount}, ${amount}, 'earn',
             '그누보드 이월', 'gnuboard.carryover', ${gnuId}, now())
          ON CONFLICT DO NOTHING
          RETURNING id
        `);
        if (rows.length) {
          result.points.granted += 1;
          result.points.total += amount;
        }
      } catch (err) {
        this.log.warn(`포인트 이전 실패 (${gnuId}): ${String(err)}`);
      }
    }
  }

  /* ── 영카트: 분류 · 상품 · 주문 ────────────────── */

  /**
   * 영카트 커머스 이전.
   *
   * 순서가 중요하다 — 분류 → 상품 → 옵션 → 주문 → 주문항목.
   * 주문 항목이 상품을 가리키므로 상품이 먼저 있어야 하고,
   * 상품이 분류를 가리키므로 분류가 먼저 있어야 한다.
   *
   * **주문은 재고를 건드리지 않는다.** 과거 주문을 옮기면서 재고를 차감하면
   * 지금 재고가 음수가 된다 — 이미 팔린 것은 영카트 쪽 재고에 반영되어 있고,
   * 우리는 그 최종 재고 값을 그대로 가져온다.
   */
  private async importShop(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    memberMap: Map<string, string>,
    result: RunResult,
    warnings: string[],
    plan: MigratePlan,
  ): Promise<void> {
    const fixMedia = (html: string): string =>
      plan.imageRewrite === false ? html : rewriteLegacyMediaUrls(html, plan.oldBaseUrl);
    if (!(await this.tableExists("shop_products"))) {
      warnings.push(
        "쇼핑몰 플러그인이 활성화되지 않아 상품·주문을 옮기지 않았습니다. " +
          "brick-shop 을 켜고 다시 실행해주세요.",
      );
      return;
    }

    /** 영카트 ca_id → Brick 분류 uuid */
    const catMap = new Map<string, string>();
    /** 영카트 it_id → Brick 상품 uuid */
    const itemMap = new Map<string, string>();

    // ── 1. 분류 ──
    //
    // 계층을 두 번에 걸쳐 만든다. 영카트의 ca_id 는 앞자리가 부모이므로
    // 짧은 것부터 처리하면 부모가 항상 먼저 만들어진다.
    if (tables.has(`${prefix}${YC_TABLES.category}`)) {
      const cats = [...readRows(dump, `${prefix}${YC_TABLES.category}`, tables)]
        .filter((r) => String(r.ca_id ?? "").trim())
        .sort((a, b) => String(a.ca_id).length - String(b.ca_id).length);

      for (const row of cats) {
        const caId = String(row.ca_id).trim();
        const slug = categorySlug(caId);
        const { rows: existing } = await this.db.execute(sql`
          SELECT id FROM shop_categories WHERE slug = ${slug} LIMIT 1
        `);
        if (existing[0]) {
          catMap.set(caId, String(existing[0].id));
          continue;
        }

        const parentCaId = categoryParentId(caId);
        const parentId = parentCaId ? catMap.get(parentCaId) : null;
        const id = uuidv7();
        await this.db.execute(sql`
          INSERT INTO shop_categories (id, slug, name, parent_id, sort_order, is_visible)
          VALUES (${id}, ${slug}, ${String(row.ca_name ?? caId).slice(0, 200)},
                  ${parentId ? sql`${parentId}::uuid` : sql`NULL`},
                  ${Math.floor(Number(row.ca_order ?? 0)) || 0},
                  ${String(row.ca_use ?? "1") === "1"})
        `);
        catMap.set(caId, id);
        result.shop.categories += 1;
      }
    }

    // ── 2. 상품 ──
    for (const row of readRows(dump, `${prefix}${YC_TABLES.item}`, tables)) {
      const itId = String(row.it_id ?? "").trim();
      if (!itId) continue;

      const name = String(row.it_name ?? "(이름 없음)").slice(0, 300);
      const slug = itemSlug(itId, name);

      const { rows: existing } = await this.db.execute(sql`
        SELECT id FROM shop_products WHERE slug = ${slug} LIMIT 1
      `);
      if (existing[0]) {
        // 멱등: 이미 옮긴 상품은 건너뛰고 지도만 채운다 (주문 항목이 참조한다)
        itemMap.set(itId, String(existing[0].id));
        result.shop.skipped += 1;
        continue;
      }

      const price = Math.max(0, Math.floor(Number(row.it_price ?? 0)) || 0);
      // it_cust_price 는 "시중가"(정가)다. 판매가보다 낮으면 할인 표시가
      // 거꾸로 되므로 그때는 버린다.
      const custPrice = Math.floor(Number(row.it_cust_price ?? 0)) || 0;
      const listPrice = custPrice > price ? custPrice : null;

      // 상품 이미지(/data/item/*)와 상세 설명 속 이미지도 함께 바꾼다
      const images = itemImages(row as Record<string, string | null>).map(fixMedia);
      const id = uuidv7();

      await this.db.execute(sql`
        INSERT INTO shop_products
          (id, slug, name, category_id, summary, description, image_url, images,
           price, list_price, stock, status, free_shipping, sort_order, sold_count,
           view_count, created_at, tax_free)
        VALUES
          (${id}, ${slug}, ${name},
           ${catMap.get(String(row.ca_id ?? "")) ? sql`${catMap.get(String(row.ca_id))}::uuid` : sql`NULL`},
           ${String(row.it_basic ?? "").slice(0, 500) || null},
           ${fixMedia(String(row.it_explan ?? ""))},
           ${images[0] ?? null},
           ${JSON.stringify(images)}::jsonb,
           ${price}, ${listPrice},
           ${Math.max(0, Math.floor(Number(row.it_stock_qty ?? 0)) || 0)},
           ${itemStatus(row as never)},
           ${String(row.it_sc_type ?? "") === "2"},
           ${Math.floor(Number(row.it_order ?? 0)) || 0},
           0,
           ${Math.max(0, Math.floor(Number(row.it_hit ?? 0)) || 0)},
           ${parseGnuDate(row.it_time) ?? new Date()},
           -- 영카트의 면세 설정을 그대로 옮긴다. 안 옮기면 도서 쇼핑몰이
           -- 이전 후 부가세를 붙여 증빙을 발급한다 — 잘못된 증빙이다.
           ${String(row.it_notax ?? "0") === "1"})
      `);
      itemMap.set(itId, id);
      result.shop.products += 1;
    }

    // ── 3. 옵션 ──
    //
    // 조합형 옵션(색상+사이즈)은 Brick 의 단층 모델로 표현할 수 없으므로
    // 조합을 하나의 이름으로 펼친다. 영카트도 화면에서 한 줄로 보여주므로
    // 사용자가 보는 것은 같다.
    if (tables.has(`${prefix}${YC_TABLES.itemOption}`)) {
      const perItem = new Map<string, number>();
      for (const row of readRows(dump, `${prefix}${YC_TABLES.itemOption}`, tables)) {
        const productId = itemMap.get(String(row.it_id ?? "").trim());
        if (!productId) continue;
        const opt = parseItemOption(row as never);
        if (!opt) continue;

        const order = perItem.get(productId) ?? 0;
        perItem.set(productId, order + 1);
        try {
          await this.db.execute(sql`
            INSERT INTO shop_product_options
              (id, product_id, name, extra_price, stock, sort_order, is_active)
            VALUES (${uuidv7()}, ${productId}::uuid, ${opt.name}, ${opt.extraPrice},
                    ${opt.stock}, ${order}, true)
          `);
          result.shop.options += 1;
        } catch (err) {
          // 같은 이름의 옵션이 두 번 있으면 건너뛴다 (영카트에서 가능하다)
          this.log.warn(`옵션 이전 실패 (${opt.name}): ${String(err)}`);
        }
      }
    }

    // ── 4. 주문 ──
    /** 영카트 od_id → Brick 주문 uuid */
    const orderMap = new Map<string, string>();

    for (const row of readRows(dump, `${prefix}${YC_TABLES.order}`, tables)) {
      const odId = String(row.od_id ?? "").trim();
      if (!odId) continue;

      // 주문번호는 영카트의 od_id 를 그대로 쓴다 — 고객이 알고 있는 번호이고,
      // 문의가 오면 그 번호로 찾아야 한다.
      const orderNo = odId.slice(0, 30);
      const { rows: existing } = await this.db.execute(sql`
        SELECT id FROM shop_orders WHERE order_no = ${orderNo} LIMIT 1
      `);
      if (existing[0]) {
        orderMap.set(odId, String(existing[0].id));
        result.shop.skipped += 1;
        continue;
      }

      const { status, paymentStatus } = orderStatus(row.od_status);
      const addr = address(row as never);
      const cartPrice = Math.max(0, Math.floor(Number(row.od_cart_price ?? 0)) || 0);
      const sendCost = Math.max(0, Math.floor(Number(row.od_send_cost ?? 0)) || 0);
      const total = Math.max(0, Math.floor(Number(row.od_receipt_price ?? 0)) || 0);
      // 금액이 맞지 않으면 총액을 신뢰한다 — 실제로 받은 돈이 그것이다.
      // discount 로 차액을 흡수해 subtotal - discount + shipping = total 을 지킨다.
      const discount = Math.max(0, cartPrice + sendCost - total);
      const createdAt = parseGnuDate(row.od_time) ?? new Date();
      const id = uuidv7();

      await this.db.execute(sql`
        INSERT INTO shop_orders
          (id, order_no, user_id, status, subtotal, discount, shipping_fee, total,
           payment_method, payment_status, paid_at,
           orderer_name, orderer_phone, orderer_email,
           receiver_name, receiver_phone, postcode, address1, address2, delivery_memo,
           created_at, updated_at, imported_from)
        VALUES
          (${id}, ${orderNo},
           ${memberMap.get(String(row.mb_id ?? "")) ? sql`${memberMap.get(String(row.mb_id))}::uuid` : sql`NULL`},
           ${status}, ${cartPrice}, ${discount}, ${sendCost}, ${total},
           ${paymentMethod(row.od_settle_case)}, ${paymentStatus},
           ${paymentStatus === "paid" ? createdAt : null},
           ${String(row.od_name ?? "(이름 없음)").slice(0, 100)},
           ${String(row.od_tel ?? row.od_hp ?? "").slice(0, 30) || "-"},
           ${String(row.od_email ?? "").slice(0, 255) || null},
           ${String(row.od_b_name ?? row.od_name ?? "(이름 없음)").slice(0, 100)},
           ${String(row.od_b_tel ?? row.od_b_hp ?? row.od_tel ?? "").slice(0, 30) || "-"},
           ${postcode(row as never)}, ${addr.address1}, ${addr.address2},
           ${String(row.od_memo ?? "").slice(0, 500) || null},
           ${createdAt}, ${createdAt},
           -- 옮겨 온 주문 표시 — 미결제 자동 취소가 몇 년 전 미입금 주문을 한꺼번에 취소해
           -- 차감한 적 없는 재고를 되돌리고 옛 손님에게 메일을 보내지 않게 한다
           'youngcart')
      `);
      orderMap.set(odId, id);
      result.shop.orders += 1;
    }

    // ── 5. 주문 항목 ──
    //
    // 영카트는 장바구니 테이블이 주문 항목을 겸한다. od_id 가 있으면 주문된 것이고,
    // 없으면 아직 장바구니다(옮기지 않는다 — 옮길 의미가 없다).
    if (tables.has(`${prefix}${YC_TABLES.cart}`)) {
      // 멱등: 이미 항목이 들어 있는 주문은 건너뛴다.
      //
      // 주문 자체를 건너뛰는 것만으로는 부족하다 — 항목 루프는 장바구니 테이블을
      // 훑으므로 다시 실행하면 같은 항목이 또 들어간다(실제로 재실행에서 10개가 됐다).
      // "새로 만든 주문만" 으로 판단하지 않는 이유: 이전이 중간에 실패해
      // 주문은 있고 항목은 없는 상태가 남을 수 있고, 그때 다시 채워야 한다.
      const filled = new Set<string>();
      const { rows: existingItems } = await this.db.execute(sql`
        SELECT DISTINCT order_id FROM shop_order_items
      `);
      for (const r of existingItems) filled.add(String(r.order_id));

      for (const row of readRows(dump, `${prefix}${YC_TABLES.cart}`, tables)) {
        const odId = String(row.od_id ?? "").trim();
        if (!odId) continue;
        const orderId = orderMap.get(odId);
        if (!orderId) continue;
        if (filled.has(orderId)) continue;

        const qty = Math.max(1, Math.floor(Number(row.ct_qty ?? 1)) || 1);
        const unitPrice = Math.max(0, Math.floor(Number(row.ct_price ?? 0)) || 0);
        // 옵션 추가금은 별도 컬럼(io_price)에 있다. 단가에 더해 두면
        // 나중에 "이 항목이 얼마였는가"가 맞는다.
        const optPrice = Math.floor(Number(row.io_price ?? 0)) || 0;

        await this.db.execute(sql`
          INSERT INTO shop_order_items
            (id, order_id, product_id, option_id, product_name, option_name,
             unit_price, quantity, line_total, tax_free)
          VALUES
            (${uuidv7()}, ${orderId}::uuid,
             ${itemMap.get(String(row.it_id ?? "")) ? sql`${itemMap.get(String(row.it_id))}::uuid` : sql`NULL`},
             NULL,
             ${String(row.it_name ?? "(상품 없음)").slice(0, 300)},
             ${String(row.ct_option ?? "").slice(0, 200) || null},
             ${unitPrice + optPrice}, ${qty}, ${(unitPrice + optPrice) * qty},
             -- 과거 주문의 면세 여부도 스냅샷으로 남긴다. 부가세 신고 자료가
             -- 이전한 주문까지 포함하므로, 없으면 과세로 잡혀 세금이 늘어난다.
             ${String(row.io_notax ?? row.it_notax ?? "0") === "1"})
        `);
        result.shop.orderItems += 1;
      }
    }

    // 판매수량을 주문 항목에서 다시 센다.
    // 주문을 넣을 때 하나씩 올리면 중간에 실패했을 때 어긋난다.
    await this.db.execute(sql`
      UPDATE shop_products p SET sold_count = coalesce(agg.n, 0)
      FROM (
        SELECT oi.product_id, sum(oi.quantity) AS n
        FROM shop_order_items oi
        JOIN shop_orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('cancelled', 'refunded') AND oi.product_id IS NOT NULL
        GROUP BY oi.product_id
      ) AS agg
      WHERE p.id = agg.product_id
    `);

    await this.importWishlist(dump, tables, prefix, memberMap, itemMap, result, warnings);
  }

  /**
   * 위시리스트(`g5_shop_wish`).
   *
   * 옮기지 않으면 회원이 몇 년 담아 둔 목록이 로그인하는 순간 비어 있다 —
   * 사이트를 옮겼다는 사실을 손님이 가장 먼저 알아채는 자리다.
   * 비회원이 담은 것은 옮기지 않는다(그누보드도 회원만 담는다).
   */
  private async importWishlist(
    dump: string,
    tables: Map<string, DumpTable>,
    prefix: string,
    memberMap: Map<string, string>,
    itemMap: Map<string, string>,
    result: RunResult,
    warnings: string[],
  ): Promise<void> {
    const table = `${prefix}shop_wish`;
    if (!tables.has(table) || !(await this.tableExists("shop_wishlist"))) return;
    let created = 0;
    for (const row of readRows(dump, table, tables)) {
      const userId = memberMap.get(String(row.mb_id ?? "").trim());
      const productId = itemMap.get(String(row.it_id ?? "").trim());
      if (!userId || !productId) continue;
      const { rows } = await this.db.execute(sql`
        INSERT INTO shop_wishlist (id, user_id, product_id, created_at)
        VALUES (${uuidv7()}, ${userId}::uuid, ${productId}::uuid,
                ${parseGnuDate(row.wi_time) ?? new Date()})
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      if (rows.length) created += 1;
    }
    if (created) {
      result.wishlist.created += created;
      warnings.push(`위시리스트 ${created}건을 옮겼습니다.`);
    }
  }

  private async tableExists(table: string): Promise<boolean> {
    const { rows } = await this.db.execute(sql`SELECT to_regclass(${table}) IS NOT NULL AS ok`);
    return rows[0]?.ok === true;
  }

  private async findExistingEmails(emails: string[]): Promise<string[]> {
    if (!emails.length) return [];
    const found: string[] = [];
    // 한 번에 다 보내면 파라미터 한도에 걸린다
    for (let i = 0; i < emails.length; i += 500) {
      const chunk = emails.slice(i, i + 500);
      const list = sql.join(chunk.map((e) => sql`${e}`), sql`, `);
      const { rows } = await this.db.execute(sql`
        SELECT email FROM users WHERE email IN (${list})
      `);
      found.push(...rows.map((r) => String(r.email)));
    }
    return found;
  }
}
