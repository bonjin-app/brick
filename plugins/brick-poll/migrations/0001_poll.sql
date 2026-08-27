-- 설문조사
--
-- 그누보드의 설문조사(poll)에 대응한다. 설계에서 어려운 것은 두 가지다:
--   1. 중복 투표 방지 — 회원은 쉽지만 비회원은 IP 밖에 없다.
--      IP 원문을 저장하면 개인정보가 되므로 해시로만 남긴다 (ADR-35 와 같은 원칙).
--   2. 결과 공개 시점 — 투표 전에 결과를 보여주면 표가 쏠린다(밴드왜건).
--      언제 보여줄지 운영자가 정해야 한다.

CREATE TABLE IF NOT EXISTS poll_polls (
  id uuid PRIMARY KEY,
  /** 주소에 쓰는 식별자 — 블록이 어떤 설문을 보여줄지 지정하는 데 쓴다 */
  slug varchar(100) NOT NULL UNIQUE,
  question varchar(500) NOT NULL,
  /** 부가 설명 (선택) */
  description text,

  /** 복수 선택 허용. 허용하면 max_choices 까지 고를 수 있다 */
  allow_multiple boolean NOT NULL DEFAULT false,
  max_choices integer NOT NULL DEFAULT 1 CHECK (max_choices >= 1),

  /**
   * 투표 자격.
   *   guest  — 누구나 (IP 해시로 중복 방지)
   *   member — 로그인한 회원만
   */
  vote_role varchar(20) NOT NULL DEFAULT 'guest',

  /**
   * 결과를 언제 보여주는가.
   *   always      — 항상 (참여율을 보여주고 싶을 때)
   *   after_vote  — 내가 투표한 뒤 (기본값 — 밴드왜건을 줄인다)
   *   after_close — 종료 후 (표가 쏠리는 것을 완전히 막는다)
   */
  result_visibility varchar(16) NOT NULL DEFAULT 'after_vote',

  /** '기타 의견'을 받는가 — 그누보드의 기타의견에 대응 */
  allow_comment boolean NOT NULL DEFAULT false,

  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,

  /** 총 투표 수 (사람 수, 선택 수가 아니다). 목록에서 매번 세지 않기 위해 둔다 */
  vote_count integer NOT NULL DEFAULT 0 CHECK (vote_count >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poll_period_chk CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);

CREATE INDEX IF NOT EXISTS poll_polls_active_idx ON poll_polls (is_active, created_at DESC);

-- ── 선택지 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS poll_options (
  id uuid PRIMARY KEY,
  poll_id uuid NOT NULL REFERENCES poll_polls(id) ON DELETE CASCADE,
  label varchar(300) NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  /** 득표 수. 집계 쿼리를 매번 돌리지 않기 위해 둔다 (투표 시 갱신) */
  vote_count integer NOT NULL DEFAULT 0 CHECK (vote_count >= 0)
);

CREATE INDEX IF NOT EXISTS poll_options_poll_idx ON poll_options (poll_id, sort_order);

-- ── 투표 ────────────────────────────────────────────
--
-- 사람 단위로 한 행. 복수 선택은 poll_vote_choices 에 여러 행이 붙는다.
-- 이렇게 나누는 이유: "몇 명이 참여했는가"와 "각 항목이 몇 표인가"가 다른 수치이고,
-- 복수 선택에서는 선택 수 합이 참여자 수보다 크다.
CREATE TABLE IF NOT EXISTS poll_votes (
  id uuid PRIMARY KEY,
  poll_id uuid NOT NULL REFERENCES poll_polls(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  /**
   * 비회원 식별 — IP 를 sha256 으로 해시해 남긴다.
   *
   * 원문을 저장하지 않는 이유: 투표 기록 + IP 는 "누가 무엇에 투표했는가"가 되어
   * 민감한 개인정보가 된다. 해시는 중복 판정(같은지 비교)에는 충분하고
   * 목록으로 뽑아볼 수는 없다.
   *
   * 완벽하지 않다 — 같은 공유기 아래 여러 사람이 한 표로 묶인다.
   * 완벽한 방지는 본인 인증뿐이고, 설문에 그 비용을 요구할 수는 없다.
   */
  voter_hash varchar(64),
  /** 기타 의견 */
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poll_votes_voter_chk CHECK (user_id IS NOT NULL OR voter_hash IS NOT NULL)
);

-- 한 설문에 한 번만. 회원과 비회원을 따로 잡는다 (부분 인덱스로 NULL 제외)
CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_user_once_idx
  ON poll_votes (poll_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_guest_once_idx
  ON poll_votes (poll_id, voter_hash) WHERE voter_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS poll_votes_poll_idx ON poll_votes (poll_id, created_at DESC);

CREATE TABLE IF NOT EXISTS poll_vote_choices (
  vote_id uuid NOT NULL REFERENCES poll_votes(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  PRIMARY KEY (vote_id, option_id)
);

CREATE INDEX IF NOT EXISTS poll_vote_choices_option_idx ON poll_vote_choices (option_id);
