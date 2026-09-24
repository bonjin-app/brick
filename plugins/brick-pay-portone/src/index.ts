import { definePlugin } from "@brick/plugin-sdk";

/**
 * 포트원(PortOne) V2 — 국내 주요 PG 를 한 번에.
 *
 * 한국 판매자는 대개 이미 특정 PG(KG이니시스·NHN KCP·NICE페이…)와 계약되어 있다. 그 PG 가
 * 없으면 우리를 고를 수 없다. PG 마다 플러그인을 하나씩 만드는 대신 포트원을 붙이면, 판매자는
 * 포트원 콘솔에서 **이미 계약한 PG 를 채널로 등록**하기만 하면 된다 — 이니시스·KCP·NICE·
 * 토스·카카오페이·네이버페이·페이코 등 포트원이 붙인 모든 PG 가 같은 코드로 돈다.
 *
 * 토스 플러그인과 흐름이 다르다:
 *   - 서버 **승인 단계가 없다.** 결제는 브라우저(포트원 결제창)에서 끝나고, 서버는 결제 건을
 *     **조회**해 상태(PAID)와 금액을 확인한다. 조회는 몇 번을 해도 같으므로 "승인 재시도가
 *     이중 승인이 되는" 문제가 구조적으로 없다.
 *   - 그 대신 **이 결제가 이 주문의 것인지**를 서버가 따로 묶어야 한다. 결제 ID 를 주문번호로
 *     시작하게 만들고, 조회할 때 그 접두사를 확인한다 — 다른 주문의 결제 ID(같은 금액)를
 *     들고 와서 이 주문을 결제 완료로 만드는 것을 막는다.
 *
 * 금액 대조는 brick-shop 이 한다(주문 총액과 PG 가 확인한 금액). 이 플러그인은 포트원이 알려
 * 준 실제 결제 금액을 정직하게 돌려주는 책임만 진다.
 *
 * **가상계좌** — 결제창에서 계좌가 발급될 뿐 돈은 나중에 들어온다. 발급되면 brick-shop 에
 * "입금 대기"(awaitingDeposit)로 알리고, 입금은 포트원의 웹훅(`/webhook`)으로 안다. 웹훅 내용은 믿지
 * 않는다 — 결제 ID 만 받아 brick-shop 이 다시 확인(confirm → 포트원 조회)하게 한다.
 *
 * 아직 하지 않는 것: 정기결제 빌링키, 입금된 가상계좌의 환불(환불 계좌를 받아야 한다 — 포트원
 * 콘솔에서 처리한다).
 *
 * **본인인증**도 같은 계정으로 한다(다날·KCP·이니시스 통합인증을 채널로 등록). 결제와 별도로
 * 켜고 끈다 — 결제는 다른 PG 로 받고 본인인증만 포트원으로 하는 사이트도 있다.
 */
const PORTONE_API = resolveApiBase();

/**
 * `BRICK_PORTONE_API_BASE` 로 바꿀 수 있다 — **테스트 전용**이다(스텁 PG 로 돈이 오가는 경로를
 * 실제 HTTP 로 검증한다). https 가 아닌 주소는 localhost 일 때만 받는다.
 */
