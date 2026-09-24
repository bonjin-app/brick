-- 대기 중인 주기 작업은 하나만 · 끝난 작업은 정리한다
--
-- (1) 쇼핑몰의 주기 작업(정기결제·재입고·등급·생일 쿠폰)은 끝에서 자기 다음 차례를
-- 예약하는 사슬이다. 플러그인은 부팅할 때마다 첫 작업을 다시 심는데, 이미 대기 중인
-- 것이 있는지 보지 않았다 — 재시작한 횟수만큼 사슬이 겹쳐 같은 일을 되풀이한다
-- (개발 DB 에 넷이 겹쳐 있었다). 정기결제에서는 그 겹침이 실제 사고였다(roadmap).
--
-- 대기 중인 것만 유일하게 한다. 실행 중인 작업까지 세면, 실행 중인 작업이 끝에서
-- 자기 다음 차례를 예약하려는 순간 **자기 자신과 충돌해** 사슬이 끊긴다.
ALTER TABLE queue_jobs
  ADD COLUMN IF NOT EXISTS dedupe_key varchar(200);

CREATE UNIQUE INDEX IF NOT EXISTS queue_dedupe_pending_idx
  ON queue_jobs (dedupe_key)
  WHERE status = 'pending' AND dedupe_key IS NOT NULL;

-- (2) 정리는 queue_lease_idx(status, locked_at)를 쓴다 — 끝난 작업은 전부 한 번은
-- 집혔으므로 locked_at 이 있다. 따로 인덱스를 더하지 않는다.
