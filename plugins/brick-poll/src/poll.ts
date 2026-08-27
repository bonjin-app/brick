import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { createHash } from "node:crypto";
import type { PluginDb } from "@brick/plugin-sdk";

export type Db = PluginDb;

export class PollError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * 설문조사.
 *
 * 설계에서 어려운 것 두 가지:
 *
 * 1. **중복 투표 방지.** 회원은 쉽지만 비회원은 IP 밖에 없다. IP 원문을 저장하면
 *    "누가 무엇에 투표했는가"가 되어 민감한 개인정보가 되므로 해시로만 남긴다.
 *    완벽하지 않다 — 같은 공유기 아래 여러 사람이 한 표로 묶인다. 완벽한 방지는
 *    본인 인증뿐이고, 설문에 그 비용을 요구할 수는 없다. 문서에 명시한다.
 *
 * 2. **결과 공개 시점.** 투표 전에 결과를 보여주면 표가 쏠린다(밴드왜건).
 *    기본값은 "내가 투표한 뒤"다.
 */

export const RESULT_VISIBILITY = ["always", "after_vote", "after_close"] as const;
export type ResultVisibility = (typeof RESULT_VISIBILITY)[number];

export const VISIBILITY_LABEL: Record<ResultVisibility, string> = {
  always: "항상 공개",
  after_vote: "투표 후 공개",
  after_close: "종료 후 공개",
};

export const VOTE_ROLES = ["guest", "member"] as const;
export const ROLE_LABEL: Record<string, string> = {
  guest: "누구나",
  member: "회원만",
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,98}$/;

/**
 * 투표자 해시.
 *
 * 설문 id 를 섞는다 — 같은 IP 가 여러 설문에서 같은 해시를 갖지 않게 해서,
 * 해시를 모아도 "이 사람이 참여한 설문 목록"을 만들 수 없게 한다.
 */
function voterHash(pollId: string, ip: string): string {
  return createHash("sha256").update(`poll:${pollId}:${ip}`).digest("hex").slice(0, 64);
}

export interface PollRow {
  id: string;
  slug: string;
  question: string;
  description: string | null;
  allow_multiple: boolean;
  max_choices: number;
  vote_role: string;
  result_visibility: string;
  allow_comment: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: boolean;
  vote_count: number;
}

/** 지금 투표할 수 있는 상태인가 */
export function pollPhase(poll: PollRow): "before" | "open" | "closed" | "inactive" {
  if (!poll.is_active) return "inactive";
  const now = Date.now();
  if (poll.starts_at && now < new Date(poll.starts_at).getTime()) return "before";
  if (poll.ends_at && now > new Date(poll.ends_at).getTime()) return "closed";
  return "open";
}

/** 결과를 지금 보여줄 수 있는가 */
export function canSeeResults(
  poll: PollRow,
  params: { hasVoted: boolean; isManager: boolean },
): boolean {
  if (params.isManager) return true;
  switch (poll.result_visibility as ResultVisibility) {
    case "always":
      return true;
    case "after_vote":
      return params.hasVoted;
    case "after_close":
      return pollPhase(poll) === "closed";
    default:
      return false;
  }
}

async function findPoll(db: Db, idOrSlug: string): Promise<PollRow | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const { rows } = await db.execute(
    isUuid
      ? sql`SELECT * FROM poll_polls WHERE id = ${idOrSlug}::uuid LIMIT 1`
      : sql`SELECT * FROM poll_polls WHERE slug = ${idOrSlug} LIMIT 1`,
  );
  return (rows[0] as unknown as PollRow) ?? null;
}

/**
 * 설문 조회 — 선택지와 내 투표 여부, 그리고 **보여줄 수 있으면** 결과.
 *
 * 결과를 숨겨야 할 때는 득표 수를 응답에 아예 넣지 않는다.
 * 화면에서 가리는 방식으로 하면 개발자 도구로 볼 수 있다.
 */
