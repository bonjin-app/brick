import { definePlugin } from "@brick/plugin-sdk";

/**
 * 토스페이먼츠 API 주소.
 *
 * `BRICK_TOSS_API_BASE` 로 바꿀 수 있다 — **테스트 전용**이다.
 * 돈이 오가는 경로(부분 취소 금액이 정확히 전달되는가)를 실제 HTTP 로 검증하려면
 * 스텁 PG 를 세워야 하는데, 주소가 상수면 그럴 수 없다.
 *
 * https 가 아닌 주소는 **localhost 일 때만** 허용한다. 운영 환경에서 이 변수가
 * 잘못 설정되어 카드 정보가 평문으로 나가는 것을 막는다.
 */
const TOSS_API = resolveApiBase();

function resolveApiBase(): string {
  const DEFAULT = "https://api.tosspayments.com/v1";
  const override = process.env.BRICK_TOSS_API_BASE?.trim();
  if (!override) return DEFAULT;
  try {
    const url = new URL(override);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) return DEFAULT;
    return override.replace(/\/$/, "");
  } catch {
    return DEFAULT;
  }
}

interface TossSettings {
  secretKey: string;
  /** 프론트엔드 위젯에 쓰는 클라이언트 키 (공개해도 되는 값) */
  clientKey: string;
  enabled: boolean;
}

/**
 * 토스페이먼츠 게이트웨이.
 *
 * 이 플러그인은 **코어와 brick-shop을 수정하지 않는다.**
 * `shop.payment.register` 훅으로 게이트웨이를 넘기면 brick-shop이 받아 쓴다 —
 * 결제수단을 추가하는 표준 경로다.
 *
 * 금액 검증은 brick-shop이 한다. 이 플러그인은 PG가 확인한 실제 승인 금액을
 * 정직하게 반환하는 책임만 진다.
 */
