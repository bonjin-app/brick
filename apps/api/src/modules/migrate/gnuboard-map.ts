/**
 * 그누보드5 → Brick 매핑.
 *
 * 이 파일이 다루는 것은 "어떤 컬럼이 어디로 가는가"가 아니라
 * **표현할 수 없는 것을 어떻게 접는가**다. 그게 이전 도구에서 실제로 어려운 부분이다.
 */

/** 그누보드 회원 레벨(1~10) → Brick 역할(4단) */
export type BrickRole = "admin" | "manager" | "member";

/**
 * 레벨을 역할로 접는다.
 *
 * 왜 접는가: 플러그인끼리 레벨 숫자의 의미를 합의할 수 없다(ADR-25).
 * "레벨 5 이상 쓰기"는 그 사이트에서만 뜻이 있고, 다른 플러그인은 5가 무엇인지 모른다.
 *
 * 기본 경계값의 근거:
 *   그누보드 기본 설정에서 최고관리자는 10, 그룹·게시판 관리자는 보통 8~9,
 *   일반 회원은 2(가입 기본값)다. 그래서 10=admin, 8~9=manager, 그 아래는 member.
 *   사이트마다 다르므로 **미리 보여주고 조정받는다** — 이전 도구가 조용히
 *   결정하면 관리자였던 사람이 일반 회원이 되거나 그 반대가 된다.
 */
export interface LevelMapping {
  /** 이 레벨 이상은 admin */
  adminFrom: number;
  /** 이 레벨 이상은 manager (adminFrom 미만) */
  managerFrom: number;
}

export const DEFAULT_LEVEL_MAPPING: LevelMapping = { adminFrom: 10, managerFrom: 8 };

export function levelToRole(level: number, mapping: LevelMapping): BrickRole {
  if (level >= mapping.adminFrom) return "admin";
  if (level >= mapping.managerFrom) return "manager";
  return "member";
}

/**
 * 게시판 읽기·쓰기 레벨 → Brick 역할.
 *
 * 게시판 권한은 회원 등급과 경계가 다르다. 그누보드에서 읽기 레벨 1은
 * "비회원도 읽기"를 뜻한다(레벨 1이 비회원). 2 이상이면 로그인이 필요하다.
 */
export function boardLevelToRole(level: number, mapping: LevelMapping): "guest" | BrickRole {
  if (level <= 1) return "guest";
  if (level >= mapping.adminFrom) return "admin";
  if (level >= mapping.managerFrom) return "manager";
  return "member";
}

/**
 * 그누보드 비밀번호 해시를 Brick 이 검증할 수 있는 형태로 감싼다.
 *
 * **회원이 비밀번호를 다시 만들지 않아야 한다.** 이전 후 전원이 비밀번호
 * 재설정을 해야 하면 상당수가 돌아오지 않는다 — 이전 도구의 성패가 여기 걸려 있다.
 *
 * 그누보드가 쓰는 해시:
 *   - 5.3 이후: PHP password_hash() = bcrypt, `$2y$10$...`
 *   - 그 이전: 자체 MD5 계열 (`mb_password` 컬럼에 32자 hex)
 *   - 5.4 일부: sha256 (64자 hex)
 *
 * Brick 은 argon2id 를 쓴다. 그래서 원본 해시를 접두어로 표시해 저장하고,
 * **첫 로그인에 성공하면 argon2 로 다시 해시한다**(자동 승급).
 * 접두어를 붙이는 이유: argon2.verify 가 형식이 다른 값에 예외를 던지므로,
 * 어떤 방식으로 검증할지 저장된 값만 보고 알아야 한다.
 */
export function wrapLegacyHash(raw: string): string | null {
  const h = String(raw ?? "").trim();
  if (!h) return null;

  // bcrypt — $2y$ 는 PHP 변종이고 $2b$ 와 알고리즘이 같다
  if (/^\$2[aby]\$\d{2}\$.{53}$/.test(h)) {
    return `legacy:bcrypt:${h}`;
  }
  // 그누보드 구형 MD5 (32자 hex)
  if (/^[0-9a-f]{32}$/i.test(h)) {
    return `legacy:gnu-md5:${h.toLowerCase()}`;
  }
  // sha256 (64자 hex)
  if (/^[0-9a-f]{64}$/i.test(h)) {
    return `legacy:sha256:${h.toLowerCase()}`;
  }
  // 알 수 없는 형식 — 비밀번호로 로그인할 수 없게 두고 재설정을 안내한다.
  // 임의로 추측해 검증하면 잘못된 비밀번호를 통과시킬 위험이 있다.
  return null;
}

/**
 * 그누보드 날짜 → Date.
 *
 * MySQL 의 '0000-00-00 00:00:00' 은 유효한 날짜가 아니다(그누보드 데이터에 흔하다).
 * new Date() 에 넣으면 Invalid Date 가 되어 INSERT 가 실패한다.
 */
