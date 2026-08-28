# 포인트 (brick-point)

활동 적립과 구매 적립금을 **하나로** 다룹니다.
게시판 활동 적립, 쇼핑몰 결제 시 사용, 구매 적립, 만료까지 한 원장에서 관리합니다.

## 시작하기

관리자 → 플러그인 → **포인트** 활성화. 그것으로 끝입니다.

활성화하면 게시판·쇼핑몰이 **자동으로** 연동됩니다 — 서로를 수정하지 않습니다.
반대로 포인트를 끄면 게시판과 쇼핑몰은 그대로 동작합니다.

사이드바에 **포인트**(회원별 잔액)와 **포인트 설정** 메뉴가 나타납니다.

## 적립 · 사용

| 시점 | 기본값 | 설정 |
|---|---|---|
| 회원가입 | 1,000 | `signupPoint` |
| 게시글 작성 | 10 | `postPoint` |
| 댓글 작성 | 5 | `commentPoint` |
| 상품 후기 작성 | 100 | `reviewPoint` — 구매 확인된 후기만 |
| 출석(로그인) | 0 (끔) | `loginPoint` — 1일 1회 |
| 구매 (결제 완료) | 결제금액의 1% | `purchaseRate` |

| 사용 제한 | 기본값 | 설정 |
|---|---|---|
| 주문당 사용 한도 | 주문금액의 50% | `maxUseRate` |
| 최소 사용 포인트 | 100 | `minUse` |
| 유효기간 | 365일 (0이면 무기한) | `expireDays` |

## 설계에서 중요한 것

포인트는 **돈에 준합니다.** 잔액이 어긋나면 신뢰를 잃습니다.

### 1. 원장 + 잔여량 (단순 잔액 컬럼이 아니다)

```
point_ledger
  amount     +1000   -- 감사용 증감
  remaining   1000   -- 적립 행에서만: 아직 쓰지 않은 양
  expires_at  ...    -- 적립마다 다를 수 있다
```

**잔액 = 만료되지 않은 적립 행의 `remaining` 합.** 별도 잔액 컬럼을 두지 않으므로
원장과 잔액이 어긋날 여지가 없습니다.

왜 이렇게 하는가:
- **감사 추적** — "왜 늘었나/줄었나"가 모두 남습니다
- **정확한 만료** — 적립마다 유효기간이 다를 수 있습니다
- **FIFO 소비** — 만료가 임박한 것부터 씁니다. 사용자에게 유리하고 만료 손실이 적습니다

### 2. 멱등성 — 두 번 적립되지 않는다

`(user_id, kind, ref_type, ref_id)` 에 unique 인덱스가 있습니다.

```
글쓰기 적립  → ("board.post", "<글id>")
구매 적립    → ("shop.order", "<주문번호>")
후기 적립    → ("shop.review", "<후기id>")
출석 적립    → ("auth.login", "<회원id>:<날짜>")
```

훅이 재실행되거나 결제 웹훅이 재전송되어도 **DB가** 중복을 막습니다.
같은 원인으로 이미 적립되었으면 조용히 아무 일도 하지 않습니다.

### 3. 원자성 — 주문과 차감은 하나의 트랜잭션

주문 생성과 포인트 차감이 분리되면, 하나만 성공했을 때 잔액이 어긋납니다.

그래서 포인트 서비스의 모든 쓰기 메서드가 **`tx`(트랜잭션 핸들)를 받습니다.**
쇼핑몰은 자기 주문 트랜잭션 안에서 차감합니다:

```
BEGIN
  재고 차감 (조건부 UPDATE)
  포인트 차감 (FIFO, FOR UPDATE)
  주문 생성
COMMIT
```

재고 부족으로 실패하면 포인트도 되돌아갑니다.
> 스모크 테스트가 이것을 검증합니다: 재고 1개에 동시 3주문 → 1건만 성공,
> 포인트는 정확히 1건분만 차감.

### 4. 동시 사용 방어

FIFO 소비는 적립 행을 `FOR UPDATE` 로 잠근 뒤 깎습니다.
잠그지 않으면 동시 요청이 같은 포인트를 두 번 써서 **잔액을 초과 사용**할 수 있습니다.

### 5. 잔액 부족은 예외가 아니라 false

`spend()` 는 잔액이 부족하면 **`false` 를 반환하고 아무것도 바꾸지 않습니다.**
예외를 던지지 않는 이유: 호출자가 "포인트 없이 계속"을 선택할 수 있어야 합니다.

### 6. 취소·환불 시 복원

주문이 `cancelled` 또는 `refunded` 로 전이되면 사용한 포인트가 새로 적립됩니다.
같은 주문으로 두 번 복원되지 않습니다(멱등).

## 플러그인 간 협력 — 어떻게 연결되나

훅(action/filter)으로는 표현할 수 없는 협력이 있습니다:
**호출자의 트랜잭션에 참여**해야 하는 경우입니다.

그래서 코어에 서비스 레지스트리가 있습니다:

```ts
// brick-point — 공개
ctx.provideService<PointsService>("points", points);

// brick-shop — 사용 (없어도 동작해야 한다)
const port = ctx.useService<PointsPort>("points");
if (port) {
  await port.spend({ userId, amount, reason, refType, refId }, tx);
}
```

**사용 시점에 조회합니다.** 활성화 시점에 조회하면 플러그인 활성화 순서에 의존하게 되어,
쇼핑몰이 먼저 켜진 경우 포인트를 못 찾습니다.

쇼핑몰은 `PointsPort` 인터페이스를 **자기 파일에 좁게 선언**합니다 —
brick-point에 대한 컴파일 의존이 생기지 않으므로 포인트 없이도 빌드·동작합니다.

## API

`/api/plugins/brick-point` 아래입니다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/my?page=` | 내 잔액 · 내역 · 30일 내 만료 예정액 |
| GET | `/usable?amount=` | 주문금액 기준 사용 가능액 (한도·최소액 적용) |
| GET | `/admin/balances` | 회원별 잔액 (관리자) |
| PUT | `/admin/balances/:id` | 수동 지급(양수)·차감(음수) |
| GET | `/admin/ledger/:userId` | 특정 회원 원장 |
| GET/PUT | `/admin/settings` | 적립 정책 |

## 다른 플러그인에서 쓰기

```ts
interface PointsService {
  balance(userId, tx?): Promise<number>;
  grant({ userId, amount, reason, refType?, refId?, expireDays? }, tx?): Promise<boolean>;
  spend({ userId, amount, reason, refType?, refId? }, tx?): Promise<boolean>;
  refund({ userId, refType, refId, reason }, tx?): Promise<number>;
  previewEarn(amount): Promise<number>;
}
```

**`refType`/`refId` 를 반드시 넣으세요.** 멱등성이 이 값으로 보장됩니다.

적립 원인을 새로 만들 때는 훅을 발행하고 brick-point가 구독하게 하는 편이 낫습니다 —
포인트가 없어도 그 기능이 동작해야 하기 때문입니다.

## 아직 없는 것

포인트 선물(회원 간 이전), 등급별 적립률, 첫 구매 보너스,
포인트 사용 통계, 관리자 일괄 지급(CSV).

관련 문서: [게시판](board.md) · [쇼핑몰](commerce.md) · [플러그인 개발](plugin-development.md)
