import type { PluginDb } from "@brick/plugin-sdk";

/** 재고·포인트처럼 원자성이 필요한 로직은 transaction()을 쓴다 */
export type Db = PluginDb;

/** 플러그인 라우트에서 HTTP 상태코드를 지정해 던지는 에러 */
export class BoardError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionUser {
  id: string;
  role: string;
  displayName: string;
  /** 라우트 컨텍스트에는 있지만 블록 렌더 컨텍스트에는 없다 */
  email?: string;
}

/** 권한 검사에 필요한 최소 형태 — 라우트와 블록 컨텍스트 양쪽을 받는다 */
export type RoleBearer = { role: string } | null | undefined;

/**
 * 권한 등급.
 *
 * 그누보드는 1~10 레벨을 쓰지만 Brick의 역할 모델(admin/manager/member)에 맞춘다.
 * 숫자가 클수록 높은 권한이다.
 */
export const ROLE_RANK: Record<string, number> = {
  guest: 0,
  member: 1,
  manager: 2,
  admin: 3,
};

export function rankOf(role: string | undefined | null): number {
  return ROLE_RANK[role ?? "guest"] ?? 0;
}

/** user가 required 등급 이상인가 */
export function hasRole(user: RoleBearer, required: string): boolean {
  return rankOf(user?.role ?? "guest") >= rankOf(required);
}

export interface BoardRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  read_role: string;
  write_role: string;
  comment_role: string;
  download_role: string;
  categories: string[];
  page_size: number;
  allow_reply: boolean;
  allow_secret: boolean;
  allow_vote: boolean;
  allow_upload: boolean;
  max_files: number;
  write_interval: number;
  /** 목록 스킨 — basic(표) | gallery(썸네일 격자) | webzine(카드 목록) */
  list_style: string;
  /** 새 글 알림을 받을 주소. 비우면 보내지 않는다 */
  notify_email: string | null;
  /** 댓글이 달리면 원글 작성자에게 메일 */
  notify_comment: boolean;
  /** 분류가 있는 게시판에서 분류 선택을 강제한다 */
  category_required?: boolean;
  /** 소속 그룹 (없으면 null). read_role 은 이미 그룹과 합쳐진 실효 권한이다 */
  group_id?: string | null;
  group_title?: string | null;
}

/**
 * 실효 읽기 권한 — 게시판과 그룹 중 더 엄격한 쪽.
 * 그룹을 "회원"으로 두면 안의 게시판이 "누구나"여도 회원만 읽는다(그누보드의 그룹 권한).
 */
export function effectiveReadRole(boardRole: unknown, groupRole: unknown): string {
  const b = String(boardRole ?? "guest"), g = String(groupRole ?? "guest");
  return rankOf(b) >= rankOf(g) ? b : g;
}

export const LIST_STYLES = ["basic", "gallery", "webzine"] as const;
export type ListStyle = (typeof LIST_STYLES)[number];
export const asListStyle = (v: unknown): ListStyle =>
  (LIST_STYLES as readonly string[]).includes(String(v)) ? (v as ListStyle) : "basic";

/** 업로드 허용 확장자 — 화이트리스트 (실행 가능한 형식은 절대 허용하지 않는다) */
export const ALLOWED_UPLOAD: Record<string, string[]> = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
  ".pdf": ["application/pdf"],
  ".zip": ["application/zip", "application/x-zip-compressed"],
  ".txt": ["text/plain"],
  ".csv": ["text/csv", "application/vnd.ms-excel"],
  ".hwp": ["application/x-hwp", "application/haansofthwp", "application/octet-stream"],
  ".doc": ["application/msword"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xls": ["application/vnd.ms-excel"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".ppt": ["application/vnd.ms-powerpoint"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".mp4": ["video/mp4"],
};

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** 파일 크기를 사람이 읽는 형태로 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 상대 시간 (오늘은 시각, 그 외는 날짜) */
/**
 * 전체 일시 — "2026.09.01 14:06".
 *
 * toLocaleString(locale) 을 쓰지 않는다 — Node 의 ICU 데이터 구성에 따라
 * ko-KR 이 "PM 2:06:35" 같은 반쪽 영문으로 나온다(실제로 그랬다).
 * 날짜 표기는 런타임이 아니라 우리가 정한다.
 */
export function fullDate(value: unknown): string {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function shortDate(value: unknown): string {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * PostgreSQL 배열 리터럴 — `$1::uuid[]` 에 넣을 문자열.
 *
 * drizzle 의 sql 템플릿은 JS 배열을 **파라미터 나열**로 푼다: `ANY(${ids})` 는
 * `ANY(($1, $2))` 가 되어 구문 오류가 나고, 원소가 하나면 스칼라로 넘어가
 * "malformed array literal" 이 난다. 배열 하나를 문자열 리터럴로 만들어 넘기면
 * 파라미터 하나로 안전하게 캐스팅된다. 값의 `"` `\` 는 리터럴 규칙대로 이스케이프한다.
 */
export function pgArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
