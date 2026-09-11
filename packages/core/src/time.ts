/**
 * 사이트 시간대 — "오늘"의 유일한 정의.
 *
 * 일·주·월의 경계는 전부 이 시간대로 자른다 (`BRICK_TIMEZONE`, 기본
 * Asia/Seoul — 한국 대상 CMS 다). 판매 리포트·대시보드 카드·검색 로그·
 * 감사 로그가 서로 다른 "오늘"을 쓰면 운영자는 어느 숫자도 믿지 않는다
 * (ADR-51·78). 예전엔 이 표현식이 다섯 곳에 복사돼 있어서, 그 일치가
 * "복붙 문자열이 우연히 같다"에만 의존했다 — 정의는 한 곳에만 둔다.
 *
 * 환경변수로 두는 이유: 시간대를 바꾸면 **과거 집계까지 달라진다.**
 * 관리 화면에서 바꿀 수 있으면 사고다 (reports 의 결정과 같다).
 *
 * ── SQL 에서 "오늘"을 세는 관용구 ──────────────────────
 *
 * 반드시 **컬럼이 아니라 상수 쪽을 변환**하는 반개구간으로 쓴다:
 *
 *   created_at >= (date_trunc('day', now() AT TIME ZONE ${SITE_TZ}) AT TIME ZONE ${SITE_TZ})
 *
 * `(created_at AT TIME ZONE tz)::date = ...` 처럼 컬럼을 캐스팅하면
 * 인덱스를 못 타서(non-sargable) 대시보드가 열릴 때마다 풀 스캔이 된다.
 */
export const SITE_TZ = process.env.BRICK_TIMEZONE?.trim() || "Asia/Seoul";

/**
 * 사이트 시간대의 오늘 — `YYYY-MM-DD`.
 *
 * SQL 쪽 관용구는 위에 적어 두었는데 **JS 쪽 정의가 없어서** 각자
 * `new Date().toISOString().slice(0, 10)` 을 썼다. 그것은 UTC 날짜다.
 *
 * 무엇이 어긋나는지: 한국 시간 08:00 과 10:00 은 같은 날이지만 UTC 로는
 * 하루 차이다(각각 전날 23:00, 당일 01:00). 그래서 출석 포인트의 멱등 키가
 * 아침 9시 전후로 갈라졌고, **하루에 두 번** 지급됐다.
 *
 * `en-CA` 로 포맷하는 이유는 그 로케일이 `YYYY-MM-DD` 를 주기 때문이다 —
 * 사람이 읽을 날짜가 아니라 **키로 쓸 날짜**라 표기가 고정이어야 한다.
 * (`ko-KR` 로 날짜를 포맷하면 Node 의 ICU 에 따라 결과가 달라진다.)
 */
export function siteToday(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: SITE_TZ });
}

/**
 * 사이트 시간대의 날짜·시각 조각 — 화면에 찍을 숫자.
 *
 * 서버가 그리는 화면(게시판 목록·글 상세·댓글)이 `d.getFullYear()`·`getHours()`
 * 로 시각을 찍고 있었다. 그것은 **컨테이너의 시간대**다. Docker 기본은 UTC 이고
 * 이 저장소는 TZ 를 어디에도 지정하지 않으므로, 한국 시간 0시 30분에 쓴 글이
 * "2026.09.11 15:30" 으로 보였다 — 날짜까지 하루 어긋난다.
 *
 * 로케일 이름이 아니라 **숫자만** 뽑는다. `ko-KR` 로 시각을 포맷하면 Node 의
 * ICU 에 따라 "오후"가 "PM" 으로 나오는 일이 있었고(그래서 게시판이 직접 포맷을
 * 들고 있었다), 여기서 필요한 것은 어차피 `YYYY.MM.DD HH:mm` 이다.
 */
export function siteDateParts(value: Date): {
  year: string; month: string; day: string; hour: string; minute: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(value);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // hour12:false 는 자정을 "24" 로 주는 환경이 있다 — 00 으로 맞춘다
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute") };
}

/**
 * 브라우저에서 쓸 날짜 포맷터 — 사이트 시간대로 찍는다.
 *
 * 클라이언트가 그리는 목록(쪽지함·내 스크랩·포인트 내역)은 `d.getFullYear()` 로
 * 시각을 찍고 있었다. 그것은 **보는 사람의 시간대**다. 서버가 그리는 목록은
 * 사이트 시간대이므로, 해외에서 접속한 회원은 같은 화면 위아래에서 **다른
 * 날짜**를 본다(게시판 목록은 09.12, 그 아래 쪽지함은 09.11).
 *
 * 무엇을 고르든 한쪽으로 통일되어야 하고, 이 저장소는 "오늘"을 사이트
 * 시간대로 정의했다(SITE_TZ). 그래서 브라우저도 그것을 따른다.
 *
 * 플러그인마다 베끼면 한 곳만 고쳐진다 — 캡차 위젯과 같은 이유로 여기에 둔다.
 * 브라우저는 ICU 가 온전하므로 timeZone 옵션을 믿을 수 있다.
 */
export function dateScript(tz: string = SITE_TZ): string {
  return `
(function () {
  if (window.brickDate) return;
  var TZ = ${JSON.stringify(tz)};
  function parts(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) return null;
    var out = {};
    try {
      new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(d).forEach(function (p) { out[p.type] = p.value; });
    } catch (e) {
      // 시간대를 모르는 브라우저 — 그때는 보는 사람의 시간대로 둔다(빈칸보다 낫다)
      var p2 = function (n) { return String(n).padStart(2, "0"); };
      out = { year: String(d.getFullYear()), month: p2(d.getMonth() + 1), day: p2(d.getDate()),
              hour: p2(d.getHours()), minute: p2(d.getMinutes()) };
    }
    if (out.hour === "24") out.hour = "00";
    return out;
  }
  window.brickDate = {
    /** YYYY.MM.DD */
    day: function (v) { var p = parts(v); return p ? p.year + "." + p.month + "." + p.day : ""; },
    /** YYYY.MM.DD HH:mm */
    full: function (v) { var p = parts(v); return p ? p.year + "." + p.month + "." + p.day + " " + p.hour + ":" + p.minute : ""; },
    /** 오늘이면 HH:mm, 아니면 MM.DD */
    short: function (v) {
      var p = parts(v); if (!p) return "";
      var n = parts(new Date());
      return (n && p.year === n.year && p.month === n.month && p.day === n.day)
        ? p.hour + ":" + p.minute : p.month + "." + p.day;
    },
  };
})();
`;
}
