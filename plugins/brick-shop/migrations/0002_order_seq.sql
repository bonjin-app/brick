-- 주문번호 경합 제거.
--
-- count(*) + 1 로 순번을 만들면 동시 주문에서 같은 번호가 생성되어
-- unique 제약에 걸린다(실제로 발생함). 시퀀스는 트랜잭션과 무관하게
-- 원자적으로 증가하므로 경합이 없다.
CREATE SEQUENCE IF NOT EXISTS shop_order_no_seq START 1;