export function parseGnuDate(v: string | null | undefined): Date | null {
  const s = String(v ?? "").trim();
  if (!s || s.startsWith("0000-00-00")) return null;
  const d = new Date(s.replace(" ", "T") + (s.includes("Z") ? "" : "Z"));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** 그누보드 slug(bo_table)를 Brick 규칙에 맞춘다 */
export function normalizeSlug(raw: string): string {
  const s = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s.slice(0, 100) || "board";
}

/**
 * 그누보드 이메일 정리.
 *
 * 그누보드는 이메일 중복을 허용하는 설정이 있고, 빈 이메일도 가능하다.
 * Brick 은 이메일이 유니크한 식별자다 — 그래서 정리가 필요하다.
 */
export function normalizeEmail(raw: string | null, memberId: string): string {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return e;
  // 이메일이 없는 회원 — 아이디로 내부 주소를 만든다.
  // .invalid 는 예약된 TLD 라 실제로 메일이 나가지 않는다(소셜 로그인과 같은 방식).
  const safe = memberId.replace(/[^a-zA-Z0-9._-]/g, "") || "member";
  return `${safe}@gnuboard.invalid`;
}

/** 게시글 본문의 그누보드 표기를 정리한다 */
export function convertContent(raw: string | null, html: string | null): string {
  const body = String(raw ?? "");
  // wr_option 에 'html1'/'html2' 가 있으면 HTML, 없으면 평문이다.
  // 평문을 그대로 두면 줄바꿈이 사라지므로 <br> 로 바꾼다.
  const isHtml = String(html ?? "").includes("html");
  if (isHtml) return body;
  return body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br />\n");
}

/**
 * 본문·이미지의 그누보드 경로를 Brick 경로로 바꾼다.
 *
 * 그누보드의 파일은 전부 /data/ 아래에 있다: 게시판 첨부는 /data/file/,
 * 에디터 업로드는 /data/editor/, 영카트 상품 이미지는 /data/item/.
 * 파일을 uploads/ 로 복사한 뒤(문서의 복사 표) 주소가 그대로면 이미지가
 * 전부 깨진다 — 옮긴 사이트가 고장 나 보이는 가장 흔한 이유였다.
 *
 * oldBaseUrl 을 주면 절대주소(https://old.example.com/data/...)도 잡는다.
 * http/https 프로토콜이 달라도 host 가 같으면 잡는다 — 옛 사이트가 http 였던
 * 경우 본문에는 http 주소가 남아 있다.
 */
export function rewriteLegacyMediaUrls(html: string, oldBaseUrl?: string | null): string {
  let out = html;
  const base = String(oldBaseUrl ?? "").trim();
  if (base) {
    let host = "";
    try {
      host = new URL(base.includes("://") ? base : `https://${base}`).host;
    } catch {
      host = "";
    }
    if (host) {
      const esc = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 절대주소를 루트 상대주소로 — 아래 규칙이 이어서 처리한다
      out = out.replace(new RegExp(`https?://${esc}(?=/data/)`, "g"), "");
    }
  }
  return out
    .replace(/\/data\/file\//g, "/uploads/")
    .replace(/\/data\/editor\//g, "/uploads/editor/")
    .replace(/\/data\/item\//g, "/uploads/item/");
}

/**
 * 이전 대상 테이블.
 *
 * 그누보드는 게시판마다 `write_<bo_table>` 테이블을 따로 만든다.
 * 그래서 게시글 테이블 목록은 board 테이블을 읽은 뒤에 결정된다.
 */
export const GNU_TABLES = {
  member: "member",
  board: "board",
  boardGroup: "group",
  point: "point",
  /** 게시글 테이블 접두어 — write_<bo_table> */
  writePrefix: "write_",
} as const;

export interface MigratePlan {
  prefix: string;
  levelMapping: LevelMapping;
  /** 옮길 게시판 (bo_table) — 비우면 전체 */
  boards: string[];
  /** 회원을 옮기는가 */
  members: boolean;
  /** 포인트 잔액을 옮기는가 */
  points: boolean;
  /** 영카트 상품·주문을 옮기는가 (기본 true) */
  shop?: boolean;
  /** 이미 있는 이메일을 만나면 건너뛴다(false) 또는 실패로 본다(true) */
  strictEmail: boolean;
  /**
   * 본문·이미지의 /data/ 경로를 /uploads/ 로 바꾼다 (기본 true).
   * 리버스 프록시로 /data/ 를 직접 서빙하려는 경우에만 끈다.
   */
  imageRewrite?: boolean;
  /** 옛 사이트 주소 — 본문의 절대주소 이미지도 잡는다 (예: https://old.example.com) */
  oldBaseUrl?: string;
}
