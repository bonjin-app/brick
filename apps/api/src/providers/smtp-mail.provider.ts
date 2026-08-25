import { Logger } from "@nestjs/common";
import nodemailer, { type Transporter } from "nodemailer";
import type { MailMessage, MailProvider } from "@brick/core";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * SMTP 메일 발송.
 *
 * 발송 실패는 예외를 던지지 않고 false를 반환한다 —
 * 메일 서버 장애가 회원가입이나 주문을 막아서는 안 된다.
 */
export class SmtpMailProvider implements MailProvider {
  readonly enabled = true;
  private readonly logger = new Logger("Mail");
  private readonly transporter: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: config.pass ?? "" } } : {}),
      // 대량 발송이 아니므로 연결을 오래 붙잡지 않는다
      pool: true,
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(message: MailMessage): Promise<boolean> {
    try {
      await this.transporter.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });
      return true;
    } catch (err) {
      // 수신자 주소를 로그에 남기면 개인정보가 로그로 흘러간다 — 도메인만 남긴다
      const domain = message.to.split("@")[1] ?? "unknown";
      this.logger.error(`메일 발송 실패 (@${domain}): ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
