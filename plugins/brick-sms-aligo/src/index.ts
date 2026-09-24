import { definePlugin, normalizePhone, maskPhone } from "@brick/plugin-sdk";

/**
 * 문자·알림톡 발송 — 알리고(aligo.in).
 *
 * **왜 플러그인인가.** 한국에는 알리고·솔라피·NHN·네이버 클라우드가 있고 어느
 * 쪽을 쓸지는 운영자가 정한다(결제 게이트웨이와 같은 판단이다). 코어는 발송기
 * 하나가 등록되어 있는지만 알면 된다 — `ctx.registerSmsGateway`.
 *
 * 알리고를 먼저 만든 이유는 작은 가게에서 가장 널리 쓰이고, API 가 단순한 폼
 * 전송이라 다른 공급자를 얹을 때의 뼈대가 되기 때문이다.
 *
 * **알림톡.** 한국 커머스의 주문·배송 안내는 문자보다 카카오 알림톡이 기본이다(싸고, 읽힌다).
 * 알림톡은 **카카오가 미리 심사한 템플릿과 글자 하나까지 같아야** 나간다 — `#{변수}` 자리만
 * 바뀔 수 있다. 그래서 본문을 그대로 보낼 수 없고, 운영자가 알림 종류(`shop.order.paid` 등)마다
 * 승인된 템플릿을 연결한다. 연결할 때 알리고에서 템플릿 원문을 받아 두고(손으로 옮겨 적으면
 * 한 글자만 틀려도 발송이 거절된다), 그 템플릿의 변수를 이 알림이 채울 수 있는지 확인한다.
 * 연결이 없는 알림은 지금처럼 문자로 나간다. 카카오톡이 없는 손님에게는 대체 문자(failover)가 간다.
 */
interface AligoSettings {
  /** 문자 사용 — 알림톡의 대체 문자도 이것을 따른다 */
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
  /** 알림톡 사용 */
  alimtalkEnabled: boolean;
  /** 카카오 채널의 발신프로필 키 — 알리고 관리 화면에서 채널을 연결하면 나온다 */
  senderKey: string;
}

/** 알림 종류에 연결한 알림톡 템플릿 — 연결할 때 알리고에서 받은 원문 그대로 */
interface LinkedTemplate {
  code: string;
  name: string;
  content: string;
  buttons: AlimtalkButton[];
}

interface AlimtalkButton {
  name: string;
  linkType: string;
  linkTypeName?: string;
  linkMo?: string;
  linkPc?: string;
  linkIos?: string;
  linkAnd?: string;
}

const DEFAULTS: AligoSettings = {
  enabled: false, userId: "", apiKey: "", sender: "", alimtalkEnabled: false, senderKey: "",
};

/** 알리고 API 주소 — 시험에서는 스텁으로 돌린다 (토스 플러그인과 같은 방식) */
const API_BASE = process.env.BRICK_ALIGO_API_BASE?.replace(/\/$/, "") || "https://apis.aligo.in";
/** 알림톡은 주소가 다르다 */
const KAKAO_BASE = process.env.BRICK_ALIGO_KAKAO_API_BASE?.replace(/\/$/, "") || "https://kakaoapi.aligo.in";

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

