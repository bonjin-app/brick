import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { fillTemplate, templateVarNames, type NotificationEvent } from "@brick/core";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";
import { msg } from "../../common/localized-error.js";

type AuthedRequest = FastifyRequest & { user?: { id: string } };

/** 문자 한 통(SMS) 기준 — EUC-KR 90바이트. 넘으면 장문(LMS)으로 나가고 요금이 대략 세 배다 */
const SMS_BYTES = 90;
const smsBytes = (text: string) => {
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return n;
};

/**
 * 알림 문구 — 운영자가 주문 안내 같은 알림의 제목·본문·문자 문구를 고친다.
 *
 * 알림 종류·변수·기본 문구는 알림을 보내는 플러그인이 선언한다(`registerNotificationEvent`).
 * 여기는 운영자가 고친 것만 저장한다. 되돌리기는 지우기다 — 그러면 기본 문구로 나간다.
 */
@Controller("api/admin/notification-templates")
@UseGuards(AdminGuard)
export class NotificationTemplatesController {
  constructor(
    private readonly loader: PluginLoaderService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list() {
    const customized = await this.notifications.customizedEvents();
    return {
      items: this.loader.listNotificationEvents().map((e) => ({
        event: e.event,
        label: e.label,
        plugin: e.plugin,
        editable: Boolean(e.defaults),
        customized: customized.has(e.event),
        updatedAt: customized.get(e.event) ?? null,
      })),
    };
  }

  @Get(":event")
  async one(@Param("event") event: string) {
    const e = this.find(event);
    const tpl = await this.notifications.templateFor(e.event);
    return {
      event: e.event,
      label: e.label,
      plugin: e.plugin,
      vars: e.vars,
      defaults: e.defaults ? e.defaults() : null,
      template: tpl,
    };
  }

  @Put(":event")
  async save(@Param("event") event: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    const e = this.find(event);
    const t = this.validate(e, body);
    await this.notifications.saveTemplate(e.event, t, req.user?.id ?? null);
    await this.audit.fromRequest(req as never, {
      action: "notification.template", targetType: "notification", targetId: e.event, summary: e.label,
    });
    return { ok: true, template: await this.notifications.templateFor(e.event) };
  }

  /** 기본 문구로 되돌리기 */
  @Delete(":event")
  async reset(@Param("event") event: string, @Req() req: AuthedRequest) {
    const e = this.find(event);
    const removed = await this.notifications.removeTemplate(e.event);
    if (removed) {
      await this.audit.fromRequest(req as never, {
        action: "notification.template.reset", targetType: "notification", targetId: e.event, summary: e.label,
      });
    }
    return { ok: true, removed };
  }

  /**
   * 미리보기 — 예시 값으로 채운 결과. 문자는 **단문(SMS)으로 나가는지** 함께 알려 준다: 한 줄만
   * 줄여도 장문(LMS) 요금이 단문으로 내려가는 경우가 많다.
   */
  @Post(":event/preview")
  @HttpCode(200)
  async preview(@Param("event") event: string, @Body() body: unknown) {
    const e = this.find(event);
    const t = this.validate(e, body);
    const sample = Object.fromEntries(e.vars.map((v) => [v.name, v.sample]));
    const subject = fillTemplate(t.subject, sample).replace(/\s+/g, " ");
    const text = fillTemplate(t.body, sample);
    const sms = t.sms ? fillTemplate(t.sms, sample) : text ? `${subject}\n\n${text}` : subject;
    const bytes = smsBytes(sms);
    return { subject, body: text, sms, smsBytes: bytes, smsType: bytes > SMS_BYTES ? "LMS" : "SMS" };
  }

  private find(event: string): NotificationEvent & { plugin: string } {
    const e = this.loader.listNotificationEvents().find((x) => x.event === event);
    if (!e) throw new NotFoundException("알림 종류를 찾을 수 없습니다.");
    // 기본 문구를 선언하지 않은 알림은 고칠 수 없다 — 코드가 기본 문구를 채워 보내지 않으면
    // 운영자가 고친 문구와 원래 나가던 문구가 무엇이 다른지 알 수 없다
    if (!e.defaults) throw new BadRequestException("이 알림은 문구를 고칠 수 없습니다.");
    return e;
  }

  /**
   * 저장·미리보기 전에 본다: 제목·본문이 있는가, 길이, 그리고 **이 알림이 채울 수 없는 변수**.
   * 없는 변수를 쓰면 빈칸으로 나간다("#{적립금}님" → "님") — 운영자는 발송된 뒤에야 안다.
   */
  private validate(e: NotificationEvent, raw: unknown): { subject: string; body: string; sms: string | null } {
    const b = (raw ?? {}) as { subject?: unknown; body?: unknown; sms?: unknown };
    const subject = String(b.subject ?? "").trim();
    const body = String(b.body ?? "").replace(/\r\n/g, "\n").trim();
    const sms = String(b.sms ?? "").replace(/\r\n/g, "\n").trim();
    if (!subject) throw new BadRequestException({ message: "제목을 입력해주세요.", field: "subject" });
    if (/\n/.test(subject)) throw new BadRequestException({ message: "제목은 한 줄로 써주세요.", field: "subject" });
    if (subject.length > 200) throw new BadRequestException({ message: "제목은 200자까지 쓸 수 있습니다.", field: "subject" });
    if (!body) throw new BadRequestException({ message: "본문을 입력해주세요.", field: "body" });
    if (body.length > 5000) throw new BadRequestException({ message: "본문은 5,000자까지 쓸 수 있습니다.", field: "body" });
    if (sms.length > 2000) throw new BadRequestException({ message: "문자 문구는 2,000자까지 쓸 수 있습니다.", field: "sms" });
    const known = new Set(e.vars.map((v) => v.name));
    const unknown = templateVarNames(`${subject}\n${body}\n${sms}`).filter((v) => !known.has(v));
    if (unknown.length) {
      throw new BadRequestException(msg("err.unknownTemplateVars", {
        unknown: unknown.map((v) => `#{${v}}`).join(", "),
        known: e.vars.map((v) => `#{${v.name}}`).join(", "),
      }));
    }
    return { subject, body, sms: sms || null };
  }
}
