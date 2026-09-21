/**
 * 쇼핑몰 다국어 바인딩.
 *
 * 렌더 함수(views.ts)에 ctx 를 실어 나르지 않고 모듈 싱글턴으로 묶는다 —
 * 플러그인은 프로세스당 활성 인스턴스가 하나이므로 안전하고, 수십 개의
 * 함수 시그니처에 t 를 꿰는 기계적 소음을 없앤다. 활성화 때 bindI18n(ctx).
 */
import type { PluginContext } from "@brick/plugin-sdk";
import { SITE_TZ, josa } from "@brick/plugin-sdk";

type TFn = PluginContext["t"];

let boundT: TFn = (key) => key; // 바인딩 전(테스트 등)에는 키가 그대로 보인다
let boundLocale: () => string = () => "ko";

export function bindI18n(ctx: Pick<PluginContext, "t" | "locale">): void {
  boundT = (key, params) => ctx.t(key, params);
  boundLocale = () => ctx.locale;
}

export const t: TFn = (key, params) => boundT(key, params);

/**
 * 날짜·숫자 포맷용 BCP-47 태그 — 문자열 카탈로그와 같은 언어 설정을 따른다.
 *
 * 주의: 이 태그로 **서버에서 날짜를** 포맷하면 `ko-KR` 의 오전/오후가 "PM" 으로
 * 나올 수 있다(Node 의 ICU. full ICU 에서도 확인됐다). 게시판 플러그인이 그 때문에
 * 서버용 날짜 포맷터를 직접 들고 있다. 숫자·금액의 자리 묶음은 문제가 없다.
 */
export function localeTag(): string {
  return boundLocale() === "en" ? "en-US" : "ko-KR";
}

/**
 * 금액 표기 — 숫자 묶음과 통화 표시가 **모두** 언어를 따라간다.
 *
 * 날짜는 `localeTag()` 로 이미 언어를 따라갔는데 금액은 `toLocaleString("ko-KR") + "원"`
 * 으로 못박혀 있었다. 그래서 영어 사이트의 상품·장바구니·주문서·주문 메일이 전부
 * "12,000원" 이었다. 통화는 원화 그대로지만 표기는 읽는 사람의 언어를 따라야 한다
 * (`common.won`: ko "원", en " KRW").
 *
 * 원화는 소수점을 쓰지 않으므로 `Intl.NumberFormat` 의 통화 서식(₩12,000.00)이 아니라
 * 숫자 + 접미사로 둔다 — 기존 화면과 메일의 모양을 그대로 유지한다.
 */
export function money(amount: number): string {
  return `${Number(amount).toLocaleString(localeTag())}${t("common.won")}`;
}

/**
 * 클라이언트 스크립트에 심을 금액 포맷터.
 *
 * 서버와 같은 규칙을 쓰게 하려고 값을 렌더 시점에 박아 넣는다 — 스크립트가
 * 자기 나름대로 "원" 을 붙이면 한 화면 안에서 표기가 갈라진다(실제로 갈라져 있었다).
 */
export function moneyFnScript(name = "fmt"): string {
  return `function ${name}(n){ return Number(n).toLocaleString(${JSON.stringify(localeTag())}) + ${JSON.stringify(t("common.won"))}; }`;
}

/**
 * 브라우저에서 날짜를 찍을 때 쓸 옵션 — **사이트 시간대**를 함께 넘긴다.
 *
 * 여기 문자열들은 이미 `localeTag()` 로 사이트 언어를 따라가고 있었는데
 * 시간대는 보는 사람의 것이었다(주문 이력은 로케일마저 없었다). 서버가 그리는
 * 화면은 사이트 시간대이므로, 같은 주문을 목록에서 보는 것과 상세에서 보는 것이
 * 달라질 수 있다 — 해외에서 접속한 손님에게는 날짜가 하루 어긋난다.
 *
 * 코어의 window.brickDate 는 `YYYY.MM.DD` 로 고정이라 여기서는 쓰지 않는다.
 * 쇼핑몰의 날짜는 언어별 표기를 따르는 편이 자연스럽고(영어 사이트의 "Sep 14,
 * 2026"), 고쳐야 할 것은 **시간대**다.
 */
export function dateOptsScript(name = "DATE_OPTS"): string {
  return `var ${name} = { timeZone: ${JSON.stringify(SITE_TZ)} };`;
}

/**
 * 선언 라벨(한국어 원문)을 사이트 언어로 — **원문이 곧 키**다.
 *
 * 주문 상태·반품 종류처럼 코드 안의 Record 로 사는 라벨이 오류 문장에 들어간다
 * ("결제완료에서 배송중으로 바로 바꿀 수 없습니다"). 문장만 번역하면 그 안의
 * 낱말이 한국어로 남아 반쪽이 된다.
 *
 * ko 에서는 **찾지 않는다** — 원문이 곧 답이므로, 빠짐 로그를 내면 모든 라벨이
 * 노이즈가 된다. 다른 언어에서 번역이 없으면 원문이 나가고 한 번 로그된다.
 */
export function label(text: string): string {
  return boundLocale() === "ko" ? text : boundT(text);
}

/**
 * 조사는 **한국어에서만** 붙인다.
 *
 * `josa("배송중", "으로/로")` 은 한국어의 문법이다 — 영어 라벨에 붙이면
 * "Shipping으로" 가 된다. 문장 템플릿은 언어마다 다르므로, 조사가 필요 없는
 * 언어에서는 낱말을 그대로 돌려준다.
 */
export function withJosa(text: string, pair: string): string {
  return boundLocale() === "ko" ? josa(text, pair) : text;
}
