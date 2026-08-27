-- brick-memo 스키마.
--
-- 설계 요점:
--  1. **각자 삭제.** 받는 사람이 지워도 보낸 사람의 보낸함에는 남아야 한다
--     (그누보드와 같은 동작). 그래서 삭제 플래그를 양쪽에 따로 둔다.
--     둘 다 지웠을 때만 정리 작업이 실제로 지운다.
--  2. **보낸 사람 이름 스냅샷.** 발신자가 탈퇴해도 받은함이 깨지지 않아야 한다.
--  3. 안읽은 개수를 자주 조회하므로 부분 인덱스를 둔다.
CREATE TABLE IF NOT EXISTS memo_messages (
  id                 uuid PRIMARY KEY,
  -- 탈퇴하면 NULL. 이름은 스냅샷으로 남는다
  sender_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  sender_name        varchar(100) NOT NULL,
  receiver_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content            text NOT NULL,
  is_read            boolean NOT NULL DEFAULT false,
  read_at            timestamptz,
  -- 각자 삭제
  sender_deleted_at   timestamptz,
  receiver_deleted_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memo_inbox_idx
  ON memo_messages (receiver_id, created_at DESC) WHERE receiver_deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS memo_sent_idx
  ON memo_messages (sender_id, created_at DESC) WHERE sender_deleted_at IS NULL;
-- 안읽은 개수 배지는 모든 페이지에서 조회될 수 있다
CREATE INDEX IF NOT EXISTS memo_unread_idx
  ON memo_messages (receiver_id) WHERE is_read = false AND receiver_deleted_at IS NULL;

-- ── 차단 ──────────────────────────────────────────────
-- 그누보드에는 없지만 실사용에서 필요하다. 차단하면 그 회원의 쪽지를 받지 않는다.
CREATE TABLE IF NOT EXISTS memo_blocks (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blocked_id),
  CONSTRAINT memo_blocks_not_self CHECK (user_id <> blocked_id)
);
