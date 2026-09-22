/**
 * 문자(SMS/LMS) 발송 추상화.
 *
 * **왜 코어에 두는가.** 한국 커머스에서 주문·발송 안내의 기본 통로는 문자다.
 * 메일은 안 열어 보는 사람이 많고, 알림함은 사이트에 다시 들어와야 보인다 —
 * "언제 오나요" 로 들어오는 전화를 줄이는 것은 문자뿐이다.
 *
 * 다른 Provider 와 같은 원칙: 설정하지 않아도 Brick 은 동작한다. 공급자가
 * 없으면 LogSmsProvider 가 콘솔에 남기고 끝난다.
 *
 * **문자는 건당 돈이 나간다.** 그래서 메일과 반대로 **보내는 쪽이 옵트인**이다:
 * 부르는 쪽이 명시적으로 요청한 알림만 문자로 나간다.
 */
export interface SmsMessage {
  /** 받는 번호 — 숫자만 남겨 보낸다 (`010-1234-5678` 도 받는다) */
  to: string;
  /**
   * 본문.
   *
   * 90바이트(EUC-KR 기준 한글 45자)를 넘으면 공급자가 LMS 로 보내고 요금이
   * 다르다. 자르지 않는다 — 잘린 주문 안내는 안 보낸 것만 못하다.
   */
  text: string;
  /** 장문일 때의 제목 (LMS 에만 쓰인다) */
  title?: string;
}

export interface SmsProvider {
  /**
   * 문자 발송. 실패해도 예외를 던지지 않고 false 를 반환한다 —
   * 문자 실패가 주문을 막아서는 안 된다(메일과 같은 원칙).
   */
  send(message: SmsMessage): Promise<boolean>;
  /** 보낼 수 있는 상태인가 (공급자·키·발신번호가 모두 있는가) */
  readonly enabled: boolean;
}

/**
 * 받는 번호 정리 — 숫자만 남긴다.
 *
 * 주문서에는 `010-1234-5678`, `010 1234 5678`, `+82 10-1234-5678` 이 모두 들어온다.
 * 국가번호(+82)는 앞의 0 을 되살려 국내 형식으로 되돌린다 — 국내 공급자는
 * 국내 번호 형식만 받는다.
 */
export function normalizePhone(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^\+?82[-\s]?/, "0");
  const digits = s.replace(/\D/g, "");
  // 010… 011… 02… — 9~11자리가 아니면 전화번호가 아니다
  return digits.length >= 9 && digits.length <= 11 ? digits : "";
}

/**
 * 로그에 남길 때의 번호 — **가운데를 가린다.**
 *
 * 발송 로그는 운영자도 보고 파일에도 남는다. 전화번호는 그 자체로 개인정보라
 * (ADR-35 의 IP 와 같은 판단) 원문을 남길 이유가 없다: 어느 번호로 갔는지
 * 확인하는 데는 앞뒤만 있으면 된다.
 */
export function maskPhone(phone: string): string {
  const d = String(phone).replace(/\D/g, "");
  if (d.length < 7) return "***";
  return `${d.slice(0, 3)}****${d.slice(-4)}`;
}

/** 공급자가 설정되지 않았을 때의 기본 구현 — 콘솔에 남기고 끝난다 */
export class LogSmsProvider implements SmsProvider {
  readonly enabled = false;

  async send(message: SmsMessage): Promise<boolean> {
    // 번호는 가리고, 본문은 그대로 — 개발 중에 무엇이 나갈지 확인하는 용도다
    console.log(`[sms:log] → ${maskPhone(message.to)}\n${message.text}`);
    return false;
  }
}