/** 템플릿이 쓰는 변수 이름 — 본문과 버튼 링크 모두에서 */
function templateVars(content: string, buttons: AlimtalkButton[]): string[] {
  const found = new Set<string>();
  const scan = (text: string | undefined) => {
    for (const m of String(text ?? "").matchAll(/#\{([^}]+)\}/g)) found.add(m[1].trim());
  };
  scan(content);
  for (const b of buttons) { scan(b.linkMo); scan(b.linkPc); scan(b.linkIos); scan(b.linkAnd); }
  return [...found];
}

/** `#{변수}` 를 채운다. 값이 없는 변수가 하나라도 있으면 null — 카카오가 어차피 거절한다 */
function fill(text: string, vars: Record<string, string>): string | null {
  let missing = false;
  const out = text.replace(/#\{([^}]+)\}/g, (_all, name: string) => {
    const v = vars[name.trim()];
    if (v === undefined) { missing = true; return ""; }
    return v;
  });
  return missing ? null : out;
}

export default definePlugin((ctx) => {
  const load = async (): Promise<AligoSettings> => ({
    ...DEFAULTS,
    ...((await ctx.settings.get<AligoSettings>("config")) ?? {}),
  });
  const loadTemplates = async (): Promise<Record<string, LinkedTemplate>> =>
    (await ctx.settings.get<Record<string, LinkedTemplate>>("alimtalk-templates")) ?? {};

  const smsReady = (cfg: AligoSettings) => Boolean(cfg.enabled && cfg.apiKey && cfg.userId && cfg.sender);
  const alimtalkReady = (cfg: AligoSettings) =>
    Boolean(cfg.alimtalkEnabled && cfg.apiKey && cfg.userId && cfg.sender && cfg.senderKey);

  async function sendSms(cfg: AligoSettings, to: string, message: { text: string; title?: string }): Promise<boolean> {
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
  }

  /** 알리고 알림톡 API — 폼 전송. 실패해도 던지지 않는다 */
  async function kakao(path: string, params: Record<string, string>): Promise<{ code: number; message: string; data: Record<string, unknown> }> {
    try {
      const res = await fetch(`${KAKAO_BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { code: Number(data.code ?? -1), message: String(data.message ?? `HTTP ${res.status}`), data };
    } catch (err) {
      return { code: -1, message: err instanceof Error ? err.message : String(err), data: {} };
    }
  }

  /** 알리고에 등록된 템플릿 (code 를 주면 그 하나만) */
  async function fetchTemplates(cfg: AligoSettings, code?: string) {
    const r = await kakao("/akv10/template/list/", {
      apikey: cfg.apiKey, userid: cfg.userId, senderkey: cfg.senderKey, ...(code ? { tpl_code: code } : {}),
    });
    if (r.code !== 0) return { ok: false as const, message: r.message };
    const list = Array.isArray(r.data.list) ? (r.data.list as Array<Record<string, unknown>>) : [];
    return {
      ok: true as const,
      list: list.map((t) => ({
        code: String(t.templtCode ?? ""),
        name: String(t.templtName ?? ""),
        content: String(t.templtContent ?? ""),
        // 검수 상태 — APR 이 승인. 승인 전 템플릿으로는 보낼 수 없다
        inspStatus: String(t.inspStatus ?? ""),
        // 템플릿 상태 — S 는 카카오가 중지한 것
        status: String(t.status ?? ""),
        buttons: (Array.isArray(t.buttons) ? t.buttons : []) as AlimtalkButton[],
      })),
    };
  }

  /**
   * 알림톡 한 통. 연결된 템플릿을 이 알림의 값으로 채워 보낸다.
   *
   * 대체 문자(failover)는 **문자 사용이 켜져 있을 때만** 붙인다 — 카카오톡이 없는 손님에게
   * 가는 문자도 요금이 나가는 문자다. 운영자가 문자를 끈 가게에서 몰래 문자가 나가면 안 된다.
   */
  async function sendAlimtalk(
    cfg: AligoSettings,
    tpl: LinkedTemplate,
    to: string,
    message: { text: string; title?: string; vars?: Record<string, string>; event?: string },
  ): Promise<boolean> {
    const vars = message.vars ?? {};
    const content = fill(tpl.content, vars);
    const buttons = tpl.buttons.map((b) => ({
      ...b,
      linkMo: b.linkMo ? fill(b.linkMo, vars) : b.linkMo,
      linkPc: b.linkPc ? fill(b.linkPc, vars) : b.linkPc,
    }));
    if (content === null || buttons.some((b) => b.linkMo === null || b.linkPc === null)) {
      ctx.logger.warn(`알림톡 템플릿 ${tpl.code} (${message.event ?? ""}) 의 변수를 채울 수 없어 문자로 보냅니다`);
      return false;
    }
    const failover = smsReady(cfg);
    const r = await kakao("/akv10/alimtalk/send/", {
      apikey: cfg.apiKey,
      userid: cfg.userId,
      senderkey: cfg.senderKey,
      tpl_code: tpl.code,
      sender: normalizePhone(cfg.sender) || cfg.sender,
      receiver_1: to,
      subject_1: tpl.name.slice(0, 50) || "알림",
      message_1: content,
      ...(buttons.length ? { button_1: JSON.stringify({ button: buttons }) } : {}),
      failover: failover ? "Y" : "N",
      ...(failover ? { fsubject_1: String(message.title ?? tpl.name).slice(0, 44), fmessage_1: message.text } : {}),
    });
    if (r.code === 0) return true;
    ctx.logger.warn(`알림톡 발송 실패 (${maskPhone(to)}, ${tpl.code}): ${r.message}`);
    return false;
  }

  ctx.registerSmsGateway({
    get enabled() {
      // 게터다 — 운영자가 설정을 바꾸면 다시 시작하지 않아도 반영되어야 한다
      return ready;
    },
    async send(message) {
      const cfg = await load();
      const to = normalizePhone(message.to);
      if (!to) return false;

      if (message.event && alimtalkReady(cfg)) {
        const tpl = (await loadTemplates())[message.event];
        if (tpl) {
          if (await sendAlimtalk(cfg, tpl, to, message)) return true;
          /*
           * 알림톡 요청 자체가 거절되면(포인트 부족·템플릿 중지·변수 누락) 문자로 한 번 보낸다.
           * 카카오 쪽 대체 문자와 겹치지 않는다 — 요청이 거절되면 대체 문자도 나가지 않는다.
           */
        }
      }
      if (!smsReady(cfg)) return false;
      return sendSms(cfg, to, message);
    },
  });

  /** 설정이 다 채워졌는가 — 게터가 매번 DB 를 읽지 않도록 저장할 때 갱신한다 */
  let ready = false;
  const refresh = async () => {
    const cfg = await load();
    ready = smsReady(cfg) || alimtalkReady(cfg);
  };
  void refresh();

  const forbidden = () => Object.assign(new Error("권한이 없습니다."), { status: 403 });

  const shown = (cfg: AligoSettings) => ({
    enabled: cfg.enabled,
    userId: cfg.userId,
    sender: cfg.sender,
    // API 키는 내려보내지 않는다 — 빈 값으로 저장하면 기존 값을 유지한다
    apiKey: "",
    apiKeyConfigured: Boolean(cfg.apiKey),
    alimtalkEnabled: cfg.alimtalkEnabled,
    senderKey: cfg.senderKey,
  });

  ctx.registerRoute("GET", "/admin/config", async (req) => {
    if (req.user?.role !== "admin") throw forbidden();
    return shown(await load());
  });

  ctx.registerRoute("PUT", "/admin/config", async (req) => {
    if (req.user?.role !== "admin") throw forbidden();
    const b = (req.body ?? {}) as Partial<AligoSettings>;
    const current = await load();
    const sender = String(b.sender ?? current.sender).trim();
    const next: AligoSettings = {
      enabled: b.enabled !== undefined ? Boolean(b.enabled) : current.enabled,
      userId: String(b.userId ?? current.userId).trim().slice(0, 50),
      apiKey: b.apiKey?.trim() ? b.apiKey.trim() : current.apiKey,
      sender,
      alimtalkEnabled: b.alimtalkEnabled !== undefined ? Boolean(b.alimtalkEnabled) : current.alimtalkEnabled,
      senderKey: String(b.senderKey ?? current.senderKey).trim().slice(0, 100),
    };
    // 알림톡도 발신번호가 필요하다 — 대체 문자가 그 번호로 나간다
    if ((next.enabled || next.alimtalkEnabled) && !normalizePhone(sender)) {
      throw Object.assign(new Error(ctx.t("err.senderRequired")), { status: 400 });
    }
    if (next.alimtalkEnabled && !next.senderKey) {
      throw Object.assign(new Error("알림톡을 켜려면 발신프로필 키를 입력해야 합니다. 알리고 → 카카오톡 → 채널 연결에서 확인하세요."), { status: 400, field: "senderKey" });
    }
    await ctx.settings.set<AligoSettings>("config", next);
    await refresh();
    /*
     * 저장한 설정을 GET 과 같은 모양으로 돌려준다. 관리 화면은 PUT 응답으로 폼을 다시 채우는데,
     * `{ ok: true }` 만 주었더니 저장하는 순간 아이디·발신번호·사용 여부가 **모두 빈칸으로**
     * 보였다 — 운영자는 저장이 날아간 줄 알고 다시 입력한다.
     */
    return shown(next);
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
      { name: "alimtalkEnabled", label: "알림톡 사용", type: "boolean",
        help: "켜면 템플릿을 연결한 알림은 카카오 알림톡으로 나갑니다. 카카오톡이 없는 손님에게는 문자 사용이 켜져 있을 때만 대체 문자가 갑니다." },
      { name: "senderKey", label: "발신프로필 키", type: "text", placeholder: "0123456789abcdef0123456789abcdef01234567",
        help: "알리고 → 카카오톡 → 채널 연결에서 확인합니다. 템플릿은 \"알림톡 템플릿\" 메뉴에서 알림마다 연결합니다." },
    ],
  });

  // ── 알림톡 템플릿 연결 ──────────────────────────────
  /** 알림 종류 한 줄 — 관리 목록의 행 */
  const row = (e: ReturnType<typeof ctx.notificationEvents>[number], tpl: LinkedTemplate | undefined) => ({
    event: e.event,
    label: e.label,
    // 목록에 이름만 — 편집 폼은 계산 칸을 숨기므로 운영자가 고르면서 볼 수 있는 자리는 목록이다
    vars: e.vars.map((v) => `#{${v.name}}`).join(" "),
    template_code: tpl?.code ?? "",
    template_name: tpl ? `${tpl.name} (${tpl.code})` : "",
    content: tpl?.content ?? "",
  });

  ctx.registerRoute("GET", "/admin/alimtalk", async (req) => {
    if (req.user?.role !== "admin") throw forbidden();
    const templates = await loadTemplates();
    const items = ctx.notificationEvents().map((e) => row(e, templates[e.event]));
    return { items, total: items.length, page: 1, pageSize: items.length || 1 };
  });

  ctx.registerRoute("GET", "/admin/alimtalk/:event", async (req) => {
    if (req.user?.role !== "admin") throw forbidden();
    const e = ctx.notificationEvents().find((x) => x.event === req.params.event);
    if (!e) throw Object.assign(new Error("알림 종류를 찾을 수 없습니다."), { status: 404 });
    return row(e, (await loadTemplates())[e.event]);
  });

  /**
   * 템플릿 연결 — 코드만 받고 **원문은 알리고에서 받는다.**
   *
   * 거절하는 것: 승인(APR) 전이거나 카카오가 중지한 템플릿, 그리고 이 알림이 채울 수 없는
   * 변수를 쓰는 템플릿(연결해 두면 발송할 때마다 거절된다 — 조용히 문자로만 나가게 된다).
   */
  ctx.registerRoute("PUT", "/admin/alimtalk/:event", async (req) => {
    if (req.user?.role !== "admin") throw forbidden();
    const e = ctx.notificationEvents().find((x) => x.event === req.params.event);
    if (!e) throw Object.assign(new Error("알림 종류를 찾을 수 없습니다."), { status: 404 });
    const code = String((req.body as { template_code?: unknown })?.template_code ?? "").trim();
    const templates = await loadTemplates();
    if (!code) {
      delete templates[e.event];
      await ctx.settings.set("alimtalk-templates", templates);
      return row(e, undefined);
    }
    const cfg = await load();
    if (!(cfg.apiKey && cfg.userId && cfg.senderKey)) {
      throw Object.assign(new Error("알리고 아이디·API 키·발신프로필 키를 먼저 저장하세요."), { status: 400 });
    }
    const fetched = await fetchTemplates(cfg, code);
    if (!fetched.ok) {
      throw Object.assign(new Error(ctx.t("err.templateFetch", { message: fetched.message.slice(0, 120) })), { status: 502 });
    }
    const t = fetched.list.find((x) => x.code === code);
    if (!t) throw Object.assign(new Error("알리고에 그 코드의 템플릿이 없습니다."), { status: 400, field: "template_code" });
    if (t.inspStatus !== "APR") {
      throw Object.assign(new Error("아직 카카오 검수를 통과하지 않은 템플릿입니다. 승인된 뒤에 연결하세요."), { status: 400, field: "template_code" });
    }
    if (t.status === "S") {
      throw Object.assign(new Error("카카오가 발송을 중지한 템플릿입니다."), { status: 400, field: "template_code" });
    }
    const known = new Set(e.vars.map((v) => v.name));
    const unknown = templateVars(t.content, t.buttons).filter((v) => !known.has(v));
    if (unknown.length) {
      throw Object.assign(
        new Error(ctx.t("err.templateVars", {
          unknown: unknown.map((v) => `#{${v}}`).join(", "),
          known: e.vars.map((v) => `#{${v.name}}`).join(", "),
        })),
        { status: 400, field: "template_code" },
      );
    }
    templates[e.event] = { code: t.code, name: t.name, content: t.content, buttons: t.buttons };
    await ctx.settings.set("alimtalk-templates", templates);
    return row(e, templates[e.event]);
  });

  /** 연결할 수 있는 템플릿 (승인된 것만) — 관리 화면의 선택지 */
  ctx.registerRoute("GET", "/admin/alimtalk-templates", async (req) => {
    if (req.user?.role !== "admin") throw forbidden();
    const cfg = await load();
    if (!(cfg.apiKey && cfg.userId && cfg.senderKey)) return [];
    const fetched = await fetchTemplates(cfg);
    if (!fetched.ok) return [];
    return fetched.list
      .filter((t) => t.inspStatus === "APR" && t.status !== "S")
      .map((t) => ({ value: t.code, label: `${t.name} (${t.code})` }));
  });

  ctx.registerAdminResource({
    name: "alimtalk",
    kind: "list",
    title: "알림톡 템플릿",
    itemLabel: "연결",
    basePath: "/admin/alimtalk",
    idField: "event",
    can: { create: false, update: true, delete: false },
    order: 46,
    adminOnly: true,
    description:
      "알림마다 카카오 검수를 통과한 템플릿을 연결합니다. 템플릿은 알리고(카카오톡 → 템플릿)에서 만들고, " +
      "본문의 #{변수} 는 각 알림이 채울 수 있는 이름만 쓸 수 있습니다. 연결하지 않은 알림은 문자로 나갑니다.",
    fields: [
      { name: "label", label: "알림", type: "text", readOnly: true, inList: true },
      { name: "template_name", label: "연결된 템플릿", type: "text", readOnly: true, inList: true },
      { name: "template_code", label: "템플릿", type: "select", optionsFrom: "/admin/alimtalk-templates",
        help: "승인된 템플릿만 나옵니다. 비우고 저장하면 연결을 끊습니다." },
      { name: "vars", label: "쓸 수 있는 변수", type: "text", readOnly: true, inList: true },
      { name: "content", label: "템플릿 본문", type: "textarea", readOnly: true },
      { name: "event", label: "알림 이름", type: "text", readOnly: true },
    ],
  });

  return {};
});
