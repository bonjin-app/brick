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
    console.warn(
      `[brick:mail] SMTP가 설정되지 않아 메일을 발송하지 않았습니다.\n` +
        `  to: ${message.to}\n  subject: ${message.subject}\n` +
        `  ${message.text.split("\n").join("\n  ")}`,
    );
    return false;
  }
}
