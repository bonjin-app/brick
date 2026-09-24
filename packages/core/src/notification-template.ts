/**
 * 알림 문구 템플릿 — `#{변수}` 자리를 값으로 채운다.
 *
 * 알림을 보내는 플러그인의 기본 문구와 운영자가 고친 문구가 **같은 채우기**를 거친다 — 둘이
 * 다르게 채우면 "기본 문구 불러오기" 로 가져온 문장과 실제로 나가던 문장이 어긋난다.
 *
 * 값이 빈 변수가 한 줄을 차지하던 자리는 빈 줄이 겹치므로, 세 줄 이상 이어진 줄바꿈은 두 줄로
 * 줄인다(무통장입금 안내가 없는 카드 주문에 빈 줄이 여럿 생기지 않게).
 */
export function fillTemplate(text: string, vars: Record<string, string | undefined>): string {
  return text
    .replace(/#\{([^}\n]+)\}/g, (_all, name: string) => vars[name.trim()] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 템플릿이 쓰는 변수 이름들 (중복 없이, 나온 순서대로) */
export function templateVarNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/#\{([^}\n]+)\}/g)) {
    const name = m[1].trim();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