export async function getPoll(
  db: Db,
  params: {
    idOrSlug: string;
    viewer: { id: string; role: string } | null;
    ip?: string | null;
    /** 관리자 화면에서 부를 때 — 비활성 설문도 본다 */
    includeInactive?: boolean;
  },
) {
  const poll = await findPoll(db, params.idOrSlug);
  if (!poll) throw new PollError(404, "설문을 찾을 수 없습니다.");

  const isManager = params.viewer?.role === "admin" || params.viewer?.role === "manager";
  if (!poll.is_active && !isManager && !params.includeInactive) {
    throw new PollError(404, "설문을 찾을 수 없습니다.");
  }

  const myVote = await findMyVote(db, {
    pollId: poll.id,
    viewer: params.viewer,
    ip: params.ip,
  });
  const hasVoted = Boolean(myVote);
  const showResults = canSeeResults(poll, { hasVoted, isManager });

  const { rows: options } = await db.execute(sql`
    SELECT id, label, sort_order, vote_count FROM poll_options
    WHERE poll_id = ${poll.id}::uuid ORDER BY sort_order, label
  `);

  const totalChoices = options.reduce((sum, o) => sum + Number(o.vote_count), 0);
  const phase = pollPhase(poll);

  return {
    poll: {
      id: poll.id,
      slug: poll.slug,
      question: poll.question,
      description: poll.description,
      allowMultiple: poll.allow_multiple,
      maxChoices: poll.max_choices,
      voteRole: poll.vote_role,
      allowComment: poll.allow_comment,
      resultVisibility: poll.result_visibility,
      startsAt: poll.starts_at,
      endsAt: poll.ends_at,
      phase,
      // 자격도 함께 본다. 이걸 빼면 회원 전용 설문에서 비로그인 사용자에게
      // 투표 버튼이 보이고, 누르면 401 이 난다.
      canVote:
        phase === "open" &&
        !hasVoted &&
        !(poll.vote_role === "member" && !params.viewer),
      // 왜 투표할 수 없는지 알려준다 — 버튼만 비활성이면 사용자가 이유를 모른다
      blockedReason: voteBlockedReason(poll, { phase, hasVoted, viewer: params.viewer }),
      voteCount: Number(poll.vote_count),
    },
    options: options.map((o) => ({
      id: String(o.id),
      label: String(o.label),
      // 결과를 숨겨야 하면 득표 수를 넣지 않는다 (화면에서 가리는 것으로는 부족하다)
      ...(showResults
        ? {
            voteCount: Number(o.vote_count),
            percent:
              totalChoices > 0
                ? Math.round((Number(o.vote_count) / totalChoices) * 1000) / 10
                : 0,
          }
        : {}),
      mine: myVote?.optionIds.includes(String(o.id)) ?? false,
    })),
    showResults,
    hasVoted,
    myComment: myVote?.comment ?? null,
  };
}

function voteBlockedReason(
  poll: PollRow,
  ctx: {
    phase: ReturnType<typeof pollPhase>;
    hasVoted: boolean;
    viewer: { id: string; role: string } | null;
  },
): string | null {
  if (ctx.hasVoted) return "이미 참여하셨습니다.";
  if (ctx.phase === "inactive") return "종료된 설문입니다.";
  if (ctx.phase === "before") return "아직 시작되지 않은 설문입니다.";
  if (ctx.phase === "closed") return "설문이 종료되었습니다.";
  if (poll.vote_role === "member" && !ctx.viewer) return "로그인 후 참여할 수 있습니다.";
  return null;
}

