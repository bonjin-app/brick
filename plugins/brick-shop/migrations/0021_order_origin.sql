-- 다른 시스템에서 옮겨 온 주문을 표시한다
--
-- 미결제 주문 자동 취소(unpaid.ts)가 **옮겨 온 옛 주문을 건드리면 안 된다.** 영카트의
-- '주문'(미입금) 상태는 결제대기로 옮겨지는데, 몇 년 전 것이므로 첫 정리에서 한꺼번에
-- 취소된다. 그러면 두 가지가 난다:
--   1. 우리가 **차감한 적 없는** 재고를 되돌린다 — 옮길 때 재고는 차감하지 않았으므로
--      재고 수가 부푼다(없는 물건을 판다).
--   2. 옛 손님 수백 명에게 "주문이 자동으로 취소되었습니다" 메일이 한꺼번에 나간다.
ALTER TABLE shop_orders
  ADD COLUMN IF NOT EXISTS imported_from varchar(30);

-- 이미 옮겨 온 사이트 — 이 컬럼이 생기기 전에 들어온 주문을 찾는다.
--
-- 주문번호 형식으로는 가릴 수 없다. 처음에는 "Brick 번호는 YYYYMMDD-NNNNNN, 영카트
-- od_id 는 숫자뿐" 이라고 보았는데, 이전 도구의 시험 데이터부터 20210601-0000001 처럼
-- 같은 모양이었다 — 추측에 기대면 옮겨 온 주문을 우리 주문으로 읽는다.
--
-- 대신 **행을 넣은 시각**을 본다. 주문 id 는 UUIDv7 이라 앞 48비트가 만든 시각(ms)이다.
-- 우리가 만든 주문은 그 시각과 created_at 이 같고, 옮겨 온 주문은 created_at 이 원래
-- 주문일(od_time)이라 id 시각(옮긴 날)보다 한참 앞이다. 한 시간 넘게 차이 나면 옮겨 온
-- 것으로 본다(옮기기 직전 한 시간 안에 들어온 옛 주문만 놓친다).
UPDATE shop_orders SET imported_from = 'import'
  WHERE imported_from IS NULL
    AND id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7'
    AND to_timestamp(((('x' || substr(replace(id::text, '-', ''), 1, 12))::bit(48))::bigint) / 1000.0)
        > created_at + interval '1 hour';
