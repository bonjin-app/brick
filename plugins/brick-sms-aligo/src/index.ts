import { definePlugin, normalizePhone, maskPhone } from "@brick/plugin-sdk";

/**
 * 문자 발송 — 알리고(aligo.in).
 *
 * **왜 플러그인인가.** 한국에는 알리고·솔라피·NHN·네이버 클라우드가 있고 어느
 * 쪽을 쓸지는 운영자가 정한다(결제 게이트웨이와 같은 판단이다). 코어는 발송기
 * 하나가 등록되어 있는지만 알면 된다 — `ctx.registerSmsGateway`.
 *
 * 알리고를 먼저 만든 이유는 작은 가게에서 가장 널리 쓰이고, API 가 단순한 폼
 * 전송이라 다른 공급자를 얹을 때의 뼈대가 되기 때문이다.
 */
interface AligoSettings {
  enabled: boolean;
  /** 알리고 계정 아이디 */
  userId: string;
  apiKey: string;
  /**
   * 발신번호.
   *
   * 한국은 **발신번호 사전등록제**다(전기통신사업법). 등록하지 않은 번호로는
   * 보낼 수 없고, 공급자가 거절한다. 그래서 여기 적는 번호는 알리고에 등록해
   * 둔 번호여야 한다 — 설명에 그 말을 적어 둔다.
   */
  sender: string;
}

const DEFAULTS: AligoSettings = { enabled: false, userId: "", apiKey: "", sender: "" };

/** 알리고 API 주소 — 시험에서는 스텁으로 돌린다 (토스 플러그인과 같은 방식) */
const API_BASE = process.env.BRICK_ALIGO_API_BASE?.replace(/\/$/, "") || "https://apis.aligo.in";

/**
 * 장문 기준.
 *
 * 90바이트를 넘으면 LMS 로 나가고 요금이 다르다(대략 세 배). 한글은 EUC-KR
 * 기준 2바이트라 45자쯤이다. 자르지 않는다 — 잘린 주문 안내는 안 보낸 것만
 * 못하다. 대신 어느 쪽으로 나가는지 공급자에게 정확히 알려 준다.
 */
const SMS_BYTES = 90;

function byteLength(text: string): number {
  // EUC-KR 기준: 한글·전각 2바이트, 나머지 1바이트
  let n = 0;
  for (const ch of text) n += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return n;
}

export default definePlugin((ctx) => {
  const load = async (): Promise<AligoSettings> => ({
    ...DEFAULTS,
    ...((await ctx.settings.get<AligoSettings>("config")) ?? {}),
  });

  ctx.registerSmsGateway({
    get enabled() {
      // 게터다 — 운영자가 설정을 바꾸면 다시 시작하지 않아도 반영되어야 한다
      return ready;
    },
    async send(message) {
      const cfg = await load();
      const to = normalizePhone(message.to);
      if (!cfg.enabled || !cfg.apiKey || !cfg.userId || !cfg.sender || !to) return false;

      const long = byteLength(message.text) > SMS_BYTES;
      const body = new URLSearchParams({
        key: cfg.apiKey,
        user_id: cfg.userId,
        sender: normalizePhone(cfg.sender) || cfg.sender,
        receiver: to,
        msg: message.text,
        msg_type: long ? "LMS" : "SMS",
        ...(long && message.title ? { title: message.title.slice(0, 44) } : {}),
      });

      try {
        const res = await fetch(`${API_BASE}/send/`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          // 문자 공급자가 느려도 주문을 붙잡고 있으면 안 된다
          signal: AbortSignal.timeout(10_000),
        });
        const data = (await res.json().catch(() => ({}))) as { result_code?: number | string; message?: string };
        const code = Number(data.result_code ?? -1);
        if (code > 0) return true;
        /*
         * 실패 이유는 로그에만 남긴다 — **번호는 가려서**.
         * 발송 로그는 파일에 남고 운영자 아닌 사람도 볼 수 있다.
         */
        ctx.logger.warn(`문자 발송 실패 (${maskPhone(to)}): ${String(data.message ?? res.status)}`);
        return false;
      } catch (err) {
        ctx.logger.warn(`문자 발송 실패 (${maskPhone(to)}): ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
  });

  /** 설정이 다 채워졌는가 — 게터가 매번 DB 를 읽지 않도록 저장할 때 갱신한다 */
  let ready = false;
  const refresh = async () => {
    const cfg = await load();
    ready = Boolean(cfg.enabled && cfg.apiKey && cfg.userId && cfg.sender);
  };
  void refresh();

  ctx.registerRoute("GET", "/admin/config", async (req) => {
    if (req.user?.role !== "admin") throw Object.assign(new Error("권한이 없습니다."), { status: 403 });
    const cfg = await load();
    return {
      enabled: cfg.enabled,
      userId: cfg.userId,
      sender: cfg.sender,
      // API 키는 내려보내지 않는다 — 빈 값으로 저장하면 기존 값을 유지한다
      apiKey: "",
      apiKeyConfigured: Boolean(cfg.apiKey),
    };
  });

  ctx.registerRoute("PUT", "/admin/config", async (req) => {
    if (req.user?.role !== "admin") throw Object.assign(new Error("권한이 없습니다."), { status: 403 });
    const b = (req.body ?? {}) as Partial<AligoSettings>;
    const current = await load();
    const sender = String(b.sender ?? current.sender).trim();
    if (b.enabled && !normalizePhone(sender)) {
      throw Object.assign(new Error(ctx.t("err.senderRequired")), { status: 400 });
    }
    await ctx.settings.set<AligoSettings>("config", {
      enabled: b.enabled !== undefined ? Boolean(b.enabled) : current.enabled,
      userId: String(b.userId ?? current.userId).trim().slice(0, 50),
      apiKey: b.apiKey?.trim() ? b.apiKey.trim() : current.apiKey,
      sender,
    });
    await refresh();
    return { ok: true };
  });

  ctx.registerAdminResource({
    name: "config",
    kind: "settings",
    title: "문자 발송",
    itemLabel: "설정",
    basePath: "/admin/config",
    order: 45,
    adminOnly: true,
    description:
      "알리고(aligo.in)에서 발급한 API 키를 입력하세요. " +
      "발신번호는 한국의 발신번호 사전등록제에 따라 알리고에 미리 등록한 번호여야 합니다. " +
      "문자는 건당 요금이 나가므로, 어떤 안내를 문자로 보낼지는 각 기능의 설정에서 켭니다.",
    fields: [
      { name: "enabled", label: "문자 사용", type: "boolean" },
      { name: "userId", label: "알리고 아이디", type: "text" },
      { name: "apiKey", label: "API 키", type: "text", secret: true,
        help: "비워두고 저장하면 기존 값이 유지됩니다." },
      { name: "sender", label: "발신번호", type: "text",
        help: "알리고에 사전 등록한 번호만 쓸 수 있습니다 (전기통신사업법)." },
      { name: "apiKeyConfigured", label: "API 키 설정됨", type: "boolean", readOnly: true },
    ],
  });

  return {};
});