async function findMyVote(
  db: Db,
  params: { pollId: string; viewer: { id: string } | null; ip?: string | null },
): Promise<{ id: string; optionIds: string[]; comment: string | null } | null> {
  const where = params.viewer
    ? sql`poll_id = ${params.pollId}::uuid AND user_id = ${params.viewer.id}::uuid`
    : params.ip
      ? sql`poll_id = ${params.pollId}::uuid AND voter_hash = ${voterHash(params.pollId, params.ip)}`
      : null;
  if (!where) return null;

  const { rows } = await db.execute(sql`
    SELECT id, comment FROM poll_votes WHERE ${where} LIMIT 1
  `);
  if (!rows[0]) return null;

  const voteId = String(rows[0].id);
  const { rows: choices } = await db.execute(sql`
    SELECT option_id FROM poll_vote_choices WHERE vote_id = ${voteId}::uuid
  `);
  return {
    id: voteId,
    optionIds: choices.map((c) => String(c.option_id)),
    comment: rows[0].comment ? String(rows[0].comment) : null,
  };
}

/**
 * 투표.
 *
 * 득표 수를 두 곳(poll_options.vote_count, poll_polls.vote_count)에 누적한다.
 * 매번 집계 쿼리를 돌리면 표가 많아질수록 느려지고, 설문 결과는 가장 자주
 * 읽히는 화면이다. 대신 **한 트랜잭션 안에서** 갱신해 원장과 어긋나지 않게 한다.
 */
export async function vote(
  db: Db,
  params: {
    idOrSlug: string;
    optionIds: string[];
    comment?: string;
    viewer: { id: string; role: string } | null;
    ip?: string | null;
  },
): Promise<{ voteId: string }> {
  const poll = await findPoll(db, params.idOrSlug);
  if (!poll) throw new PollError(404, "설문을 찾을 수 없습니다.");

  const phase = pollPhase(poll);
  if (phase !== "open") {
    throw new PollError(
      409,
      phase === "before" ? "아직 시작되지 않은 설문입니다." : "종료된 설문입니다.",
    );
  }
  if (poll.vote_role === "member" && !params.viewer) {
    throw new PollError(401, "로그인 후 참여할 수 있습니다.");
  }
  // 비회원 투표에는 IP 가 필요하다. 없으면 중복을 판정할 수 없어 무한 투표가 된다.
  if (!params.viewer && !params.ip) {
    throw new PollError(400, "투표자를 식별할 수 없습니다.");
  }

  const picked = [...new Set((params.optionIds ?? []).map(String))];
  if (!picked.length) throw new PollError(400, "선택지를 골라주세요.");
  if (!poll.allow_multiple && picked.length > 1) {
    throw new PollError(400, "하나만 선택할 수 있습니다.");
  }
  if (picked.length > poll.max_choices) {
    throw new PollError(400, `최대 ${poll.max_choices}개까지 선택할 수 있습니다.`);
  }

  // 이 설문의 선택지인지 확인한다. 남의 설문 선택지 id 를 보내면
  // 그 설문의 득표가 오염된다.
  const list = sql.join(picked.map((id) => sql`${id}::uuid`), sql`, `);
  const { rows: valid } = await db.execute(sql`
    SELECT id FROM poll_options WHERE poll_id = ${poll.id}::uuid AND id IN (${list})
  `);
  if (valid.length !== picked.length) {
    throw new PollError(400, "선택지가 올바르지 않습니다.");
  }

  const comment = poll.allow_comment ? String(params.comment ?? "").trim().slice(0, 1000) : "";
  const voteId = uuidv7();
  const hash = params.viewer ? null : voterHash(poll.id, String(params.ip));

  await db.transaction(async (tx) => {
    try {
      await tx.execute(sql`
        INSERT INTO poll_votes (id, poll_id, user_id, voter_hash, comment)
        VALUES (${voteId}, ${poll.id}::uuid,
                ${params.viewer ? sql`${params.viewer.id}::uuid` : sql`NULL`},
                ${hash}, ${comment || null})
      `);
    } catch (err) {
      // 유니크 인덱스가 중복 투표를 막는다. 앱에서 먼저 확인해도 동시 요청은
      // 통과할 수 있으므로 DB 제약이 최종 방어선이다.
      throw new PollError(409, "이미 참여하셨습니다.");
    }

    for (const optionId of picked) {
      await tx.execute(sql`
        INSERT INTO poll_vote_choices (vote_id, option_id)
        VALUES (${voteId}::uuid, ${optionId}::uuid)
      `);
      await tx.execute(sql`
        UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ${optionId}::uuid
      `);
    }
    await tx.execute(sql`
      UPDATE poll_polls SET vote_count = vote_count + 1, updated_at = now()
      WHERE id = ${poll.id}::uuid
    `);
  });

  return { voteId };
}

