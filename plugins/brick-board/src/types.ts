import type { PluginDb } from "@brick/plugin-sdk";

/** 재고·포인트처럼 원자성이 필요한 로직은 transaction()을 쓴다 */
export type Db = PluginDb;

/** 플러그인 라우트에서 HTTP 상태코드를 지정해 던지는 에러 */
export class BoardError extends Error {
  constructor(
    public status: number,
    message: string,
    /** 어느 칸·조치가 문제인가 — "identity" 면 화면이 본인인증으로 가는 길을 붙인다 */
    public field?: string,
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

/*
 * 권한 등급은 코어가 들고 있다 — 게시판이 갖고 있던 정의를 옮겼다.
 * 권한 비교를 두 곳에 두면 한쪽만 고쳐지고, 그 어긋남이 곧 권한 구멍이 된다.
 */
import { rankOf, siteDateParts } from "@brick/plugin-sdk";
export { ROLE_RANK, rankOf, hasRole, type RoleBearer } from "@brick/plugin-sdk";

export interface BoardRow {
  id: string;
  /** 게시판 관리자(운영자가 이 게시판에 지정한 회원)의 id — 이 게시판 안에서만 운영진처럼 */
  moderator_ids?: string[];
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
  /** 본인인증 요구 — "" 없음 · verified 본인인증 회원만 · adult 성인만 (그누보드 bo_use_cert) */
  cert_required?: "" | "verified" | "adult";
  /**
   * 여분 필드 — 게시판마다 정하는 추가 입력칸 (그누보드의 `wr_1`~`wr_10`).
   *
   * 칸 이름은 게시판이 갖고 값은 글이 갖는다. 키는 자리 번호다(`f1`…`f10`) —
   * 그누보드와 같은 방식이라, 옮겨 온 사이트의 운영자가 알던 그대로다.
   */
  extra_fields?: ExtraField[];
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

/** 여분 필드 하나 — 자리 번호와 운영자가 붙인 이름 */
export interface ExtraField {
  /** `f1` ~ `f10`. 자리 번호이므로 줄 순서를 바꾸면 값이 어긋난다(그누보드와 같다) */
  key: string;
  label: string;
}

/** 열 칸까지 — 그누보드가 정한 수이고, 그보다 많으면 글쓰기 폼이 설문지가 된다 */
export const MAX_EXTRA_FIELDS = 10;
/** 한 칸에 담을 수 있는 길이 — 본문이 아니라 항목이다 */
export const EXTRA_VALUE_MAX = 500;

/**
 * 줄 단위 이름 목록 → 여분 필드 정의.
 *
 * 쉼표가 아니라 **줄**로 나눈다 — "연락처(집, 휴대폰)" 처럼 이름에 쉼표가
 * 들어가는 일이 흔하다(분류는 쉼표를 쓰지만 그건 짧은 낱말이다).
 */
export function parseExtraFields(text: unknown): ExtraField[] {
  return String(text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_EXTRA_FIELDS)
    .map((label, i) => ({ key: `f${i + 1}`, label: label.slice(0, 50) }));
}

/** 정의된 칸만, 길이를 잘라서 — 화면이 보내지 않은 칸은 빈 값으로 두지 않고 뺀다 */
export function pickExtraValues(input: unknown, fields: ExtraField[]): Record<string, string> {
  const src = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = String(src[f.key] ?? "").trim();
    if (v) out[f.key] = v.slice(0, EXTRA_VALUE_MAX);
  }
  return out;
}

/** 게시판 행에서 여분 필드 정의를 꺼낸다 (jsonb 가 무엇이든 안전하게) */
export function extraFieldsOf(row: unknown): ExtraField[] {
  const raw = (row as { extra_fields?: unknown } | null)?.extra_fields;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is ExtraField => Boolean(f) && typeof (f as ExtraField).key === "string")
    .map((f) => ({ key: String(f.key), label: String(f.label ?? "") }))
    .slice(0, MAX_EXTRA_FIELDS);
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
/*
 * 서버가 그리는 시각은 **사이트 시간대**로 찍는다.
 *
 * `d.getFullYear()`·`getHours()` 는 컨테이너의 시간대다. Docker 기본은 UTC 이고
 * 이 저장소는 TZ 를 어디에도 지정하지 않으므로, 한국 시간 0시 30분에 쓴 글이
 * 목록에 "09.11 15:30" 으로 보였다 — 날짜까지 하루 어긋난다.
 */
export function fullDate(value: unknown): string {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const p = siteDateParts(d);
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
}

export function shortDate(value: unknown): string {
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  const p = siteDateParts(d);
  const now = siteDateParts(new Date());
  const sameDay = p.year === now.year && p.month === now.month && p.day === now.day;
  return sameDay ? `${p.hour}:${p.minute}` : `${p.month}.${p.day}`;
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

/**
 * 누구에게나 보여도 되는 글 — 사이트맵·최근 글 위젯처럼 **보는 사람을 모르는** 통로의 조건.
 *
 * 게시판 권한만 보면 회원 전용 그룹 안의 글이 새고, 공개를 끈 게시판·본인인증 게시판의 글도 샌다.
 * 통로마다 조건을 따로 적어서 실제로 셋이 서로 달랐다 — 한 곳에 둔다. (`b` = board_boards,
 * `g` = board_groups LEFT JOIN, `p` = board_posts)
 */
export const PUBLIC_POST_SQL = `p.is_secret = false AND b.is_visible = true AND b.read_role = 'guest'
  AND coalesce(g.read_role, 'guest') = 'guest' AND b.cert_required = ''`;