function resolveApiBase(): string {
  const DEFAULT = "https://api.portone.io";
  const override = process.env.BRICK_PORTONE_API_BASE?.trim();
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

/** 결제창에서 고를 수 있는 수단 */
const PAY_METHODS = ["CARD", "EASY_PAY", "TRANSFER", "MOBILE", "VIRTUAL_ACCOUNT"] as const;
type PayMethod = (typeof PAY_METHODS)[number];

interface PortOneSettings {
  enabled: boolean;
  /** 상점 ID (store-…) — 공개해도 되는 값 */
  storeId: string;
  /** 채널 키 (channel-key-…) — 어느 PG 로 결제할지. 공개해도 되는 값 */
  channelKey: string;
  /** V2 API 시크릿 — 서버에서만 쓴다 */
  apiSecret: string;
  payMethod: PayMethod;
  /** 가상계좌 입금 기한(시간) — 결제창이 계좌를 발급할 때 넘긴다 */
  vaHours: number;
  /** 본인인증 사용 — 결제와 따로 켠다 */
  identityEnabled: boolean;
  /** 본인인증 채널 키 (다날·KCP·이니시스 본인인증 채널) */
  identityChannelKey: string;
}

export default definePlugin(async (ctx) => {
  const load = async (): Promise<PortOneSettings> => ({
    enabled: false,
    storeId: "",
    channelKey: "",
    apiSecret: "",
    payMethod: "CARD",
    vaHours: 72,
    identityEnabled: false,
    identityChannelKey: "",
    ...((await ctx.settings.get<Partial<PortOneSettings>>("config")) ?? {}),
  });

  async function callPortOne(
    method: "GET" | "POST",
    path: string,
    apiSecret: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    // PG 호출은 타임아웃이 없으면 요청이 무한히 매달릴 수 있다
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${PORTONE_API}${path}`, {
        method,
        headers: {
          Authorization: `PortOne ${apiSecret}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      // 전송 실패는 status 0 — 손님에게 보여줄 이유가 없다(토스 플러그인과 같은 규칙)
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
    provider: "portone",
    displayName: "카드·간편결제 (포트원)",

    /*
     * 손님을 포트원 결제창으로 넘기는 클라이언트 단계.
     *
     * forceRedirect 로 PC·모바일 모두 **돌아오는 길을 하나로** 만든다 — 돌아오면 주문서가
     * 주소의 paymentId 로 /payments/confirm 을 부르고, 금액은 서버가 포트원에 직접 물어
     * 확인한다(화면이 보낸 금액은 신뢰하지 않는다). 카드번호는 포트원·PG 화면에서만 입력된다.
     */
    checkout: {
      script: `
  <script>
  (function(){
    window.brickPay = window.brickPay || {};
    var SDK = 'https://cdn.portone.io/v2/browser-sdk.js';

    function loadSdk(){
      if (window.PortOne) return Promise.resolve();
      return new Promise(function(resolve, reject){
        var el = document.querySelector('script[data-brick-portone]');
        if (el) { el.addEventListener('load', resolve); el.addEventListener('error', reject); return; }
        var s = document.createElement('script');
        s.src = SDK; s.async = true; s.setAttribute('data-brick-portone', '1');
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    window.brickPay['portone'] = function (order) {
      return fetch('/api/plugins/brick-pay-portone/config')
        .then(function(r){ return r.json(); })
        .then(function(cfg){
          if (!cfg.enabled || !cfg.storeId || !cfg.channelKey) throw new Error('portone not configured');
          // 결제 ID 는 **주문번호로 시작**해야 한다 — 서버가 조회할 때 이 접두사로 주문과 묶는다
          var paymentId = order.orderNo + '-' + Date.now().toString(36);
          return loadSdk().then(function(){
            return window.PortOne.requestPayment({
              storeId: cfg.storeId,
              channelKey: cfg.channelKey,
              paymentId: paymentId,
              orderName: order.orderName,
              totalAmount: order.amount,
              currency: 'CURRENCY_KRW',
              payMethod: cfg.payMethod || 'CARD',
              // 가상계좌는 입금 기한을 함께 넘긴다 — 기한이 지나면 계좌가 닫히고 주문이 자동 취소된다
              virtualAccount: cfg.payMethod === 'VIRTUAL_ACCOUNT' ? { accountExpiry: { validHours: cfg.vaHours || 72 } } : undefined,
              redirectUrl: order.returnUrl,
              forceRedirect: true
            });
          }).then(function(res){
            // 결과가 이 창으로 돌아온 경우(리다이렉트 없이) — 같은 길로 보낸다
            if (!res) return;
            var u = new URL(order.returnUrl, location.href);
            if (res.code) { u.searchParams.set('code', res.code); u.searchParams.set('message', res.message || ''); }
            else u.searchParams.set('paymentId', res.paymentId || paymentId);
            location.href = u.toString();
          });
        });
    };

    /*
     * 돌아왔을 때 주소의 값을 주문서가 읽는 모양으로 옮긴다. 실패·취소면 code 가 붙어 온다 —
     * null 을 주면 주문서가 "결제가 취소되었습니다" 로 알린다.
     */
    window.brickPay['portone'].readReturn = function (q) {
      if (q.get('code')) return null;
      var id = q.get('paymentId');
      return id ? { providerTid: id, amount: 0 } : null;
    };
  })();
  </script>`,
    },

    /** 값이 비었거나 꺼져 있으면 결제수단으로 내놓지 않는다 */
    async isReady() {
      const cfg = await load();
      return cfg.enabled && Boolean(cfg.storeId && cfg.channelKey && cfg.apiSecret);
    },

    /**
     * 결제 확인 — 포트원에 결제 건을 **조회**한다(승인 단계가 없다).
     */
    async confirm(params: { orderNo: string; providerTid: string; claimedAmount: number }) {
      const cfg = await load();
      if (!cfg.enabled || !cfg.apiSecret) {
        return { ok: false, failureReason: "포트원이 설정되지 않았습니다." };
      }
      /*
       * 이 결제가 이 주문의 것인가. 결제 ID 는 결제창을 열 때 주문번호로 시작하게 만든다.
       * 확인하지 않으면 **다른 주문의 결제 ID(같은 금액)** 를 들고 와 이 주문을 결제 완료로
       * 만들 수 있다 — 금액 대조만으로는 못 막는다.
       */
      if (!params.providerTid.startsWith(`${params.orderNo}-`)) {
        return {
          ok: false,
          failureReason: `결제 ID(${params.providerTid.slice(0, 80)})가 주문 ${params.orderNo} 의 것이 아닙니다.`,
          customerReason: "이 주문의 결제가 아닙니다. 주문서에서 다시 결제해주세요.",
        };
      }
      const res = await callPortOne("GET", `/payments/${encodeURIComponent(params.providerTid)}`, cfg.apiSecret);
      if (!res.ok) {
        return {
          ok: false,
          failureReason: String(res.data.message ?? `결제 조회 실패 (HTTP ${res.status})`),
          raw: sanitize(res.data),
        };
      }
      const status = String(res.data.status ?? "");
      if (cfg.storeId && typeof res.data.storeId === "string" && res.data.storeId !== cfg.storeId) {
        return { ok: false, failureReason: "다른 상점의 결제입니다.", raw: sanitize(res.data) };
      }
      /*
       * 가상계좌 발급 — 결제 완료가 아니라 **입금 대기**다. 계좌를 brick-shop 에 넘기면 주문을 결제대기로
       * 두고 손님에게 계좌를 보여 준다. 입금되면 웹훅이 와서 다시 여기로 온다(그때는 PAID).
       */
      if (status === "VIRTUAL_ACCOUNT_ISSUED") {
        const m = (res.data.method ?? {}) as Record<string, unknown>;
        const amt = (res.data.amount ?? {}) as Record<string, unknown>;
        if (!m.accountNumber) {
          return { ok: false, failureReason: "가상계좌 번호가 없습니다.", raw: sanitize(res.data) };
        }
        return {
          ok: true,
          approvedAmount: Number(amt.total),
          method: "가상계좌",
          awaitingDeposit: {
            bank: String(m.bank ?? ""),
            accountNumber: String(m.accountNumber),
            holder: typeof m.remitteeName === "string" ? m.remitteeName : null,
            expiresAt: typeof m.expiredAt === "string" ? m.expiredAt : null,
          },
          raw: sanitize(res.data),
        };
      }
      if (status !== "PAID") {
        /*
         * 결제가 끝나지 않았다(실패·취소·대기). 손님이 결제창에서 그만뒀거나 PG 가 거절했다.
         * 가상계좌(VIRTUAL_ACCOUNT_ISSUED)는 설정에서 고를 수 없지만, 포트원 콘솔에서 채널이
         * 그렇게 잡혀 있으면 여기로 온다 — 입금 전이므로 결제 완료가 아니다.
         */
        const label: Record<string, string> = {
          FAILED: "결제가 실패했습니다.",
          CANCELLED: "결제가 취소되었습니다.",
          PARTIAL_CANCELLED: "결제가 취소되었습니다.",
          READY: "결제가 완료되지 않았습니다.",
          PENDING: "결제가 아직 처리 중입니다. 잠시 뒤 주문 조회에서 확인해주세요.",
        };
        return {
          ok: false,
          failureReason: `포트원 결제 상태 ${status || "알 수 없음"}`,
          customerReason: label[status] ?? "결제가 완료되지 않았습니다.",
          raw: sanitize(res.data),
        };
      }
      const amount = (res.data.amount ?? {}) as Record<string, unknown>;
      const method = (res.data.method ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        // PG 가 확인한 실제 결제 금액 — brick-shop 이 주문 총액과 대조한다
        approvedAmount: Number(amount.total),
        method: methodLabel(method),
        raw: sanitize(res.data),
      };
    },

    async cancel(params: {
      providerTid: string;
      amount?: number;
      reason: string;
      idempotencyKey?: string;
      currentCancellable?: number;
      refundAccount?: { bank: string; number: string; holder: string };
    }) {
      const cfg = await load();
      if (!cfg.apiSecret) return { ok: false, failureReason: "포트원이 설정되지 않았습니다." };
      const res = await callPortOne(
        "POST",
        `/payments/${encodeURIComponent(params.providerTid)}/cancel`,
        cfg.apiSecret,
        {
          reason: params.reason.slice(0, 200),
          ...(params.amount ? { amount: params.amount } : {}),
          /*
           * 취소 전 잔액 — 포트원은 이것이 실제 잔액과 다르면 취소를 거절한다. 커밋되지 않은
           * 재시도로 같은 부분환불이 두 번 나가는 것을 PG 쪽에서도 막는다(포트원 V2 는 멱등키
           * 대신 이 장치를 둔다). 호출자가 모르면 보내지 않는다.
           */
          ...(params.currentCancellable !== undefined ? { currentCancellableAmount: params.currentCancellable } : {}),
          // 가상계좌 — 입금된 돈은 손님 계좌로 보내야 돌려줄 수 있다
          ...(params.refundAccount
            ? { refundAccount: { bank: params.refundAccount.bank, number: params.refundAccount.number, holderName: params.refundAccount.holder } }
            : {}),
        },
      );
      if (!res.ok) {
        return { ok: false, failureReason: String(res.data.message ?? "취소 실패"), raw: sanitize(res.data) };
      }
      const cancellation = (res.data.cancellation ?? {}) as Record<string, unknown>;
      // SUCCEEDED 가 정상. REQUESTED 는 PG 가 비동기로 처리하는 경우(카드는 즉시 끝난다)
      if (cancellation.status === "FAILED") {
        return { ok: false, failureReason: "포트원이 취소 실패를 알렸습니다.", raw: sanitize(res.data) };
      }
      return { ok: true, raw: sanitize(res.data) };
    },
  };

  await ctx.hooks.doAction("shop.payment.register", { gateway });

  // ── 본인인증 ────────────────────────────────────────
  ctx.registerIdentityProvider({
    name: "portone",
    // 원문이 곧 번역 키다 — 화면이 사이트 언어로 바꿔 그린다
    displayName: "휴대폰 본인인증",

    /*
     * 인증 ID 는 코어가 만들어 넘긴다(영문·숫자 40자 이하 — KCP 규칙). 돌아오는 길을 하나로
     * 만드는 것은 결제와 같다: 모바일은 redirectUrl 로 오고, PC 는 결과가 이 창으로 오므로 같은
     * 주소로 옮겨 준다.
     */
    clientScript: `
  <script>
  (function(){
    window.brickIdentity = window.brickIdentity || {};
    var SDK = 'https://cdn.portone.io/v2/browser-sdk.js';
    function loadSdk(){
      if (window.PortOne) return Promise.resolve();
      return new Promise(function(resolve, reject){
        var el = document.querySelector('script[data-brick-portone]');
        if (el) { el.addEventListener('load', resolve); el.addEventListener('error', reject); return; }
        var s = document.createElement('script');
        s.src = SDK; s.async = true; s.setAttribute('data-brick-portone', '1');
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    window.brickIdentity['portone'] = function (req) {
      return fetch('/api/plugins/brick-pay-portone/config')
        .then(function(r){ return r.json(); })
        .then(function(cfg){
          if (!cfg.identityEnabled || !cfg.storeId || !cfg.identityChannelKey) throw new Error('portone identity not configured');
          return loadSdk().then(function(){
            return window.PortOne.requestIdentityVerification({
              storeId: cfg.storeId,
              identityVerificationId: req.requestId,
              channelKey: cfg.identityChannelKey,
              redirectUrl: req.returnUrl
            });
          });
        }).then(function(res){
          if (!res) return;
          var u = new URL(req.returnUrl, location.href);
          if (res.code) { u.searchParams.set('code', res.code); u.searchParams.set('message', res.message || ''); }
          else u.searchParams.set('identityVerificationId', res.identityVerificationId || req.requestId);
          location.href = u.toString();
        });
    };
    // 실패·취소면 code 가 붙어 온다 — null 을 주면 화면이 "취소되었습니다" 로 알린다
    window.brickIdentity['portone'].readReturn = function (q) {
      if (q.get('code')) return null;
      return q.get('identityVerificationId');
    };
  })();
  </script>`,

    async isReady() {
      return identityReady(await load());
    },

    /**
     * 인증 결과 조회 — 포트원에 **직접** 묻는다. 화면이 보낸 이름·생년월일은 받지 않는다.
     */
    async verify(requestId: string) {
      const cfg = await load();
      if (!identityReady(cfg)) return { ok: false as const, reason: "포트원 본인인증이 설정되지 않았습니다." };
      const res = await callPortOne("GET", `/identity-verifications/${encodeURIComponent(requestId)}`, cfg.apiSecret);
      if (!res.ok) {
        return {
          ok: false as const,
          reason: String(res.data.message ?? `본인인증 조회 실패 (HTTP ${res.status})`),
          customerReason: res.status === 404 ? ctx.t("본인인증이 완료되지 않았습니다. 다시 인증해주세요.") : undefined,
        };
      }
      // 다른 인증의 결과가 오면 받지 않는다 (조회 경로가 어긋났거나 응답이 섞였다)
      if (res.data.id !== undefined && String(res.data.id) !== requestId) {
        return { ok: false as const, reason: "요청한 인증과 다른 결과가 왔습니다." };
      }
      if (cfg.storeId && typeof res.data.storeId === "string" && res.data.storeId !== cfg.storeId) {
        return { ok: false as const, reason: "다른 상점의 본인인증입니다." };
      }
      const status = String(res.data.status ?? "");
      if (status !== "VERIFIED") {
        return {
          ok: false as const,
          reason: `포트원 본인인증 상태 ${status || "알 수 없음"}`,
          customerReason: status === "FAILED"
            ? ctx.t("본인인증에 실패했습니다. 다시 시도해주세요.")
            : ctx.t("본인인증이 완료되지 않았습니다. 다시 인증해주세요."),
        };
      }
      const c = (res.data.verifiedCustomer ?? {}) as Record<string, unknown>;
      const gender = String(c.gender ?? "").toUpperCase();
      return {
        ok: true as const,
        person: {
          ci: typeof c.ci === "string" ? c.ci : null,
          di: typeof c.di === "string" ? c.di : null,
          name: String(c.name ?? ""),
          birthDate: String(c.birthDate ?? ""),
          gender: gender === "MALE" ? ("male" as const) : gender === "FEMALE" ? ("female" as const) : null,
          isForeigner: typeof c.isForeigner === "boolean" ? c.isForeigner : null,
        },
      };
    },
  });

  // ── 결제창을 여는 데 필요한 공개 정보 (시크릿은 절대 내보내지 않는다) ──
  ctx.registerRoute("GET", "/config", async () => {
    const cfg = await load();
    const ready = cfg.enabled && Boolean(cfg.storeId && cfg.channelKey && cfg.apiSecret);
    return {
      enabled: ready, storeId: cfg.storeId, channelKey: cfg.channelKey, payMethod: cfg.payMethod, vaHours: cfg.vaHours,
      identityEnabled: identityReady(cfg), identityChannelKey: cfg.identityChannelKey,
    };
  });

  /*
   * 웹훅 — 포트원이 결제 상태가 바뀔 때(가상계좌 입금·결제 완료·취소) 부른다.
   *
   * **내용을 믿지 않는다.** 결제 ID 만 꺼내 brick-shop 에 넘기고, brick-shop 이 포트원에 다시 물어
   * 입금·결제가 확인될 때만 결제 완료로 만든다. 그래서 위조된 통지는 "다시 확인" 을 한 번 부를 뿐이다
   * (서명 검증을 하지 않는 이유 — 원문 본문을 받지 못하는 라우트에서 서명을 흉내 내면 오히려 틀린다).
   * 쏟아부어 확인 요청을 늘리지 못하게 주소마다 한도를 둔다. 포트원은 2xx 가 아니면 다시 보내므로
   * 처리 실패도 200 으로 답한다(다시 보내도 결과가 같다).
   */
  ctx.registerRoute("POST", "/webhook", async (req) => {
    const { allowed } = await ctx.rateLimit.consume(`webhook:${req.ip ?? "?"}`, 120, 60_000);
    if (!allowed) throw Object.assign(new Error("요청이 너무 많습니다."), { status: 429 });
    const b = (req.body ?? {}) as { type?: unknown; data?: { paymentId?: unknown; storeId?: unknown } };
    const paymentId = String(b.data?.paymentId ?? "");
    // 결제 ID 는 "주문번호-접미사" 로 만들었다(결제창 스크립트) — 그 모양이 아니면 우리 결제가 아니다
    const m = /^(\d{8}-\d{6})-[0-9a-z]{1,16}$/.exec(paymentId);
    if (!m) return { ok: true, ignored: "paymentId" };
    const cfg = await load();
    if (cfg.storeId && b.data?.storeId !== undefined && String(b.data.storeId) !== cfg.storeId) {
      return { ok: true, ignored: "storeId" };
    }
    await ctx.hooks.doAction("shop.payment.webhook", { provider: "portone", providerTid: paymentId, orderNo: m[1] });
    return { ok: true };
  });

  // ── 관리자 설정 ─────────────────────────────────────
  const shown = (cfg: PortOneSettings) => ({
    enabled: cfg.enabled,
    storeId: cfg.storeId,
    channelKey: cfg.channelKey,
    payMethod: cfg.payMethod,
    vaHours: cfg.vaHours,
    identityEnabled: cfg.identityEnabled,
    identityChannelKey: cfg.identityChannelKey,
    // 시크릿은 내려보내지 않는다 — 비워 둔 채 저장하면 기존 값이 유지된다
    apiSecret: "",
    apiSecretConfigured: Boolean(cfg.apiSecret),
  });
  ctx.registerRoute("GET", "/admin/config", async (req) => {
    if (req.user?.role !== "admin") throw Object.assign(new Error("권한이 없습니다."), { status: 403 });
    return shown(await load());
  });
  ctx.registerRoute("PUT", "/admin/config", async (req) => {
    if (req.user?.role !== "admin") throw Object.assign(new Error("권한이 없습니다."), { status: 403 });
    const b = (req.body ?? {}) as Partial<PortOneSettings>;
    const current = await load();
    const payMethod = PAY_METHODS.includes(b.payMethod as PayMethod) ? (b.payMethod as PayMethod) : current.payMethod;
    const next: PortOneSettings = {
      enabled: b.enabled ?? current.enabled,
      storeId: String(b.storeId ?? current.storeId).trim(),
      channelKey: String(b.channelKey ?? current.channelKey).trim(),
      apiSecret: b.apiSecret?.trim() ? b.apiSecret.trim() : current.apiSecret,
      payMethod,
      vaHours: b.vaHours === undefined ? current.vaHours : Math.floor(Number(b.vaHours)),
      identityEnabled: b.identityEnabled ?? current.identityEnabled,
      identityChannelKey: String(b.identityChannelKey ?? current.identityChannelKey).trim(),
    };
    if (next.storeId && !/^store-[\w-]+$/.test(next.storeId)) {
      throw Object.assign(new Error("상점 ID 는 store- 로 시작합니다. 포트원 콘솔 → 연동 정보에서 확인하세요."), { status: 400, field: "storeId" });
    }
    if (next.channelKey && !/^channel-key-[\w-]+$/.test(next.channelKey)) {
      throw Object.assign(new Error("채널 키는 channel-key- 로 시작합니다. 포트원 콘솔 → 결제 연동 → 채널에서 확인하세요."), { status: 400, field: "channelKey" });
    }
    if (next.enabled && !(next.storeId && next.channelKey && next.apiSecret)) {
      throw Object.assign(new Error("상점 ID·채널 키·API 시크릿을 모두 입력해야 켤 수 있습니다."), { status: 400 });
    }
    if (!Number.isInteger(next.vaHours) || next.vaHours < 1 || next.vaHours > 720) {
      throw Object.assign(new Error("가상계좌 입금 기한은 1~720시간이어야 합니다."), { status: 400, field: "vaHours" });
    }
    if (next.identityChannelKey && !/^channel-key-[\w-]+$/.test(next.identityChannelKey)) {
      throw Object.assign(new Error("본인인증 채널 키는 channel-key- 로 시작합니다. 포트원 콘솔 → 결제 연동 → 채널에서 본인인증 채널의 키를 확인하세요."), { status: 400, field: "identityChannelKey" });
    }
    if (next.identityEnabled && !(next.storeId && next.identityChannelKey && next.apiSecret)) {
      throw Object.assign(new Error("본인인증을 켜려면 상점 ID·본인인증 채널 키·API 시크릿을 모두 입력해야 합니다."), { status: 400 });
    }
    await ctx.settings.set("config", next);
    return shown(next);
  });

  ctx.registerAdminResource({
    name: "config",
    kind: "settings",
    title: "포트원",
    itemLabel: "설정",
    basePath: "/admin/config",
    order: 41,
    adminOnly: true,
    description:
      "포트원 콘솔에서 이미 계약한 PG(이니시스·KCP·NICE·카카오페이·네이버페이 등)를 채널로 등록한 뒤 " +
      "그 채널 키를 입력하세요. API 시크릿은 저장 후 다시 표시되지 않으며, 비워두고 저장하면 기존 값이 유지됩니다.",
    fields: [
      { name: "enabled", label: "결제 사용", type: "boolean" },
      { name: "storeId", label: "상점 ID", type: "text", placeholder: "store-00000000-0000-0000-0000-000000000000",
        help: "store- 로 시작합니다. 포트원 콘솔 → 연동 정보. 공개되어도 되는 값입니다." },
      { name: "channelKey", label: "채널 키", type: "text", placeholder: "channel-key-00000000-0000-0000-0000-000000000000",
        help: "channel-key- 로 시작합니다. 어느 PG 로 결제할지 정합니다. 공개되어도 되는 값입니다." },
      { name: "apiSecret", label: "V2 API 시크릿", type: "text", secret: true,
        help: "포트원 콘솔 → 연동 정보 → V2 API. 절대 외부에 노출하지 마세요." },
      { name: "apiSecretConfigured", label: "API 시크릿 설정됨", type: "boolean", readOnly: true },
      { name: "identityEnabled", label: "본인인증 사용", type: "boolean",
        help: "켜면 회원이 휴대폰 본인인증으로 나이를 확인할 수 있습니다(성인 상품·한 사람 한 계정). 결제 사용과 따로 켭니다." },
      { name: "identityChannelKey", label: "본인인증 채널 키", type: "text", placeholder: "channel-key-00000000-0000-0000-0000-000000000000",
        help: "포트원 콘솔에 다날·KCP·이니시스 본인인증 채널을 등록하고 그 채널 키를 넣으세요. 결제 채널 키와 다릅니다." },
      { name: "payMethod", label: "결제 수단", type: "select",
        options: [
          { value: "CARD", label: "신용·체크카드" },
          { value: "EASY_PAY", label: "간편결제 (카카오페이·네이버페이 등)" },
          { value: "TRANSFER", label: "계좌이체" },
          { value: "MOBILE", label: "휴대폰 결제" },
          { value: "VIRTUAL_ACCOUNT", label: "가상계좌" },
        ],
        help: "채널이 지원하는 수단이어야 합니다. 가상계좌를 쓰려면 포트원 콘솔 → 웹훅에 이 사이트의 /api/plugins/brick-pay-portone/webhook 주소를 등록하세요 — 입금 통지가 그리로 옵니다." },
      { name: "vaHours", label: "가상계좌 입금 기한 (시간)", type: "number",
        help: "기한이 지나면 계좌가 닫히고 주문이 자동으로 취소됩니다. 1~720시간 (기본 72)." },
    ],
  });

  return {};
});

/** 본인인증을 받을 수 있는가 — 결제와 따로 판정한다 */
function identityReady(cfg: PortOneSettings): boolean {
  return cfg.identityEnabled && Boolean(cfg.storeId && cfg.identityChannelKey && cfg.apiSecret);
}

/** 결제 수단 표기 — 포트원의 method 객체(type: PaymentMethodCard 등)를 사람이 읽는 말로 */
function methodLabel(method: Record<string, unknown>): string {
  const type = String(method.type ?? "");
  if (type.includes("Card")) return "카드";
  if (type.includes("EasyPay")) {
    const provider = typeof method.provider === "string" ? method.provider : "";
    return provider ? `간편결제(${provider})` : "간편결제";
  }
  if (type.includes("Transfer")) return "계좌이체";
  if (type.includes("Mobile")) return "휴대폰";
  return "포트원";
}

/**
 * 응답에서 남길 것만 — 카드번호·영수증 URL·고객 정보는 DB 에 두지 않는다.
 */
function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const KEEP = ["id", "transactionId", "status", "storeId", "orderName", "currency", "paidAt", "type", "message"];
  const out: Record<string, unknown> = {};
  for (const key of KEEP) if (key in data) out[key] = data[key];
  if (data.amount && typeof data.amount === "object") {
    const a = data.amount as Record<string, unknown>;
    out.amount = { total: a.total, paid: a.paid, cancelled: a.cancelled };
  }
  if (data.cancellation && typeof data.cancellation === "object") {
    const c = data.cancellation as Record<string, unknown>;
    out.cancellation = { id: c.id, status: c.status, totalAmount: c.totalAmount, cancelledAt: c.cancelledAt };
  }
  return out;
}
