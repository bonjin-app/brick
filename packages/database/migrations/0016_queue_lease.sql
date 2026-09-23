-- 중단된 작업을 되찾는다 (임대 방식)
--
-- 큐는 작업을 집을 때 status 를 'running' 으로 바꿨다. 그런데 **되돌리는 곳이
-- 없었다.** 프로세스가 그 사이에 죽으면(배포, 컨테이너 재시작, OOM, 호스팅사
-- 재부팅 — 전부 일상이다) 그 행은 영원히 'running' 에 남고, 폴링은
-- status='pending' 만 보므로 아무도 다시 집지 않는다.
--
-- 가장 아픈 자리는 메일 캠페인이다. 발송 도중 재시작하면 캠페인은 '발송중'에서
-- 멈춘 채 더 이상 한 통도 나가지 않고, 관리자가 다시 시작하려 하면 "이미 발송
-- 중입니다" 라고 거절당한다. 화면에는 오류도 경고도 없다 — 진행률이 40%에서
-- 멈춰 있을 뿐이라, 운영자는 느린 것이라고 생각하고 기다린다.
--
-- 그래서 'running' 은 소유가 아니라 **임대**로 바꾼다. 일하는 워커가 주기적으로
-- locked_at 을 갱신하고, 갱신이 끊긴 작업은 다른 워커가 되찾는다. 단순히
-- "오래된 running 은 되찾는다" 로 하면 **아직 살아서 일하는** 긴 작업(수만 명
-- 발송은 몇 시간이 걸린다)을 빼앗아 같은 메일을 두 번 보내게 된다.
ALTER TABLE queue_jobs
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- 이 마이그레이션 이전에 멈춰 있던 행들 — locked_at 이 NULL 이면 임대 만료
-- 조건에 걸리지 않아 그대로 갇힌다. 집은 시각을 알 수 없으므로 만든 시각으로
-- 둔다(이미 오래되었으므로 다음 폴링이 되찾는다).
--
-- coalesce(locked_at, created_at) 로 질의에서 피하지 않고 여기서 채우는 이유:
-- 컬럼을 식으로 감싸면 인덱스를 못 쓴다(운영 문서의 검색 인덱스 사건과 같다).
UPDATE queue_jobs SET locked_at = created_at
  WHERE status = 'running' AND locked_at IS NULL;

-- 임대가 끊긴 작업을 찾는 질의용. status 로 먼저 좁히고 locked_at 으로 자른다.
CREATE INDEX IF NOT EXISTS queue_lease_idx ON queue_jobs (status, locked_at);
