import { definePlugin } from "@brick/plugin-sdk";

const TOSS_API = "https://api.tosspayments.com/v1";

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
        `confirm-${params.orderNo}`,
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

    async cancel(params: { providerTid: string; amount?: number; reason: string }) {
      const cfg = await load();
      if (!cfg.secretKey) return { ok: false, failureReason: "토스페이먼츠가 설정되지 않았습니다." };

      const res = await callToss(
        `/payments/${encodeURIComponent(params.providerTid)}/cancel`,
        {
          cancelReason: params.reason.slice(0, 200),
          ...(params.amount ? { cancelAmount: params.amount } : {}),
        },
        cfg.secretKey,
        `cancel-${params.providerTid}-${params.amount ?? "full"}`,
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
