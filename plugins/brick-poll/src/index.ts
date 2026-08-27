import { definePlugin, isUniqueViolation, type AdminResource } from "@brick/plugin-sdk";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  PollError, RESULT_VISIBILITY, ROLE_LABEL, VISIBILITY_LABEL, VOTE_ROLES,
  getPoll, listActivePolls, listComments, listPollsAdmin, parseOptions,
  syncOptions, validatePoll, vote,
  type Db,
} from "./poll.js";
import { registerPollBlocks } from "./blocks.js";

/**
 * brick-poll — 설문조사 (그누보드의 설문조사에 대응).
 *
 * 두 가지가 설계의 핵심이다:
 *  - **중복 투표 방지**: 회원은 user_id, 비회원은 IP 해시. 원문을 저장하지 않는다.
 *  - **결과 공개 시점**: 투표 전에 보여주면 표가 쏠린다(밴드왜건).
 */
export default definePlugin(async (ctx) => {
  const db = ctx.db as Db;

  const requireManager = (req: { user: { role: string } | null }) => {
    if (req.user?.role !== "admin" && req.user?.role !== "manager") {
      throw new PollError(403, "권한이 없습니다.");
    }
  };

  // ════════════════════════════════════════════════════
  //  공개
  // ════════════════════════════════════════════════════

  ctx.registerRoute("GET", "/polls", async (req) =>
    await listActivePolls(db, Number(req.query.limit ?? 10)),
  );

  ctx.registerRoute("GET", "/polls/:idOrSlug", async (req) =>
    await getPoll(db, {
      idOrSlug: req.params.idOrSlug,
      viewer: req.user,
      ip: req.ip,
    }),
  );

  ctx.registerRoute("POST", "/polls/:idOrSlug/vote", async (req) => {
    const body = req.body as { optionIds?: string[]; optionId?: string; comment?: string };
    // 단일 선택 화면은 optionId 하나만 보낸다 — 양쪽을 받는다
    const optionIds = body?.optionIds?.length
      ? body.optionIds
      : body?.optionId
        ? [body.optionId]
        : [];

    const result = await vote(db, {
      idOrSlug: req.params.idOrSlug,
      optionIds,
      comment: body?.comment,
      viewer: req.user,
      ip: req.ip,
    });

    await ctx.cache.invalidateTag("pages");
    await ctx.hooks.doAction("poll.voted", {
      pollSlug: req.params.idOrSlug, userId: req.user?.id ?? null,
    });

    // 투표 직후 결과를 함께 준다 — 화면이 한 번 더 요청하지 않아도 되고,
    // after_vote 설정에서 방금 열린 결과를 바로 보여줄 수 있다
    const view = await getPoll(db, {
      idOrSlug: req.params.idOrSlug,
      viewer: req.user,
      ip: req.ip,
    });
    return { ok: true, voteId: result.voteId, ...view };
  });

  // ════════════════════════════════════════════════════
  //  관리자
  // ════════════════════════════════════════════════════

  ctx.registerRoute("GET", "/admin/polls", async (req) => {
    requireManager(req);
    return await listPollsAdmin(db, Number(req.query.page ?? 1));
  });

  ctx.registerRoute("POST", "/admin/polls", async (req) => {
    requireManager(req);
    const body = req.body as Record<string, unknown>;
    const v = validatePoll(body);
    const labels = parseOptions(String(body.options_text ?? ""));

    const id = uuidv7();
    try {
      await db.execute(sql`
        INSERT INTO poll_polls
          (id, slug, question, description, allow_multiple, max_choices, vote_role,
           result_visibility, allow_comment, starts_at, ends_at, is_active)
        VALUES
          (${id}, ${v.slug}, ${v.question}, ${v.description}, ${v.allowMultiple},
           ${v.maxChoices}, ${v.voteRole}, ${v.visibility}, ${v.allowComment},
           ${v.startsAt}, ${v.endsAt}, ${v.isActive})
      `);
    } catch (err) {
      if (isUniqueViolation(err, "poll_polls_slug")) {
        throw new PollError(409, "이미 사용 중인 주소(slug)입니다.");
      }
      throw err;
    }
    await syncOptions(db, id, labels);
    await ctx.cache.invalidateTag("pages");
    return { id };
  });

  ctx.registerRoute("PUT", "/admin/polls/:id", async (req) => {
    requireManager(req);
    const body = req.body as Record<string, unknown>;
    const v = validatePoll(body);
    const labels = parseOptions(String(body.options_text ?? ""));

    try {
      const { rows } = await db.execute(sql`
        UPDATE poll_polls SET
          slug = ${v.slug}, question = ${v.question}, description = ${v.description},
          allow_multiple = ${v.allowMultiple}, max_choices = ${v.maxChoices},
          vote_role = ${v.voteRole}, result_visibility = ${v.visibility},
          allow_comment = ${v.allowComment},
          starts_at = ${v.startsAt}, ends_at = ${v.endsAt}, is_active = ${v.isActive},
          updated_at = now()
        WHERE id = ${req.params.id}::uuid RETURNING id
      `);
      if (!rows.length) throw new PollError(404, "설문을 찾을 수 없습니다.");
    } catch (err) {
      if (isUniqueViolation(err, "poll_polls_slug")) {
        throw new PollError(409, "이미 사용 중인 주소(slug)입니다.");
      }
      throw err;
    }
    // 이름으로 짝지어 갱신한다 — 전부 지우면 진행 중인 설문의 득표가 사라진다
    await syncOptions(db, req.params.id, labels);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  ctx.registerRoute("DELETE", "/admin/polls/:id", async (req) => {
    requireManager(req);
    await db.execute(sql`DELETE FROM poll_polls WHERE id = ${req.params.id}::uuid`);
    await ctx.cache.invalidateTag("pages");
    return { ok: true };
  });

  /** 기타 의견 — 작성자 없이 내용만 (설문은 익명이 전제다) */
  ctx.registerRoute("GET", "/admin/polls/:id/comments", async (req) => {
    requireManager(req);
    return await listComments(db, req.params.id, Number(req.query.page ?? 1));
  });

  // ════════════════════════════════════════════════════
  //  개인정보 · 사이트맵
  // ════════════════════════════════════════════════════

  /**
   * 회원 탈퇴 시 투표 기록 처리 (ADR-38).
   *
   * **표는 남기고 사람만 지운다.** 투표를 지우면 집계가 바뀌어 이미 발표된 결과가
   * 달라진다 — 설문은 그 시점의 여론을 기록한 것이므로 소급해서 바꾸면 안 된다.
   * user_id 만 끊으면 누가 투표했는지 알 수 없어지고, 그것이 파기의 목적이다.
   *
   * 다만 기타 의견은 자유 서술이라 개인을 특정할 내용이 들어 있을 수 있어 지운다.
   */
  ctx.registerDataEraser({
    label: "설문조사",
    order: 25,
    async erase({ tx, userId }) {
      // user_id 를 NULL 로만 두면 CHECK 제약(user_id 또는 voter_hash 필요)에 걸린다.
      // 그 제약은 "출처 없는 표"를 막기 위한 것이고, 이미 던져진 표를 익명화하는
      // 것과는 다른 상황이다. 제약을 없애는 대신 **무작위 값**을 넣는다 —
      // 표는 여전히 한 사람 몫으로 세어지고, 그 값으로 누구인지 알 수는 없다.
      const { rows } = await tx.execute(sql`
        UPDATE poll_votes SET
          user_id = NULL,
          -- gen_random_bytes 는 pgcrypto 확장이 필요하다. uuid 두 개를 이어
          -- 64자 hex 를 만든다 — gen_random_uuid() 는 PostgreSQL 13+ 기본 함수다.
          voter_hash = replace(gen_random_uuid()::text, '-', '')
                       || replace(gen_random_uuid()::text, '-', ''),
          comment = NULL
        WHERE user_id = ${userId}::uuid
        RETURNING id
      `);
      return rows.length
        ? [`설문 참여 ${rows.length}건 익명화 (표는 집계에 남습니다)`]
        : [];
    },
    async describe({ userId }) {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM poll_votes WHERE user_id = ${userId}::uuid
      `);
      const n = Number(rows[0]?.n ?? 0);
      return n
        ? [{
            label: "설문 참여",
            detail: `${n}건. 표는 집계에 남고 참여자 정보만 삭제됩니다 (기타 의견은 삭제).`,
          }]
        : [];
    },
  });

  ctx.registerSitemapSource({
    label: "설문",
    async count() {
      const { rows } = await db.execute(sql`
        SELECT count(*) AS n FROM poll_polls WHERE is_active = true
      `);
      return Number(rows[0]?.n ?? 0);
    },
    async page({ offset, limit }) {
      const { rows } = await db.execute(sql`
        SELECT slug, updated_at FROM poll_polls WHERE is_active = true
        ORDER BY created_at, id LIMIT ${limit} OFFSET ${offset}
      `);
      return rows.map((r) => ({
        path: `/poll/${String(r.slug)}`,
        lastmod: r.updated_at as Date,
        changefreq: "daily" as const,
        priority: 0.4,
      }));
    },
  });

  ctx.registerAdminResource(POLL_RESOURCE);
  registerPollBlocks(ctx, db);

  return {};
});

const POLL_RESOURCE: AdminResource = {
  name: "polls",
  title: "설문조사",
  itemLabel: "설문",
  basePath: "/admin/polls",
  order: 50,
  description:
    "선택지는 한 줄에 하나씩 적습니다. 진행 중인 설문의 문구를 고쳐도 표는 유지됩니다 " +
    "(이름으로 짝지어 갱신하므로, 선택지를 목록에서 지우면 그 표는 사라집니다). " +
    "결과 공개 시점을 '투표 후'로 두면 표가 한쪽으로 쏠리는 것을 줄일 수 있습니다.",
  fields: [
    { name: "question", label: "질문", type: "text", required: true, inList: true },
    { name: "slug", label: "주소(slug)", type: "text", required: true, inList: true,
      help: "영문 소문자/숫자/하이픈. 블록에서 이 값으로 설문을 지정합니다." },
    { name: "description", label: "설명", type: "textarea" },
    { name: "options_text", label: "선택지", type: "textarea", required: true,
      help: "한 줄에 하나. 두 개 이상 필요합니다." },
    { name: "allow_multiple", label: "복수 선택", type: "boolean", inList: true },
    { name: "max_choices", label: "최대 선택 수", type: "number",
      help: "복수 선택일 때만 적용됩니다." },
    { name: "vote_role", label: "투표 자격", type: "select", inList: true,
      options: VOTE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] })),
      help: "누구나로 두면 IP 로 중복을 막습니다 — 같은 공유기 아래에서는 한 표로 묶입니다." },
    { name: "result_visibility", label: "결과 공개", type: "select", inList: true,
      options: RESULT_VISIBILITY.map((v) => ({ value: v, label: VISIBILITY_LABEL[v] })) },
    { name: "allow_comment", label: "기타 의견 받기", type: "boolean" },
    { name: "starts_at", label: "시작 시각", type: "date", help: "비우면 즉시 시작." },
    { name: "ends_at", label: "종료 시각", type: "date", help: "비우면 수동 종료." },
    { name: "is_active", label: "활성", type: "boolean", inList: true },
    { name: "vote_count", label: "참여", type: "number", readOnly: true, inList: true },
    { name: "visibility_label", label: "공개 시점", type: "text", readOnly: true, inList: true },
  ],
};
