import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuditService } from "../audit/audit.service.js";
import {
  CAMPAIGN_KINDS, KIND_LABEL, MailingService, type CampaignKind, type Filters,
} from "./mailing.service.js";

/**
 * 회원 단체메일.
 *
 * 발송은 큐에서 진행된다 — 수만 명에게 보내는 것은 몇 분~몇 시간이 걸리고
 * 요청 안에서 다 보내면 타임아웃이 난다.
 */
@Controller("api")
export class MailingController {
  constructor(
    private readonly mailing: MailingService,
    private readonly audit: AuditService,
  ) {}

  /** 발송 종류 — 화면이 선택지와 안내 문구를 만든다 */
  @Get("admin/mail/kinds")
  @UseGuards(AdminGuard)
  kinds() {
    return {
      items: CAMPAIGN_KINDS.map((k) => ({
        code: k,
        label: KIND_LABEL[k],
        // 법적 근거를 화면에 함께 보여준다 — 운영자가 왜 제한되는지 알아야 한다
        note:
          k === "ad"
            ? "정보통신망법 제50조: 사전 동의한 회원에게만 발송되고, 제목에 (광고)가 붙고 " +
              "본문에 수신거부 링크가 자동으로 추가됩니다."
            : "서비스 운영에 필요한 안내(약관 개정·점검 등)입니다. 수신 동의와 무관하게 발송됩니다.",
      })),
    };
  }

  /** 대상 수 미리보기 — 수만 명에게 잘못 보내는 것은 되돌릴 수 없다 */
  @Post("admin/mail/preview")
  @UseGuards(AdminGuard)
  async preview(@Body() body: { kind?: string; filters?: Filters }) {
    const kind = String(body?.kind ?? "notice") as CampaignKind;
    if (!CAMPAIGN_KINDS.includes(kind)) {
      throw new BadRequestException("발송 종류가 올바르지 않습니다.");
    }
    return await this.mailing.preview(kind, body?.filters ?? {});
  }

  @Get("admin/mail")
  @UseGuards(AdminGuard)
  async list(@Query("page") page?: string) {
    return await this.mailing.list(Number(page ?? 1));
  }

  @Get("admin/mail/:id")
  @UseGuards(AdminGuard)
  async detail(@Param("id") id: string) {
    return await this.mailing.detail(id);
  }

  @Post("admin/mail")
  @UseGuards(AdminGuard)
  async create(
    @Req() req: FastifyRequest & { user: { id: string } },
    @Body() body: {
      kind?: string;
      subject?: string;
      body?: string;
      isHtml?: boolean;
      filters?: Filters;
    },
  ) {
    const result = await this.mailing.create({
      kind: String(body?.kind ?? "notice"),
      subject: String(body?.subject ?? ""),
      body: String(body?.body ?? ""),
      isHtml: body?.isHtml === true,
      filters: body?.filters,
      actorId: req.user.id,
    });
    await this.audit.record({
      action: "mail.campaign_created", targetType: "mail_campaign", targetId: result.id,
      summary: `${String(body?.kind)} · 대상 ${result.total}명`, ip: req.ip,
    });
    return result;
  }

  @Post("admin/mail/:id/send")
  @UseGuards(AdminGuard)
  async send(
    @Req() req: FastifyRequest & { user: { id: string } },
    @Param("id") id: string,
  ) {
    const result = await this.mailing.start(id);
    await this.audit.record({
      action: "mail.campaign_started", targetType: "mail_campaign", targetId: id,
      summary: `대상 ${result.total}명`, ip: req.ip,
    });
    return result;
  }

  @Post("admin/mail/:id/cancel")
  @UseGuards(AdminGuard)
  async cancel(
    @Req() req: FastifyRequest & { user: { id: string } },
    @Param("id") id: string,
  ) {
    await this.mailing.cancel(id);
    await this.audit.record({
      action: "mail.campaign_cancelled", targetType: "mail_campaign", targetId: id, ip: req.ip,
    });
    return { ok: true };
  }

  /**
   * 수신거부 — **로그인을 요구하지 않는다.**
   *
   * 메일을 받은 사람이 그 자리에서 끊을 수 있어야 하고, 그게 정보통신망법이
   * 요구하는 "쉬운 방법"이다. 로그인 화면으로 보내면 대부분 포기한다.
   *
   * GET 으로 받는다 — 메일 본문의 링크를 클릭하는 것이므로 POST 를 만들 수 없다.
   * 부작용이 있는 GET 이지만, 토큰을 아는 사람만 자기 수신 설정을 끄는 것이라
   * CSRF 로 악용될 여지가 실질적으로 없다(공격자가 얻는 것이 없다).
   */
  @Get("mail/unsubscribe")
  async unsubscribe(@Query("token") token: string, @Res() reply: FastifyReply): Promise<void> {
    let message: string;
    let status = 200;
    try {
      const result = await this.mailing.unsubscribe(String(token ?? ""));
      message =
        `${result.email} 의 광고성 정보 수신이 해제되었습니다.\n\n` +
        `서비스 운영에 필요한 안내(약관 개정 등)는 계속 발송됩니다.`;
    } catch {
      status = 400;
      message =
        "수신거부 주소가 올바르지 않습니다.\n\n" +
        "메일의 링크를 그대로 열었는지 확인해주세요. " +
        "문제가 계속되면 사이트 관리자에게 문의해주세요.";
    }

    // 텍스트로 응답한다. 메일 클라이언트에서 브라우저로 열리는 화면이므로
    // 테마 렌더를 거칠 필요가 없고, 실패해도 이 화면은 떠야 한다.
    await reply.code(status).type("text/plain; charset=utf-8").send(`${message}\n`);
  }
}
