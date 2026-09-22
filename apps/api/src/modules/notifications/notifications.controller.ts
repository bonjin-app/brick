import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { NotificationsService } from "./notifications.service.js";
import { AuthGuard } from "../auth/auth.guard.js";

/** 내 알림함 — 로그인한 사람만. 남의 알림은 어떤 경로로도 읽을 수 없다 */
@Controller("api/notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(@Req() req: FastifyRequest, @Query("limit") limit?: string, @Query("before") before?: string) {
    const userId = (req as { user?: { id: string } }).user!.id;
    const [items, unread] = await Promise.all([
      // 형식이 아닌 값을 그대로 넘기면 SQL 이 터진다 — 없는 것으로 본다
      this.notifications.list(userId, { limit: Number(limit) || undefined, before: asUuid(before) }),
      this.notifications.unreadCount(userId),
    ]);
    return { items, unread };
  }

  /** 읽음 표시 — `id` 가 없으면 전부 */
  @Post("read")
  async read(@Req() req: FastifyRequest, @Body() body?: { id?: string }) {
    const userId = (req as { user?: { id: string } }).user!.id;
    // id 하나를 주면 그것만, 없으면 전부 (사람이 "모두 읽음" 을 누른 경우다)
    const one = body?.id?.trim();
    const marked = await this.notifications.markRead(userId, one ? [one] : undefined);
    return { ok: true, marked, unread: await this.notifications.unreadCount(userId) };
  }
}

/** uuid 형식일 때만 이어 읽기 지점으로 쓴다 */
function asUuid(v?: string): string | undefined {
  const s = String(v ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : undefined;
}
