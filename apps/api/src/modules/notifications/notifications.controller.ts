import { Body, Controller, Get, OnModuleDestroy, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { NotificationStreamHub } from "./notification-stream.js";
import { NotificationsService } from "./notifications.service.js";
import { AuthGuard } from "../auth/auth.guard.js";

/** 내 알림함 — 로그인한 사람만. 남의 알림은 어떤 경로로도 읽을 수 없다 */
@Controller("api/notifications")
@UseGuards(AuthGuard)
export class NotificationsController implements OnModuleDestroy {
  /** 열린 실시간 스트림을 모두 쥐고 있는 허브 — 접속자 전원을 한 번의 질의로 센다 */
  private readonly hub: NotificationStreamHub;

  constructor(private readonly notifications: NotificationsService) {
    this.hub = new NotificationStreamHub(notifications);
  }

  onModuleDestroy(): void {
    this.hub.closeAll();
  }

  /**
   * 실시간 알림 개수 (SSE). 응답을 우리가 직접 쓰므로 Fastify 에서 떼어 낸다(`hijack`) —
   * 그러지 않으면 압축·직렬화 훅이 스트림을 모아 버려 한 건도 나가지 않는다.
   */
  @Get("stream")
  stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply): void {
    const userId = (req as { user?: { id: string } }).user!.id;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // nginx 등 역프록시가 응답을 모으지 않게 한다
      "x-accel-buffering": "no",
    });
    const close = this.hub.open(userId, {
      write: (chunk) => { raw.write(chunk); },
      end: () => { raw.end(); },
    });
    /*
     * 끝남은 **응답**의 close 로 본다 — 요청의 close 는 요청 본문을 다 읽은 시점(GET 은 곧바로)에 불릴 수 있어
     * 연결이 살아 있는데 스트림을 닫거나, 반대로 끊긴 연결을 놓칠 수 있다. 끊긴 소켓에 쓰면 'error' 가 나는데
     * 듣는 곳이 없으면 프로세스가 죽으므로 닫음으로 받아 낸다.
     */
    raw.on("close", close);
    raw.on("error", close);
  }

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
