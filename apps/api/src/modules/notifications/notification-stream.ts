/**
 * 실시간 알림 스트림 (Server-Sent Events) — 머리의 알림 개수가 새로 고침 없이 바뀐다.
 *
 * 개수는 페이지를 그릴 때 한 번 세어 넣었다. 댓글이 달려도 다음 페이지를 열 때까지 모른다.
 * 웹소켓 서버를 따로 세우지 않고 SSE 로 한다 — 단방향이고, 일반 HTTP 라 FTP 배포·저가 호스팅·역프록시에서
 * 추가 설정 없이 돌고, 브라우저의 `EventSource` 가 끊기면 저절로 다시 붙는다.
 *
 * 네 가지를 지킨다:
 *   1. **빨리**: 같은 프로세스에서 알림이 쌓이면 곧바로 개수를 밀어 준다 (`onChange`).
 *   2. **정확히**: 다른 프로세스(서버 여러 대)의 변화는 알 수 없으니 `pollMs` 마다 다시 센다. 바뀐 때만 보낸다.
 *   3. **싸게**: 그 다시 세기는 **접속자 전원을 한 번의 질의로** 센다 — 스트림마다 세면 접속자 천 명이 초당 이백 번 질의한다.
 *   4. **오래 붙들지 않는다**: 회원당 `MAX_PER_USER` 개까지(탭을 여럿 열어도 연결이 쌓이지 않게 가장 오래된 것부터 닫는다),
 *      `maxAgeMs` 가 지나면 스스로 닫는다 — 로그아웃·세션 폐기·탈퇴가 열린 연결에 미치지 못하므로
 *      다시 붙을 때 인증을 새로 받게 하는 상한이다.
 *
 * 이 파일은 Fastify 를 모른다 — `write`/`end` 만 받으므로 가짜 소켓으로 직접 시험한다 (check-plugin-units.mjs).
 */

export const MAX_PER_USER = 4;

export interface StreamSource {
  /** 회원 여럿의 안 읽은 개수를 한 번에. 알림이 없는 회원은 빠져 있어도 된다(0 으로 읽는다) */
  unreadCounts(userIds: string[]): Promise<Map<string, number>>;
  onChange(userId: string, listener: () => void): () => void;
}

export interface StreamIo {
  /** 소켓에 쓴다. 이미 닫혔으면 던져도 된다 (그 스트림만 닫는다) */
  write(chunk: string): void;
  /** 소켓을 닫는다 */
  end(): void;
}

export interface HubOptions {
  pollMs?: number;
  heartbeatMs?: number;
  maxAgeMs?: number;
}

interface Conn {
  userId: string;
  last: number;
  closed: boolean;
  send(chunk: string): void;
  close(): void;
}

export class NotificationStreamHub {
  private readonly conns = new Map<string, Conn[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly maxAgeMs: number;

  constructor(private readonly source: StreamSource, opts: HubOptions = {}) {
    this.pollMs = opts.pollMs ?? 5_000;
    this.heartbeatMs = opts.heartbeatMs ?? 25_000;
    this.maxAgeMs = opts.maxAgeMs ?? 15 * 60_000;
  }

  /** 열린 스트림 수 (시험·진단용) */
  count(userId?: string): number {
    if (userId) return this.conns.get(userId)?.length ?? 0;
    let n = 0;
    for (const list of this.conns.values()) n += list.length;
    return n;
  }

  /** 스트림을 열고 닫는 함수를 돌려준다 */
  open(userId: string, io: StreamIo): () => void {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let unsubscribe: (() => void) | null = null;
    let checking = false;

    const conn: Conn = {
      userId,
      last: -1,
      closed: false,
      send: (chunk) => {
        if (conn.closed) return;
        try { io.write(chunk); } catch { conn.close(); }
      },
      close: () => {
        if (conn.closed) return;
        conn.closed = true;
        for (const t of timers) { clearTimeout(t); clearInterval(t as unknown as ReturnType<typeof setInterval>); }
        unsubscribe?.();
        const list = this.conns.get(userId);
        if (list) {
          const i = list.indexOf(conn);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) this.conns.delete(userId);
        }
        if (this.conns.size === 0) this.stopPolling();
        try { io.end(); } catch { /* 이미 닫힌 소켓 */ }
      },
    };

    // 상한을 넘으면 가장 오래된 연결부터 닫는다
    const list = this.conns.get(userId) ?? [];
    this.conns.set(userId, list);
    list.push(conn);
    while (list.length > MAX_PER_USER) list[0]!.close();

    // 끊겼을 때 브라우저가 다시 붙기까지의 간격 — 서버가 몰리지 않게 넉넉히
    conn.send("retry: 15000\n\n");
    // 첫 쓰기부터 실패했으면(이미 끊긴 소켓) 구독도 타이머도 만들지 않는다 — 만들면 닫힌 뒤에도 남는다
    if (conn.closed) return conn.close;

    /** 이 프로세스에서 바로 알려 온 변화: 이 회원 것만 다시 센다 */
    unsubscribe = this.source.onChange(userId, () => {
      if (checking || conn.closed) return;
      checking = true;
      this.source.unreadCounts([userId])
        .then((m) => this.deliver(conn, m.get(userId) ?? 0))
        .catch(() => { /* 일시적인 DB 오류 — 다음 주기에 다시 센다 */ })
        .finally(() => { checking = false; });
    });
    // 처음 개수는 곧바로
    this.source.unreadCounts([userId])
      .then((m) => this.deliver(conn, m.get(userId) ?? 0))
      .catch(() => { /* 다음 주기에 */ });

    // 프록시가 조용한 연결을 끊지 않게 주석 줄을 보낸다
    timers.push(setInterval(() => conn.send(": ping\n\n"), this.heartbeatMs) as unknown as ReturnType<typeof setTimeout>);
    timers.push(setTimeout(conn.close, this.maxAgeMs));
    for (const t of timers) (t as { unref?: () => void }).unref?.();

    this.startPolling();
    return conn.close;
  }

  /** 열려 있는 모든 스트림을 닫는다 (서버 종료) */
  closeAll(): void {
    for (const list of [...this.conns.values()]) for (const c of [...list]) c.close();
    this.stopPolling();
  }

  private deliver(conn: Conn, n: number): void {
    if (conn.closed || n === conn.last) return;
    conn.last = n;
    conn.send(`event: unread\ndata: ${JSON.stringify({ unread: n })}\n\n`);
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 접속한 모든 회원의 개수를 한 번의 질의로 세어, 바뀐 스트림에만 보낸다 */
  private async poll(): Promise<void> {
    if (this.polling || this.conns.size === 0) return;
    this.polling = true;
    try {
      const counts = await this.source.unreadCounts([...this.conns.keys()]);
      for (const [userId, list] of [...this.conns]) {
        const n = counts.get(userId) ?? 0;
        for (const c of [...list]) this.deliver(c, n);
      }
    } catch { /* 일시적인 DB 오류 — 다음 주기에 다시 센다 */ }
    finally { this.polling = false; }
  }
}
