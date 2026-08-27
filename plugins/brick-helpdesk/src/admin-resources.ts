import type { AdminResource } from "@brick/plugin-sdk";
import { STATUS_LABEL, TICKET_STATUS } from "./types.js";

/**
 * 관리자 리소스 선언 — 코어가 이 스키마로 CRUD 화면을 런타임에 만든다.
 * 플러그인은 React 코드를 배포하지 않는다 (ADR-12).
 */
export const TICKET_RESOURCE: AdminResource = {
  name: "tickets",
  title: "1:1 문의",
  itemLabel: "문의",
  basePath: "/admin/tickets",
  order: 5,
  description:
    "답변을 입력하고 저장하면 상태가 '답변완료'로 바뀌고 작성자에게 메일이 갑니다. " +
    "작성자가 다시 글을 쓰면 '접수'로 돌아옵니다.",
  can: { create: false, delete: false },
  fields: [
    { name: "ticket_no", label: "문의번호", type: "text", readOnly: true, inList: true },
    { name: "created_at", label: "접수일", type: "date", readOnly: true, inList: true },
    { name: "status_label", label: "상태", type: "text", readOnly: true, inList: true },
    { name: "category", label: "분류", type: "text", readOnly: true, inList: true },
    { name: "author_name", label: "작성자", type: "text", readOnly: true, inList: true },
    { name: "title", label: "제목", type: "text", readOnly: true, inList: true },
    { name: "reply_count", label: "대화", type: "number", readOnly: true, inList: true },
    { name: "assignee_name", label: "담당자", type: "text", readOnly: true, inList: true },
    { name: "reply", label: "답변 작성", type: "textarea",
      help: "저장하면 대화에 추가되고 작성자에게 알립니다. 비워두면 답변하지 않습니다." },
    { name: "status", label: "상태 변경", type: "select",
      options: TICKET_STATUS.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      help: "종료하면 더 이상 답변을 받지 않습니다." },
  ],
};

export const FAQ_RESOURCE: AdminResource = {
  name: "faqs",
  title: "FAQ",
  itemLabel: "FAQ",
  basePath: "/admin/faqs",
  order: 10,
  description: "조회수와 '도움이 되었나'를 보고 답변을 개선하세요. 많이 읽히고 도움이 안 된 항목이 고칠 대상입니다.",
  fields: [
    { name: "question", label: "질문", type: "text", required: true, inList: true },
    { name: "answer", label: "답변", type: "richtext", required: true,
      help: "HTML을 사용할 수 있습니다." },
    { name: "category_name", label: "분류", type: "text", readOnly: true, inList: true },
    { name: "category_id", label: "분류 지정", type: "text",
      help: "분류 목록 화면에서 id를 복사해 넣으세요. 비우면 분류 없음." },
    { name: "sort_order", label: "순서", type: "number", inList: true, help: "작을수록 먼저." },
    { name: "is_visible", label: "표시", type: "boolean", inList: true },
    { name: "view_count", label: "조회", type: "number", readOnly: true, inList: true },
    { name: "helpful_count", label: "도움됨", type: "number", readOnly: true, inList: true },
    { name: "unhelpful_count", label: "도움안됨", type: "number", readOnly: true, inList: true },
  ],
};

export const FAQ_CATEGORY_RESOURCE: AdminResource = {
  name: "faq-categories",
  title: "FAQ 분류",
  itemLabel: "분류",
  basePath: "/admin/faq-categories",
  order: 20,
  fields: [
    { name: "id", label: "id", type: "text", readOnly: true, inList: true,
      help: "FAQ 등록 화면의 '분류 지정'에 넣는 값입니다." },
    { name: "name", label: "분류명", type: "text", required: true, inList: true },
    { name: "slug", label: "주소(slug)", type: "text", required: true, inList: true },
    { name: "sort_order", label: "순서", type: "number", inList: true },
    { name: "is_visible", label: "표시", type: "boolean", inList: true },
  ],
};
