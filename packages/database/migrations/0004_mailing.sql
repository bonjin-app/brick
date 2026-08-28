-- 회원 단체메일
--
-- 이 기능은 틀리면 **법을 위반한다.** 정보통신망법 제50조:
--   - 영리목적 광고성 정보는 **사전 동의**를 받은 사람에게만 보낼 수 있다
--   - 제목 앞에 **(광고)** 를 표기해야 한다
--   - 본문에 **수신거부 방법**을 명시해야 한다
-- 위반하면 3천만원 이하 과태료다.
--
-- 그래서 발송을 두 종류로 나눈다:
--   notice(공지)  — 서비스 운영에 필요한 정보. 동의 없이 보낼 수 있다
--                   (약관 개정, 점검 안내, 주문 상태 등)
--   ad(광고)      — 영리목적. marketing_opt_in = true 인 회원에게만
--
-- 구분을 사용자에게 맡기지 않는다. 종류를 고르면 **수신자 조건이 자동으로
-- 바뀌고** 광고는 제목에 (광고)가 강제로 붙는다.

CREATE TABLE IF NOT EXISTS mail_campaigns (
  id uuid PRIMARY KEY,
  /** notice(공지) | ad(광고) */
  kind varchar(16) NOT NULL,
  subject varchar(300) NOT NULL,
  body text NOT NULL,
  /** true 면 body 를 HTML 로 본다 */
  is_html boolean NOT NULL DEFAULT false,

  /**
   * 수신자 조건 (JSON).
   *   roles: ["member","manager","admin"]
   *   joinedAfter / joinedBefore: ISO 날짜
   *   inactiveDays: 이 일수 이상 미접속
   *   verifiedOnly: 이메일 인증한 회원만
   * 조건을 저장하는 이유: 나중에 "누구에게 보냈는가"를 재현해야 한다.
   */
  filters jsonb NOT NULL DEFAULT '{}',

  /**
   * draft(작성중) | sending(발송중) | sent(완료) | failed(실패) | cancelled(취소)
   *
   * 발송 중 상태를 두는 이유: 수만 명에게 보내는 것은 몇 분~몇 시간이 걸린다.
   * 요청 안에서 다 보내면 타임아웃이 나고, 어디까지 보냈는지 알 수 없어진다.
   */
  status varchar(16) NOT NULL DEFAULT 'draft',

  /** 집계 — 목록에서 매번 세지 않기 위해 둔다 */
  total_count integer NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  sent_count integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),

  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  /** 실패 사유 (SMTP 설정 없음 등) */
  error text
);

CREATE INDEX IF NOT EXISTS mail_campaigns_status_idx ON mail_campaigns (status, created_at DESC);

-- ── 발송 대상과 결과 ────────────────────────────────
--
-- 대상을 미리 확정해 행으로 만든다. 발송 중에 회원이 가입하거나 수신 동의를
-- 철회하면 조건이 달라지는데, 그때 "누구에게 보냈는가"가 흔들리면 안 된다.
--
-- 그리고 이 테이블이 **재시도의 근거**다. 중간에 서버가 죽어도 pending 인 것만
-- 다시 보내면 된다 — 이미 받은 사람에게 두 번 보내지 않는다.
CREATE TABLE IF NOT EXISTS mail_recipients (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES mail_campaigns(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  /**
   * 발송 시점의 주소 스냅샷.
   *
   * users.email 을 조인하지 않는 이유: 회원이 주소를 바꾸거나 탈퇴하면
   * "어디로 보냈는가"가 사라진다. 발송 이력은 사실의 기록이어야 한다.
   */
  email varchar(255) NOT NULL,
  /** pending | sent | failed | skipped */
  status varchar(16) NOT NULL DEFAULT 'pending',
  error text,
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS mail_recipients_campaign_idx
  ON mail_recipients (campaign_id, status);
-- 같은 캠페인에서 같은 주소로 두 번 보내지 않는다
CREATE UNIQUE INDEX IF NOT EXISTS mail_recipients_once_idx
  ON mail_recipients (campaign_id, email);

-- ── 수신거부 토큰 ───────────────────────────────────
--
-- 정보통신망법 제50조 제4항은 수신거부 방법을 **본문에 명시**하라고 정한다.
-- 로그인해서 설정을 바꾸라고 하는 것은 "쉬운 방법"이 아니다 —
-- 메일의 링크 한 번으로 해제되어야 한다.
--
-- 토큰은 회원별로 하나이고 만료되지 않는다. 오래된 메일의 링크도 동작해야 한다.
CREATE TABLE IF NOT EXISTS mail_unsubscribe_tokens (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token varchar(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