export default definePlugin(async (ctx) => {
  const load = async (): Promise<TossSettings> => ({
    secretKey: "",
    clientKey: "",
    enabled: false,
    ...((await ctx.settings.get<Partial<TossSettings>>("config")) ?? {}),
  });

  /** 토스 API 인증 헤더 — 시크릿 키의 Basic 인증 (비밀번호 없음) */
  const authHeader = (secretKey: string) =>
    `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;

  async function callToss(
    path: string,
    body: unknown,
    secretKey: string,
    idempotencyKey?: string,
  ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    // PG 호출은 타임아웃이 없으면 요청이 무한히 매달릴 수 있다
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${TOSS_API}${path}`, {
        method: "POST",
        headers: {
          Authorization: authHeader(secretKey),
          "Content-Type": "application/json",
          // 토스가 지원하는 멱등키 — 네트워크 재시도로 이중 승인되는 것을 PG 쪽에서도 막는다
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        status: 0,
        data: { message: aborted ? "결제 서버 응답 시간이 초과되었습니다." : String(err) },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const gateway = {
    provider: "toss",
    displayName: "카드·간편결제",

    /** 키가 없거나 꺼져 있으면 결제수단으로 노출하지 않는다 */
    async isReady() {
      const cfg = await load();
      return cfg.enabled === true && Boolean(cfg.secretKey) && Boolean(cfg.clientKey);
    },
    async confirm(params: { orderNo: string; providerTid: string; claimedAmount: number }) {
      const cfg = await load();
      if (!cfg.enabled || !cfg.secretKey) {
        return { ok: false, failureReason: "토스페이먼츠가 설정되지 않았습니다." };
      }

      // 토스 승인 API는 amount를 요구한다. 여기서 보내는 금액이 실제 결제 금액과
      // 다르면 토스가 거부하므로, 승인 성공 = 금액 일치를 PG가 보증한 것이다.
      // 그럼에도 brick-shop이 응답 금액을 주문 총액과 다시 대조한다 (이중 방어).
      const res = await callToss(
        "/payments/confirm",
        {
          paymentKey: params.providerTid,
          orderId: params.orderNo,
          amount: params.claimedAmount,
        },
        cfg.secretKey,
        // 주문번호만 쓰면 **한 번 실패한 시도가 그 주문의 모든 재시도를 오염시킨다.**
        // 토스는 같은 키에 저장된 응답을 그대로 돌려주므로, 금액이나 결제키가
        // 잘못된 첫 시도의 실패 응답이 재생되어 손님이 그 주문을 영구히 결제할
        // 수 없게 된다.
        //
        // 멱등성의 목적은 **같은 요청의 재시도**를 안전하게 하는 것이므로,
        // 요청을 유일하게 만드는 값(결제키·금액)을 모두 넣는다.
        `confirm-${params.orderNo}-${params.providerTid}-${params.claimedAmount}`,
      );

      if (!res.ok) {
        return {
          ok: false,
          failureReason: String(res.data.message ?? `승인 실패 (HTTP ${res.status})`),
          raw: sanitize(res.data),
        };
      }
      return {
        ok: true,
        // PG가 확인한 실제 승인 금액. brick-shop이 이 값을 주문 총액과 대조한다.
        approvedAmount: Number(res.data.totalAmount),
        method: String(res.data.method ?? "카드"),
        raw: sanitize(res.data),
      };
    },

    /**
     * 정기결제 — 빌링키 발급.
     *
     * 카드 등록은 토스의 화면에서 일어나고 우리는 authKey 만 받는다.
     * **카드번호는 이 서버를 지나가지 않는다.**
     */
    async issueBillingKey(params: { authKey: string; customerKey: string }) {
      const cfg = await load();
      if (!cfg.enabled || !cfg.secretKey) {
        return { ok: false, failureReason: "토스페이먼츠가 설정되지 않았습니다." };
      }
      const res = await callToss(
        "/billing/authorizations/issue",
        { authKey: params.authKey, customerKey: params.customerKey },
        cfg.secretKey,
        // authKey 는 1회용이므로 그 자체가 요청을 유일하게 만든다
        `billing-issue-${params.authKey}`,
      );
      if (!res.ok) {
        return { ok: false, failureReason: String(res.data.message ?? "카드 등록 실패") };
      }
      const card = res.data.card as { issuerCode?: string; company?: string; number?: string } | undefined;
      // 표시용 라벨 — 마스킹된 뒷자리만. 전체 번호는 응답에도 없다
      const tail = String(card?.number ?? "").slice(-4);
      return {
        ok: true,
        billingKey: String(res.data.billingKey),
        cardLabel: [String(card?.company ?? res.data.cardCompany ?? "카드"), tail ? `****${tail}` : ""]
          .filter(Boolean).join(" "),
      };
    },

    /** 빌링키 청구 — 승인 금액을 그대로 반환한다 (호출자가 대조한다) */
    async chargeBillingKey(params: {
      billingKey: string;
      customerKey: string;
      orderNo: string;
      amount: number;
      orderName: string;
      idempotencyKey: string;
    }) {
      const cfg = await load();
      if (!cfg.enabled || !cfg.secretKey) {
        return { ok: false, failureReason: "토스페이먼츠가 설정되지 않았습니다." };
      }
      const res = await callToss(
        `/billing/${encodeURIComponent(params.billingKey)}`,
        {
          customerKey: params.customerKey,
          amount: params.amount,
          orderId: params.orderNo,
          orderName: params.orderName.slice(0, 100),
        },
        cfg.secretKey,
        // 호출자가 준 회차 키를 그대로 쓴다 — 같은 회차의 재시도는 PG 에서도 한 번이다
        params.idempotencyKey,
      );
      if (!res.ok) {
        return {
          ok: false,
          failureReason: String(res.data.message ?? `청구 실패 (HTTP ${res.status})`),
          raw: sanitize(res.data),
        };
      }
      return {
        ok: true,
        providerTid: String(res.data.paymentKey),
        approvedAmount: Number(res.data.totalAmount),
        method: String(res.data.method ?? "카드"),
        raw: sanitize(res.data),
      };
    },

    async cancel(params: {
      providerTid: string;
      amount?: number;
      reason: string;
      idempotencyKey?: string;
    }) {
      const cfg = await load();
      if (!cfg.secretKey) return { ok: false, failureReason: "토스페이먼츠가 설정되지 않았습니다." };

      const res = await callToss(
        `/payments/${encodeURIComponent(params.providerTid)}/cancel`,
        {
          cancelReason: params.reason.slice(0, 200),
          ...(params.amount ? { cancelAmount: params.amount } : {}),
        },
        cfg.secretKey,
        // 호출자(brick-shop)가 준 키를 쓴다.
        //
        // 여기서 `${providerTid}-${amount}` 로 만들면 **같은 금액의 서로 다른
        // 취소가 하나로 합쳐진다** — 같은 가격 상품 두 개를 따로 반품하면
        // 두 번째 환불이 PG 에서 재생되고, 우리는 환불했다고 기록한다.
        // 돌려줘야 할 돈이 사업자에게 남는다. 취소 동작을 유일하게 아는 것은
        // 누적 환불액을 가진 호출자다.
        params.idempotencyKey ?? `cancel-${params.providerTid}-${params.amount ?? "full"}`,
      );

      if (!res.ok) {
        return { ok: false, failureReason: String(res.data.message ?? "취소 실패"), raw: sanitize(res.data) };
      }
      return { ok: true, raw: sanitize(res.data) };
    },
  };

  // brick-shop에 게이트웨이 등록
  await ctx.hooks.doAction("shop.payment.register", { gateway });

  // ── 프론트엔드가 위젯을 띄우는 데 필요한 공개 정보 ──
  ctx.registerRoute("GET", "/config", async () => {
    const cfg = await load();
    // 시크릿 키는 절대 반환하지 않는다
    return { enabled: cfg.enabled && Boolean(cfg.secretKey), clientKey: cfg.clientKey };
  });

  // ── 관리자 설정 ─────────────────────────────────────
  ctx.registerRoute("GET", "/admin/config", async (req) => {
    if (req.user?.role !== "admin") throw Object.assign(new Error("권한이 없습니다."), { status: 403 });
    const cfg = await load();
    return {
      clientKey: cfg.clientKey,
      enabled: cfg.enabled,
      // 시크릿 키는 설정 여부만 알려준다
      secretKeyConfigured: Boolean(cfg.secretKey),
    };
  });

  ctx.registerRoute("PUT", "/admin/config", async (req) => {
    if (req.user?.role !== "admin") throw Object.assign(new Error("권한이 없습니다."), { status: 403 });
    const b = req.body as Partial<TossSettings>;
    const current = await load();
    const next: TossSettings = {
      // 빈 값을 보내면 기존 시크릿을 유지한다 (실수로 지우는 것을 막는다)
      secretKey: b.secretKey?.trim() ? b.secretKey.trim() : current.secretKey,
      clientKey: (b.clientKey ?? current.clientKey).trim(),
      enabled: b.enabled ?? current.enabled,
    };
    if (next.enabled && !next.secretKey) {
      throw Object.assign(new Error("시크릿 키를 먼저 입력해주세요."), { status: 400 });
    }
    await ctx.settings.set("config", next);
    return { ok: true, secretKeyConfigured: Boolean(next.secretKey) };
  });

  ctx.registerAdminResource({
    name: "config",
    title: "토스페이먼츠",
    itemLabel: "설정",
    basePath: "/admin/config-list",
    order: 40,
    description:
      "토스페이먼츠 개발자센터에서 발급한 키를 입력하세요. " +
      "시크릿 키는 저장 후 다시 표시되지 않으며, 비워두고 저장하면 기존 값이 유지됩니다.",
    can: { create: false, delete: false },
    fields: [
      { name: "enabled", label: "결제 사용", type: "boolean", inList: true },
      { name: "clientKey", label: "클라이언트 키", type: "text", inList: true,
        help: "test_ck_ 또는 live_ck_ 로 시작합니다. 공개되어도 되는 값입니다." },
      { name: "secretKey", label: "시크릿 키", type: "text",
        help: "test_sk_ 또는 live_sk_ 로 시작합니다. 절대 외부에 노출하지 마세요." },
      { name: "secretKeyConfigured", label: "시크릿 키 설정됨", type: "boolean", readOnly: true, inList: true },
    ],
  });

  // 관리자 리소스는 목록 형태를 기대하므로 단일 설정을 한 줄로 감싼다
  ctx.registerRoute("GET", "/admin/config-list", async (req) => {
    if (req.user?.role !== "admin") throw Object.assign(new Error("권한이 없습니다."), { status: 403 });
    const cfg = await load();
    return {
      items: [{
        id: "config",
        enabled: cfg.enabled,
        clientKey: cfg.clientKey,
        secretKey: "",
        secretKeyConfigured: Boolean(cfg.secretKey),
      }],
      total: 1,
    };
  });

  ctx.registerRoute("PUT", "/admin/config-list/:id", async (req) => {
    if (req.user?.role !== "admin") throw Object.assign(new Error("권한이 없습니다."), { status: 403 });
    const b = req.body as Partial<TossSettings>;
    const current = await load();
    const next: TossSettings = {
      secretKey: b.secretKey?.trim() ? b.secretKey.trim() : current.secretKey,
      clientKey: (b.clientKey ?? current.clientKey).trim(),
      enabled: b.enabled ?? current.enabled,
    };
    if (next.enabled && !next.secretKey) {
      throw Object.assign(new Error("시크릿 키를 먼저 입력해주세요."), { status: 400 });
    }
    await ctx.settings.set("config", next);
    return { ok: true };
  });

  return {};
});

/**
 * PG 응답에서 민감정보를 제거한다.
 * 카드번호·영수증 URL 같은 값을 그대로 DB에 남기면 유출 시 피해가 커진다.
 */
function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const KEEP = [
    "paymentKey", "orderId", "status", "totalAmount", "balanceAmount",
    "method", "approvedAt", "requestedAt", "currency", "code", "message",
  ];
  const out: Record<string, unknown> = {};
  for (const key of KEEP) if (key in data) out[key] = data[key];
  return out;
}
