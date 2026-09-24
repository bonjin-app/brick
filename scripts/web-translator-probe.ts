/**
 * 웹 번역 함수가 값을 **글자 그대로** 끼우는가.
 *
 * 전에는 `message.replace("{name}", 값)` 이었다. replace 는 값 안의 `$&`·`$'`·`` $` ``·`$$`
 * 를 치환 패턴으로 해석하고, 첫 자리만 바꾼다. 값은 상품명·회원 이름·서버 오류 원문처럼
 * 사람이 정한 글자라 그대로 화면에 깨져 나갔다: "$$ 특가" → "$ 특가", "X$&Y" → "X{name}Y",
 * 같은 자리표시자가 두 번이면 두 번째는 "{name}" 그대로.
 *
 * 출력: 네 경우를 JSON 배열로 — 스모크가 기대값과 대조한다.
 */
import { translatorFor } from "../apps/web/src/lib/i18n.ts";

const ko = { twice: "{name} 님, {name} 님의 주문", one: "상품: {name} — 끝" } as const;
const t = translatorFor({ ko }, ko, "ko");
console.log(JSON.stringify([
  t("twice", { name: "홍길동" }),
  t("one", { name: "$$ 특가" }),
  t("one", { name: "A$'B" }),
  t("one", { name: "X$&Y" }),
]));
