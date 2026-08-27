import type { AdminResource } from "@brick/plugin-sdk";

/**
 * 팝업 관리 화면 선언.
 *
 * 방문자 집계에는 관리 리소스를 두지 않는다 — 편집할 것이 없고,
 * 통계는 대시보드 블록과 `/admin/visits` 로 본다.
 */
export const POPUP_RESOURCE: AdminResource = {
  name: "popups",
  title: "팝업 · 배너",
  itemLabel: "팝업",
  basePath: "/admin/popups",
  order: 50,
  description:
    "노출 경로가 '*' 이면 모든 페이지에 뜹니다. '/shop' 처럼 적으면 그 아래 경로에도 함께 뜹니다. " +
    "기간을 비우면 즉시·무기한 노출입니다.",
  fields: [
    { name: "title", label: "제목", type: "text", required: true, inList: true,
      help: "레이어 팝업의 제목 줄에 표시되고, 닫기 버튼의 라벨에도 쓰입니다." },
    { name: "kind", label: "종류", type: "select", inList: true,
      options: [
        { value: "popup", label: "레이어 팝업" },
        { value: "banner", label: "배너" },
      ],
      help: "배너는 페이지 빌더의 '배너' 블록을 놓은 자리에 표시됩니다." },
    { name: "is_active", label: "사용", type: "boolean", inList: true },
    { name: "path_prefix", label: "노출 경로", type: "text", inList: true,
      placeholder: "*", help: "* = 전체. /shop = 쇼핑몰 전체. /notice = 공지 페이지." },
    { name: "content", label: "내용", type: "richtext",
      help: "HTML을 쓸 수 있습니다. 스크립트와 iframe은 저장할 때 제거됩니다." },
    { name: "image_url", label: "이미지", type: "image",
      help: "배너는 보통 이미지 하나로 씁니다. 내용과 함께 쓰면 이미지가 위에 옵니다." },
    { name: "link_url", label: "클릭 시 이동", type: "text",
      help: "/ 또는 http(s):// 로 시작해야 합니다. 비우면 링크가 없습니다." },
    { name: "link_target", label: "링크 열기", type: "select",
      options: [
        { value: "_self", label: "현재 창" },
        { value: "_blank", label: "새 창" },
      ] },
    { name: "starts_at", label: "노출 시작", type: "date", help: "비우면 즉시 노출." },
    { name: "ends_at", label: "노출 종료", type: "date", help: "비우면 무기한." },
    { name: "pos_top", label: "위치 top(px)", type: "number", help: "레이어 팝업에만 적용." },
    { name: "pos_left", label: "위치 left(px)", type: "number" },
    { name: "width", label: "너비(px)", type: "number" },
    { name: "hide_days", label: "다시 보지 않기(일)", type: "number",
      help: "0이면 '다시 보지 않기'를 제공하지 않습니다. 기본 1일." },
    { name: "sort_order", label: "순서", type: "number", help: "작을수록 먼저." },
    { name: "view_count", label: "노출", type: "number", readOnly: true, inList: true },
    { name: "click_count", label: "클릭", type: "number", readOnly: true, inList: true },
  ],
};
