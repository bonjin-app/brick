-- 알림 문구 — 운영자가 고친 것만 둔다
--
-- 주문 안내 같은 알림 문구가 코드(번역 카탈로그)에 있어서, 운영자가 "입금 확인 후 1~2일
-- 안에 발송됩니다" 한 줄을 더하려면 개발자가 코드를 고쳐야 했다. 알림을 보내는 플러그인이
-- 알림 종류·변수·기본 문구를 선언하고(ctx.registerNotificationEvent), 운영자가 고친 문구만
-- 여기 남는다. 행이 없으면 기본 문구로 나간다 — 되돌리기는 행을 지우는 것이다.
CREATE TABLE IF NOT EXISTS notification_templates (
  event varchar(80) PRIMARY KEY,
  subject varchar(300) NOT NULL,
  body text NOT NULL,
  -- 문자 전용 문구 (비우면 제목 + 본문). 짧게 쓰면 장문(LMS) 대신 단문으로 나가 요금이 준다
  sms text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
