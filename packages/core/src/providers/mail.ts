/**
 * 메일 발송 추상화.
 *
 * 다른 Provider와 같은 원칙: 외부 의존성 없이도 Brick이 동작해야 한다.
 * SMTP가 설정되지 않으면 LogMailProvider가 콘솔에 출력한다 —
 * 개발 중에 메일 서버를 세우지 않고도 비밀번호 재설정 흐름을 테스트할 수 있다.
 */
export interface MailMessage {
  to: string;
  subject: string;
  /** 텍스트 본문 (필수 — HTML만 보내는 메일은 스팸 판정을 받기 쉽다) */
  text: string;
  html?: string;
  replyTo?: string;
  /**
   * 추가 헤더.
   *
   * 광고 메일의 `List-Unsubscribe` 가 이것을 쓴다. 본문에 수신거부 링크를 넣는
   * 것은 법이 요구하는 최소이고, **메일 앱이 "수신거부" 버튼을 띄우려면 헤더가
   * 있어야 한다.** 버튼이 없으면 사람들은 대신 "스팸 신고" 를 누르고, 그것이
   * 발신 도메인의 평판을 깎는다 — 그러면 입금 계좌가 담긴 주문 안내 메일까지
   * 스팸함으로 간다. 작은 쇼핑몰에게는 그쪽이 더 큰 피해다.
   */
  headers?: Record<string, string>;
}

export interface MailProvider {
  /**
   * 메일 발송. 실패해도 예외를 던지지 않고 false를 반환한다 —
   * 메일 실패가 회원가입·주문 같은 주 흐름을 막아서는 안 된다.
   * (실패는 provider가 로깅한다)
   */
  send(message: MailMessage): Promise<boolean>;
  /** 발송 가능한 상태인가 (설정 여부 확인용) */
  readonly enabled: boolean;
}

/** SMTP가 설정되지 않았을 때의 기본 구현 — 콘솔에 출력만 한다 */
export class LogMailProvider implements MailProvider {
  readonly enabled = false;

  async send(message: MailMessage): Promise<boolean> {
    const headers = Object.entries(message.headers ?? {})
      .map(([k, v]) => `  ${k}: ${v}\n`)
      .join("");
    console.warn(
      `[brick:mail] SMTP가 설정되지 않아 메일을 발송하지 않았습니다.\n` +
        `  to: ${message.to}\n  subject: ${message.subject}\n` +
        headers +
        `  ${message.text.split("\n").join("\n  ")}`,
    );
    return false;
  }
}
