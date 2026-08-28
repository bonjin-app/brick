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
