import { sql } from "drizzle-orm";
import { fillTemplate, type PluginContext } from "@brick/plugin-sdk";
import type { Db } from "./types.js";

/**
 * 댓글 알림 — 내 글에 댓글이 달렸을 때(`board.comment`), 내 댓글에 답글이 달렸을 때(`board.reply`).
 *
 * 전에는 알림 등록 두 개와 기본 문구, 보내는 클로저가 1,470줄 플러그인 본체와 댓글 등록 경로 안에 있었다
 * (요청마다 클로저를 다시 만들었고, 본체 없이는 시험할 수 없었다). 이 모듈이 등록과 발송을 함께 가진다 —
 * 이벤트를 하나 더하려면 여기 표에 한 줄을 더하면 된다.
 */

/** 알림 종류 하나 — 이벤트 이름 · 관리 화면 라벨 · 변수 설명 · 기본 문구의 카탈로그 키 */
const EVENTS = {
  "board.comment": {
    label: "게시판 — 내 글에 댓글",
    who: "댓글을 쓴 사람",
    excerpt: "댓글 앞부분 (비밀댓글이면 내용 대신 표시)",
    sample: "좋은 글 감사합니다",
    subjectKey: "mail.commentSubject",
    bodyKey: "mail.commentBody",
  },
  "board.reply": {
    label: "게시판 — 내 댓글에 답글",
    who: "답글을 쓴 사람",
    excerpt: "답글 앞부분 (비밀 답글·비밀글이면 내용 대신 표시)",
    sample: "네, 가능합니다",
    subjectKey: "mail.replySubject",
    bodyKey: "mail.replyBody",
  },
} as const;

export type CommentNotifyEvent = keyof typeof EVENTS;

export interface CommentNotifyInput {
  /** 받는 회원 */
  to: string;
  event: CommentNotifyEvent;
  /** 알림이 가리키는 원글 */
  post: { id: string; slug: string; title: string; boardTitle: string };
  /** 쓴 사람의 표시 이름 */
  authorName: string;
  content: string;
  /** 메일은 사이트 밖으로 나간다 — 비밀이면 내용을 빼고 "댓글이 달렸다" 는 사실만 알린다 */
  hideContent: boolean;
}

/**
 * 알림 이벤트를 등록하고 발송기를 돌려준다.
 *
 * 발송은 기다리지 않는다(댓글 등록이 알림 때문에 느려지거나 실패하면 안 된다). 실패는 **기록한다** — 전에는 삼켜서
 * 문구가 깨졌거나 알림 이벤트가 빠졌을 때 댓글·답글 알림이 통째로 조용히 사라졌다.
 */
export function registerCommentNotifications(ctx: PluginContext, db: Db): (input: CommentNotifyInput) => void {
  /** 기본 문구 — `#{변수}` 로 쓴다. 실제 발송이 이것을 채운 것이라, 알림 문구 화면에서 불러온 문장과 나가는 문장이 같다 */
  const defaults = (event: CommentNotifyEvent) => () => ({
    subject: ctx.t(EVENTS[event].subjectKey, { board: "#{게시판명}", title: "#{글제목}" }),
    body: ctx.t(EVENTS[event].bodyKey, {
      author: "#{댓글작성자}", title: "#{글제목}", excerpt: "#{댓글요약}", url: "#{글주소}",
    }),
  });

  for (const event of Object.keys(EVENTS) as CommentNotifyEvent[]) {
    const e = EVENTS[event];
    ctx.registerNotificationEvent({
      event,
      label: e.label,
      vars: [
        { name: "게시판명", description: "게시판 이름", sample: "자유게시판" },
        { name: "글제목", description: "원글 제목", sample: "첫 글입니다" },
        { name: "댓글작성자", description: e.who, sample: "홍길동" },
        { name: "댓글요약", description: e.excerpt, sample: e.sample },
        { name: "글주소", description: "원글 주소", sample: "https://example.com/board/free/1#comments" },
      ],
      defaults: defaults(event),
    });
  }

  const send = async (input: CommentNotifyInput): Promise<void> => {
    const { rows } = await db.execute(sql`
      SELECT id FROM users WHERE id = ${input.to}::uuid AND is_active = true AND withdrawn_at IS NULL LIMIT 1
    `);
    if (!rows[0]) return; // 탈퇴·정지한 회원에게는 보내지 않는다
    const path = `/board/${encodeURIComponent(input.post.slug)}/${input.post.id}#comments`;
    // 운영자가 알림 문구를 고쳤다면 코어가 그 문구로 바꿔 보낸다 — 여기서는 기본 문구를 채운다
    const vars = {
      게시판명: input.post.boardTitle,
      글제목: input.post.title.slice(0, 200),
      댓글작성자: input.authorName,
      댓글요약: input.hideContent ? ctx.t("mail.secretComment") : input.content.slice(0, 200),
      글주소: `${ctx.site.url}${path}`,
    };
    const tpl = defaults(input.event)();
    await ctx.notify({
      userId: input.to,
      kind: input.event,
      event: input.event,
      vars,
      title: fillTemplate(tpl.subject, vars),
      body: fillTemplate(tpl.body, vars),
      url: path,
    });
  };

  return (input) => {
    void send(input).catch((err) =>
      ctx.logger.warn(`댓글 알림 실패 (${input.event} → ${input.to}): ${err instanceof Error ? err.message : String(err)}`));
  };
}
