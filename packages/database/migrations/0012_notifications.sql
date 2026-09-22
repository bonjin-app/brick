-- 사이트 안 알림함
--
-- **지금까지 모든 알림은 메일 한 통로뿐이었다.** 댓글이 달려도, 1:1 문의에 답이
-- 달려도, 주문 상태가 바뀌어도 `mail.send` 하나로 나갔다. 그런데 SMTP 미설정은
-- 설치 직후의 **기본값**이고, 관리자 대시보드는 그 상태를 "메일이 발송되지
-- 않습니다" 라고 스스로 경고한다. 즉 기본 설치에서 모든 알림이 조용히 사라진다 —
-- 손님은 답이 없다고 느끼고 운영자는 보냈다고 믿는다.
--
-- 알림함은 메일과 **함께** 간다(대체가 아니다). 메일이 되면 둘 다 가고,
-- 안 되면 최소한 로그인한 사람은 사이트에서 본다.
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,

  /** 받는 사람. 회원만 알림함을 가진다 (비회원 손님에게는 메일만 간다) */
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  /**
   * 무엇에 대한 알림인가 — `board.comment`, `helpdesk.answered`, `shop.order` …
   *
   * 화면이 아이콘을 고르고, 나중에 "이 종류는 받지 않기"를 만들 때 기준이 된다.
   * 문구가 아니라 종류로 나누는 이유는, 문구는 언어를 따라 바뀌기 때문이다.
   */
  kind varchar(50) NOT NULL,

  /**
   * 사이트 언어로 **이미 그려진** 문구.
   *
   * 키를 저장하고 읽을 때 번역하는 방법도 있지만, 메일이 이미 쓰는 시점의 사이트
   * 언어로 나간다(메일은 사이트 밖에서 혼자 읽힌다). 두 통로가 같은 문구를
   * 내려면 같은 시점에 그려야 한다 — 다르면 손님은 다른 안내를 두 번 받는다.
   */
  title varchar(300) NOT NULL,
  body text NOT NULL DEFAULT '',

  /**
   * 눌러서 가는 곳 (사이트 안 경로).
   *
   * 알림은 "무슨 일이 있었다" 가 아니라 "가서 보라" 는 것이다. 갈 곳이 없으면
   * 읽은 사람이 할 수 있는 일이 없다.
   */
  url varchar(1000) NOT NULL DEFAULT '',

  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 내 알림 목록 (최신순)
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
-- 머리의 배지가 매 화면 읽는다 — 안 읽은 것만 빠르게 센다
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
