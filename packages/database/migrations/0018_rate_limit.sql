-- 요청 제한을 DB 로 — 서버가 여러 대여도, 재시작해도 한도는 하나다
--
-- 요청 제한(로그인 대입·비밀번호 재설정·비회원 비밀번호…)이 서버 메모리에 있었다.
-- 서버를 둘로 늘리면 계정당 5회가 10회가 되고, 배포로 재시작할 때마다 모든 잠금이
-- 풀렸다. 운영 문서가 "알려진 한계" 로 적어 두고 있던 것이다.
--
-- UNLOGGED: 앱 재시작에는 남고(잠금이 풀리지 않는다), WAL 을 쓰지 않아 가볍다. DB 가
-- 비정상 종료되면 비워지는데, 그것은 잠금이 한 번 풀리는 것뿐이고 데이터 손실이 아니다.
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limit_hits (
  id bigserial PRIMARY KEY,
  key varchar(300) NOT NULL,
  hit_at timestamptz NOT NULL DEFAULT now()
);
-- 키별로 최근 것부터 — 창 안의 개수·가장 최근 한 번 되돌리기
CREATE INDEX IF NOT EXISTS rate_limit_hits_key_idx ON rate_limit_hits (key, hit_at DESC);
-- 정리(하루 지난 것)
CREATE INDEX IF NOT EXISTS rate_limit_hits_at_idx ON rate_limit_hits (hit_at);
