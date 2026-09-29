/**
 * 실시간 알림 스트림 (Server-Sent Events) — 머리의 알림 개수가 새로 고침 없이 바뀐다.
 *
 * 개수는 페이지를 그릴 때 한 번 세어 넣었다. 댓글이 달려도 다음 페이지를 열 때까지 모른다.
 * 웹소켓 서버를 따로 세우지 않고 SSE 로 한다 — 단방향이고, 일반 HTTP 라 FTP 배포·저가 호스팅·역프록시에서
 * 추가 설정 없이 돌고, 브라우저의 `EventSource` 가 끊기면 저절로 다시 붙는다.
 *
 * 세 가지를 지킨다:
 *   1. **빨리**: 같은 프로세스에서 알림이 쌓이면 곧바로 개수를 밀어 준다 (`onChange`).
 *   2. **정확히**: 다른 프로세스(서버 여러 대)의 변화는 알 수 없으니 `pollMs` 마다 다시 센다. 바뀐 때만 보낸다.
 *   3. **오래 붙들지 않는다**: 회원당 `MAX_PER_USER` 개까지(탭을 여럿 열어도 연결이 쌓이지 않게 가장 오래된 것부터 닫는다),
 *      `maxAgeMs` 가 지나면 스스로 닫는다 — 로그아웃·세션 폐기·탈퇴가 열린 연결에 미치지 못하므로
 *      다시 붙을 때 인증을 새로 받게 하는 상한이다.
 *
 * 이 파일은 Fastify 를 모른다 — `write`/`end` 만 받으므로 가짜 소켓으로 직접 시험한다 (check-plugin-units.mjs).
 */

export const MAX_PER_USER = 4;

export interface StreamSource {
  unreadCount(userId: string): Promise<number>;
  onChange(userId: string, listener: () => void): () => void;
}

export interface StreamOptions {
  userId: string;
  source: StreamSource;
  /** 소켓에 쓴다. 이미 닫혔으면 던져도 된다 (그 스트림만 닫는다) */
  write(chunk: string): void;
  /** 소켓을 닫는다 */
  end(): void;
  pollMs?: number;
  heartbeatMs?: number;
  maxAgeMs?: number;
}

/** 회원별 열린 스트림 — 프로세스 안에서 상한을 센다 */
const open = new Map<string, Array<() => void>>();

/** 열린 스트림 수 (시험·진단용) */
export function openStreamCount(userId?: string): number {
  if (userId) return open.get(userId)?.length ?? 0;
  let n = 0;
  for (const list of open.values()) n += list.length;
  return n;
}

/** 스트림을 열고 닫는 함수를 돌려준다 */
export function openNotificationStream(opts: StreamOptions): () => void {
  const { userId, source, write } = opts;
  const pollMs = opts.pollMs ?? 5_000;
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const maxAgeMs = opts.maxAgeMs ?? 15 * 60_000;

  let closed = false;
  let last = -1;
  let checking = false;
  const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
  let unsubscribe: (() => void) | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t as ReturnType<typeof setTimeout>), clearInterval(t as ReturnType<typeof setInterval>);
    unsubscribe?.();
    const list = open.get(userId);
    if (list) {
      const i = list.indexOf(close);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) open.delete(userId);
    }
    try { opts.end(); } catch { /* 이미 닫힌 소켓 */ }
  };

  const send = (chunk: string) => {
    if (closed) return;
    try { write(chunk); } catch { close(); }
  };

  /** 개수를 다시 세어 바뀌었을 때만 보낸다 (겹쳐 불려도 한 번에 하나) */
  const push = async () => {
    if (closed || checking) return;
    checking = true;
    try {
      const n = await source.unreadCount(userId);
      if (n !== last) {
        last = n;
        send(`event: unread\ndata: ${JSON.stringify({ unread: n })}\n\n`);
      }
    } catch { /* 일시적인 DB 오류 — 다음 차례에 다시 센다 */ }
    finally { checking = false; }
  };

  // 상한을 넘으면 가장 오래된 연결부터 닫는다
  const list = open.get(userId) ?? [];
  open.set(userId, list);
  list.push(close);
  while (list.length > MAX_PER_USER) list[0]!();

  // 끊겼을 때 브라우저가 다시 붙기까지의 간격 — 서버가 몰리지 않게 넉넉히
  send("retry: 15000\n\n");
  // 첫 쓰기부터 실패했으면(이미 끊긴 소켓) 구독도 타이머도 만들지 않는다 — 만들면 닫힌 뒤에도 남는다
  if (closed) return close;
  unsubscribe = source.onChange(userId, () => void push());
  void push();
  timers.push(setInterval(() => void push(), pollMs));
  // 프록시가 조용한 연결을 끊지 않게 주석 줄을 보낸다
  timers.push(setInterval(() => send(": ping\n\n"), heartbeatMs));
  timers.push(setTimeout(close, maxAgeMs));
  for (const t of timers) (t as { unref?: () => void }).unref?.();

  return close;
}
