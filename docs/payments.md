# 결제

Brick은 특정 PG에 묶이지 않습니다. **결제수단은 플러그인으로 추가**하며,
코어나 brick-shop을 수정하지 않습니다.

## 기본 제공

| 결제수단 | 플러그인 | 상태 |
|---|---|---|
| 무통장입금 | brick-shop 내장 | 사용 가능 |
| 카드·계좌이체·간편결제 | brick-pay-toss | 키 입력 후 사용 가능 |

## 토스페이먼츠 설정

1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com/)에서 키 발급
2. 관리자 → 플러그인 → **토스페이먼츠 결제** 활성화
3. 관리자 → **토스페이먼츠** 메뉴에서 키 입력

| 항목 | 설명 |
|---|---|
| 클라이언트 키 | `test_ck_` / `live_ck_`. 프론트엔드에 노출되는 값 |
| 시크릿 키 | `test_sk_` / `live_sk_`. **절대 노출 금지.** 저장 후 다시 표시되지 않음 |
| 결제 사용 | 켜면 주문서에 카드 결제가 나타남 |

시크릿 키는 저장 후 조회할 수 없습니다. 비워두고 저장하면 기존 값이 유지되므로
클라이언트 키만 바꿀 때 실수로 지워지지 않습니다.

## 결제 흐름

```
1. 고객이 주문 생성        POST /orders  (idempotencyKey 권장)
        │  → 주문번호, 총액
        ▼
2. 프론트엔드가 PG 위젯 호출 (클라이언트 키 사용)
        │  → PG가 paymentKey 발급
        ▼
3. 승인 요청               POST /payments/confirm
        │     { orderNo, provider, providerTid, amount }
        ▼
4. brick-shop이 검증
        ├─ PG에 승인 요청 → PG가 확인한 실제 금액 수신
        ├─ 주문 총액과 대조 ─── 불일치 → PG 취소 + 실패 기록
        ├─ 중복 거래 확인 ───── 중복 → 409
        └─ 상태 머신으로 paid 전이 (재고는 주문 시점에 이미 차감됨)
```

## 왜 이렇게 방어하는가

커머스에서 결제는 틀리면 **바로 돈이 새는** 경로입니다. 다음을 명시적으로 막습니다.

### 1. 금액 위조

클라이언트가 보낸 금액을 절대 신뢰하지 않습니다.
**PG가 확인한 실제 승인 금액**과 **DB의 주문 총액**이 정확히 일치할 때만 승인합니다.
불일치하면 즉시 PG 취소를 시도하고 실패로 기록합니다 — 공격이거나 심각한 버그이므로
조용히 넘기지 않습니다.

### 2. 중복 승인

`shop_payments (provider, provider_tid)` 에 unique 인덱스가 있습니다.
같은 PG 거래로 두 번 승인 처리하는 것을 **DB가** 막습니다.

- 같은 거래 재전송(웹훅 재시도) → 멱등하게 성공 반환
- 다른 거래로 같은 주문 재결제 → 409 + PG 취소 시도

### 3. 주문 중복 (네트워크 재시도)

주문 생성에 `idempotencyKey` 를 넣으면 같은 키로는 주문이 한 번만 만들어집니다.
결제 직전 재시도로 주문이 두 번 생기면 **재고가 이중 차감**되므로 중요합니다.

```json
POST /api/plugins/brick-shop/orders
{ "items": [...], "orderer": {...}, "idempotencyKey": "<UUID>" }
```

### 4. 무통장입금 권한

입금 확인은 **관리자만** 할 수 있습니다. 고객이 스스로 결제완료로 바꿀 수 없습니다.

### 5. 민감정보

- 시크릿 키는 공개 API로 나가지 않습니다 (설정 여부만 반환)
- PG 응답은 화이트리스트로 걸러 저장합니다 — 카드번호·영수증 URL 등은 남기지 않습니다

## 환불

```
POST /api/plugins/brick-shop/admin/payments/refund
{ "orderNo": "20260825-000001", "amount": 10000, "reason": "일부 품절" }
```

- `amount` 를 생략하면 잔액 전액 환불
- 누적 환불액이 결제액을 넘을 수 없습니다 (코드 + DB CHECK 이중 방어)
- **전액 환불되면 주문이 `refunded` 로 전이되고 재고가 복원됩니다**
- 부분 환불은 주문 상태를 바꾸지 않고 이력만 남깁니다

## 새 PG 붙이기

플러그인 하나로 끝납니다. brick-shop을 수정하지 않습니다.

```ts
import { definePlugin } from "@brick/plugin-sdk";

export default definePlugin(async (ctx) => {
  const gateway = {
    provider: "mypg",
    displayName: "마이PG",

    async confirm({ orderNo, providerTid, claimedAmount }) {
      const res = await callMyPg(providerTid, claimedAmount);
      if (!res.ok) return { ok: false, failureReason: res.message };
      return {
        ok: true,
        // 반드시 PG가 확인한 실제 금액을 반환해야 한다.
        // brick-shop이 이 값을 주문 총액과 대조한다.
        approvedAmount: res.amount,
        method: res.method,
        raw: res.safeFields,
      };
    },

    async cancel({ providerTid, amount, reason }) {
      const res = await cancelMyPg(providerTid, amount, reason);
      return res.ok ? { ok: true } : { ok: false, failureReason: res.message };
    },
  };

  await ctx.hooks.doAction("shop.payment.register", { gateway });
  return {};
});
```

**게이트웨이 구현자의 책임**: `approvedAmount` 는 반드시 PG가 실제로 승인한 금액이어야
합니다. 여기서 요청 금액을 그대로 되돌려주면 금액 검증이 무의미해집니다.

PG 인증 정보는 `ctx.settings` 에 저장하고, 공개 API로 시크릿을 반환하지 마세요.

## PG 호출 시 주의

- **타임아웃 필수** — 없으면 요청이 무한히 매달립니다 (토스 플러그인은 15초)
- **멱등키 전달** — PG가 지원하면 함께 보내 이중 승인을 PG 쪽에서도 막습니다
- **응답 필터링** — 민감 필드를 그대로 DB에 남기지 마세요

## 아직 없는 것

정기결제(빌링), 에스크로, 현금영수증·세금계산서 발행, 해외 결제(Stripe/PayPal),
가상계좌 자동 입금확인 웹훅.

관련 문서: [쇼핑몰](commerce.md) · [보안](security.md) · [플러그인 개발](plugin-development.md)