/** 공개 설문 목록 — 블록이 "진행 중인 설문"을 보여주는 데 쓴다 */
export async function listActivePolls(db: Db, limit = 10) {
  const { rows } = await db.execute(sql`
    SELECT id, slug, question, vote_count, starts_at, ends_at, result_visibility
    FROM poll_polls
    WHERE is_active = true
      AND (starts_at IS NULL OR starts_at <= now())
      AND (ends_at IS NULL OR ends_at >= now())
    ORDER BY created_at DESC
    LIMIT ${Math.min(50, Math.max(1, limit))}
  `);
  return { items: rows };
}

/* ── 관리자 ────────────────────────────────────────── */

export function validatePoll(b: Record<string, unknown>) {
  const slug = String(b.slug ?? "").trim();
  if (!SLUG_RE.test(slug)) {
    throw new PollError(400, "주소(slug)는 영문 소문자/숫자/하이픈만 사용합니다.");
  }
  const question = String(b.question ?? "").trim();
  if (!question) throw new PollError(400, "질문을 입력해주세요.");
  if (question.length > 500) throw new PollError(400, "질문이 너무 깁니다. (500자 이내)");

  const voteRole = String(b.vote_role ?? "guest");
  if (!VOTE_ROLES.includes(voteRole as never)) {
    throw new PollError(400, "투표 자격이 올바르지 않습니다.");
  }
  const visibility = String(b.result_visibility ?? "after_vote");
  if (!RESULT_VISIBILITY.includes(visibility as never)) {
    throw new PollError(400, "결과 공개 시점이 올바르지 않습니다.");
  }

  const allowMultiple = b.allow_multiple === true;
  const maxChoices = allowMultiple
    ? Math.min(20, Math.max(2, Math.floor(Number(b.max_choices ?? 2)) || 2))
    : 1;

  const startsAt = parseDate(b.starts_at);
  const endsAt = parseDate(b.ends_at);
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new PollError(400, "종료 시각이 시작 시각보다 빠릅니다.");
  }

  return {
    slug,
    question,
    description: String(b.description ?? "").trim() || null,
    allowMultiple,
    maxChoices,
    voteRole,
    visibility,
    allowComment: b.allow_comment === true,
    startsAt,
    endsAt,
    isActive: b.is_active !== false,
  };
}

function parseDate(v: unknown): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) throw new PollError(400, "날짜 형식이 올바르지 않습니다.");
  return d;
}

/**
 * 선택지 텍스트 파싱 — 한 줄에 하나.
 *
 * 선언적 관리 화면은 부모에 종속된 목록을 편집할 수 없다(ADR-12).
 * 상품 옵션과 같은 방식으로 줄바꿈 텍스트를 받는다.
 */
export function parseOptions(text: string): string[] {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new PollError(400, "선택지를 두 개 이상 입력해주세요.");
  if (lines.length > 50) throw new PollError(400, "선택지는 50개까지 등록할 수 있습니다.");

  const seen = new Set<string>();
  for (const line of lines) {
    if (line.length > 300) throw new PollError(400, `선택지가 너무 깁니다: ${line.slice(0, 30)}…`);
    const key = line.toLowerCase();
    if (seen.has(key)) throw new PollError(400, `선택지가 중복되었습니다: ${line}`);
    seen.add(key);
  }
  return lines;
}

export function formatOptions(rows: Array<{ label: unknown }>): string {
  return rows.map((r) => String(r.label)).join("\n");
}

