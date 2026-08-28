import type { AdminResource } from "@brick/plugin-sdk";

const ROLE_OPTIONS = [
  { value: "guest", label: "누구나 (비회원 포함)" },
  { value: "member", label: "회원" },
  { value: "manager", label: "운영자" },
  { value: "admin", label: "관리자" },
];

/**
 * 게시판 설정 화면.
 * 게시판 하나의 권한·분류·기능 토글을 여기서 정한다.
 */
export const BOARD_RESOURCE: AdminResource = {
  name: "boards",
  title: "게시판",
  itemLabel: "게시판",
  basePath: "/admin/boards",
  order: 10,
  description:
    "게시판을 만들고 권한·분류·기능을 설정합니다. " +
    "페이지 빌더에서 '게시판 목록' 블록을 배치하면 사이트에 노출됩니다.",
  fields: [
    { name: "title", label: "게시판 이름", type: "text", required: true, inList: true },
    { name: "slug", label: "주소(slug)", type: "text", required: true, inList: true,
      help: "영문 소문자/숫자/하이픈. 주소가 됩니다: /board/<slug>" },
    { name: "description", label: "설명", type: "textarea" },
    { name: "post_count", label: "글 수", type: "number", readOnly: true, inList: true },

    { name: "read_role", label: "읽기 권한", type: "select", options: ROLE_OPTIONS, inList: true },
    { name: "write_role", label: "쓰기 권한", type: "select", options: ROLE_OPTIONS, inList: true,
      help: "'누구나'로 두면 비회원도 이름·비밀번호로 글을 쓸 수 있습니다." },
    { name: "comment_role", label: "댓글 권한", type: "select", options: ROLE_OPTIONS },
    { name: "download_role", label: "다운로드 권한", type: "select", options: ROLE_OPTIONS },

    { name: "categories", label: "분류", type: "text",
      help: "쉼표로 구분해 입력하세요. 예: 공지, 질문, 자유 — 비우면 분류를 쓰지 않습니다." },
    { name: "page_size", label: "페이지당 글 수", type: "number", help: "5~100" },

    { name: "allow_reply", label: "답변형 허용", type: "boolean",
      help: "글에 답변을 달아 계층으로 표시합니다." },
    { name: "allow_secret", label: "비밀글 허용", type: "boolean" },
    { name: "allow_vote", label: "추천/비추천 허용", type: "boolean" },
    { name: "allow_upload", label: "파일 첨부 허용", type: "boolean" },
    { name: "max_files", label: "첨부 개수 제한", type: "number", help: "0~10" },
    { name: "write_interval", label: "도배 방지 (초)", type: "number",
      help: "같은 사용자가 다음 글을 쓸 수 있게 되기까지의 시간. 0이면 제한 없음." },

    { name: "sort_order", label: "표시 순서", type: "number" },
    { name: "is_visible", label: "공개", type: "boolean", inList: true },
  ],
};

/**
 * 전 게시판 글 목록 — 스팸·부적절 글을 한곳에서 정리하기 위한 화면.
 * 글 내용 수정은 사이트에서 하고, 여기서는 삭제만 한다.
 */
export const POST_RESOURCE: AdminResource = {
  name: "posts",
  title: "게시글 관리",
  itemLabel: "게시글",
  basePath: "/admin/posts",
  order: 20,
  description: "모든 게시판의 글을 최신순으로 봅니다. 스팸 정리에 사용하세요.",
  can: { create: false, update: false },
  fields: [
    { name: "created_at", label: "작성일시", type: "date", readOnly: true, inList: true },
    { name: "board", label: "게시판", type: "text", readOnly: true, inList: true },
    { name: "title", label: "제목", type: "text", readOnly: true, inList: true },
    { name: "author_name", label: "작성자", type: "text", readOnly: true, inList: true },
    { name: "view_count", label: "조회", type: "number", readOnly: true, inList: true },
    { name: "comment_count", label: "댓글", type: "number", readOnly: true, inList: true },
  ],
};
