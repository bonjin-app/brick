/**
 * 한국 전용 검증·서식 유틸.
 *
 * 코어에 두는 이유: **코어와 플러그인이 같은 규칙을 써야 한다.** 사업자등록번호
 * 체크섬이 사업자정보 설정(전자상거래법 제13조 표시 의무)과 쇼핑몰 세금계산서
 * 발급 양쪽에 필요한데, 두 곳에 복제하면 반드시 갈라진다.
 */

/**
 * 사업자등록번호 검증.
 *
 * 국세청 체크섬 규칙을 실제로 검증한다. 형식만 보면 오타가 통과하고,
 * 잘못된 번호를 표시하는 것은 표시하지 않는 것과 마찬가지로 문제가 된다.
 *
 * 규칙: 앞 9자리에 가중치 [1,3,7,1,3,7,1,3,5] 를 곱해 더하고,
 *       9번째 자리 곱(digit×5)의 십의 자리를 추가로 더한 뒤,
 *       10에서 나머지를 뺀 값이 마지막 자리와 같아야 한다.
 */
export function isValidBusinessNo(raw: string): boolean {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length !== 10) return false;

  // 000-00-00000 은 체크섬을 통과한다(합이 0이므로). 칸만 채우는 것을 막는다 —
  // 잘못된 번호를 표시하는 것은 표시하지 않는 것과 같은 문제다.
  if (/^0+$/.test(digits)) return false;

  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    sum += Number(digits[i]) * weights[i];
  }
  // 9번째 자리는 5를 곱한 값의 십의 자리를 한 번 더 더한다
  sum += Math.floor((Number(digits[8]) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[9]);
}

/** 000-00-00000 형태로 다듬는다 */
export function formatBusinessNo(raw: string): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length !== 10) return String(raw ?? "").trim();
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

/* ── 조사(을/를·이/가·은/는·와/과) ────────────────────────────
 *
 * 화면에 "FAQ을(를) 저장했습니다", "사과잼은(는) 2개까지만 신청할 수 있습니다"
 * 처럼 괄호가 그대로 나오고 있었다. 이름이 값에서 오기 때문에 문장을 미리
 * 고정할 수 없어서였다. 한국어는 **앞 글자의 받침**으로 조사가 정해지므로,
 * 값이 무엇이든 그 자리에서 고를 수 있다.
 *
 * 한글은 유니코드로 계산한다((코드 - 0xAC00) % 28 == 0 이면 받침 없음).
 * 라틴 문자와 숫자는 **읽는 소리**를 따른다 — L(엘)·M(엠)·N(엔)·R(알)은 받침이
 * 있고 나머지 알파벳은 없다(FAQ 의 Q 는 "큐"라 '를'이다). 숫자는 0(영)·1(일)·
 * 3(삼)·6(육)·7(칠)·8(팔)이 받침 있음이다.
 *
 * 판단할 수 없는 글자(기호·한자·이모지)면 **지금처럼 괄호 표기로 남긴다** —
 * 틀린 조사를 단정하는 것보다 낫다.
 */

/** 앞 글자에 받침이 있는가. 판단할 수 없으면 null */
export function hasJongseong(word: string): boolean | null {
  const last = [...word.trim()].pop();
  if (!last) return null;
  const code = last.codePointAt(0)!;
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  const lower = last.toLowerCase();
  if (/[a-z]/.test(lower)) return lower === "l" || lower === "m" || lower === "n" || lower === "r";
  if (/[0-9]/.test(last)) return "013678".includes(last);
  return null;
}

/**
 * 이름 뒤에 알맞은 조사를 붙인다.
 *
 *   josa("FAQ", "을/를")      → "FAQ를"
 *   josa("상품", "이/가")      → "상품이"
 *   josa("사과잼", "은/는")    → "사과잼은"
 *   josa("★", "을/를")        → "★을(를)"   (판단 불가 — 괄호로 남긴다)
 *
 * pair 는 "받침 있을 때/없을 때" 순서다. "(으)로"처럼 ㄹ 받침이 예외인 조사는
 * 이 함수가 다루지 않는다 — 필요해지면 그때 규칙과 함께 더한다.
 */
export function josa(word: string, pair: string): string {
  const [withJong, withoutJong] = pair.split("/");
  const has = hasJongseong(word);
  if (has === null) return `${word}${withJong}(${withoutJong})`;
  return `${word}${has ? withJong : withoutJong}`;
}