/**
 * 선택지 동기화.
 *
 * 이름으로 짝지어 갱신한다. 전부 지우고 다시 넣으면 **득표가 사라진다** —
 * 진행 중인 설문에서 문구 오타를 고쳤을 뿐인데 표가 0이 되면 안 된다.
 */
export async function syncOptions(db: Db, pollId: string, labels: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const { rows: existing } = await tx.execute(sql`
      SELECT id, label FROM poll_options WHERE poll_id = ${pollId}::uuid
    `);
    const byLabel = new Map(existing.map((r) => [String(r.label).toLowerCase(), String(r.id)]));
    const keep = new Set<string>();

    for (const [index, label] of labels.entries()) {
      const id = byLabel.get(label.toLowerCase());
      if (id) {
        keep.add(id);
        await tx.execute(sql`
          UPDATE poll_options SET label = ${label}, sort_order = ${index} WHERE id = ${id}::uuid
        `);
      } else {
        const newId = uuidv7();
        keep.add(newId);
        await tx.execute(sql`
          INSERT INTO poll_options (id, poll_id, label, sort_order)
          VALUES (${newId}, ${pollId}::uuid, ${label}, ${index})
        `);
      }
    }

    for (const [, id] of byLabel) {
      if (keep.has(id)) continue;
      // 지워지는 선택지의 표는 사라진다. 참여자 수(poll_polls.vote_count)는
      // 그대로 두는 것이 맞다 — 그 사람들은 실제로 참여했다.
      await tx.execute(sql`DELETE FROM poll_options WHERE id = ${id}::uuid`);
    }
  });
}

export async function listPollsAdmin(db: Db, page: number) {
  const size = 30;
  const { rows } = await db.execute(sql`
    SELECT p.id, p.slug, p.question, p.description, p.allow_multiple, p.max_choices,
           p.vote_role, p.result_visibility, p.allow_comment, p.starts_at, p.ends_at,
           p.is_active, p.vote_count,
           coalesce(
             (SELECT json_agg(json_build_object('label', o.label) ORDER BY o.sort_order, o.label)
              FROM poll_options o WHERE o.poll_id = p.id),
             '[]'
           ) AS options
    FROM poll_polls p
    ORDER BY p.created_at DESC LIMIT ${size} OFFSET ${(Math.max(1, page) - 1) * size}
  `);
  const { rows: cnt } = await db.execute(sql`SELECT count(*) AS n FROM poll_polls`);
  return {
    items: rows.map((r) => ({
      ...r,
      options_text: formatOptions((r.options ?? []) as Array<{ label: unknown }>),
      visibility_label: VISIBILITY_LABEL[String(r.result_visibility) as ResultVisibility] ?? "",
      role_label: ROLE_LABEL[String(r.vote_role)] ?? "",
      options: undefined,
    })),
    total: Number(cnt[0]?.n ?? 0),
    page: Math.max(1, page),
    pageSize: size,
  };
}

/**
 * 기타 의견 목록 (관리자).
 *
 * 작성자를 함께 보여주지 않는다 — 설문은 익명이 전제이고,
 * "누가 무슨 의견을 냈는가"를 운영자가 볼 수 있으면 그 전제가 깨진다.
 */
export async function listComments(db: Db, pollId: string, page: number) {
  const size = 50;
  const { rows } = await db.execute(sql`
    SELECT comment, created_at FROM poll_votes
    WHERE poll_id = ${pollId}::uuid AND comment IS NOT NULL AND comment <> ''
    ORDER BY created_at DESC LIMIT ${size} OFFSET ${(Math.max(1, page) - 1) * size}
  `);
  const { rows: cnt } = await db.execute(sql`
    SELECT count(*) AS n FROM poll_votes
    WHERE poll_id = ${pollId}::uuid AND comment IS NOT NULL AND comment <> ''
  `);
  return { items: rows, total: Number(cnt[0]?.n ?? 0) };
}
