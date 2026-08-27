-- 1:1 문의 · FAQ
--
-- 왜 게시판으로 하지 않는가:
--   게시판은 "기본이 공개"다. 문의는 반대로 **기본이 비공개**여야 한다.
--   게시판에 비밀글 옵션을 켜서 쓰면 실수로 공개 글을 쓰는 순간
--   주문번호·연락처가 노출된다. 기본값이 안전한 쪽이어야 한다.
--
--   그리고 문의에는 게시판에 없는 것이 필요하다 — 답변 상태, 담당자,
--   답변 알림, "내 문의만 보이는 목록".

-- ── 1:1 문의 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS help_tickets (
  id uuid PRIMARY KEY,
  /** 문의 번호 — 사용자가 전화로 말할 수 있는 짧은 식별자 */
  ticket_no varchar(20) NOT NULL UNIQUE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  /** 작성 시점 스냅샷. 회원이 탈퇴해도 목록이 깨지지 않는다 */
  author_name varchar(100) NOT NULL,
  /** 답변 알림을 보낼 주소. 비회원 문의를 허용할 때 필요하다 */
  author_email varchar(255),
  category varchar(50) NOT NULL DEFAULT '일반',
  title varchar(300) NOT NULL,
  content text NOT NULL,
  /** open(접수) | answered(답변완료) | closed(종료) */
  status varchar(16) NOT NULL DEFAULT 'open',
  /** 담당자 — 여러 운영자가 있을 때 중복 답변을 막는다 */
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  /** 첨부 (미디어 라이브러리 URL 목록) */
  attachments jsonb NOT NULL DEFAULT '[]',
  /** 비회원 문의 조회용 비밀번호 해시 (scrypt). 회원 문의는 NULL */
  guest_password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  CONSTRAINT help_tickets_owner_chk CHECK (user_id IS NOT NULL OR guest_password_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS help_tickets_user_idx ON help_tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS help_tickets_status_idx ON help_tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS help_tickets_assignee_idx ON help_tickets (assignee_id)
  WHERE assignee_id IS NOT NULL;

-- 문의 번호 시퀀스.
-- count(*)+1 로 만들면 동시 접수에서 중복이 난다 (주문번호에서 이미 겪었다).
CREATE SEQUENCE IF NOT EXISTS help_ticket_no_seq START 1;

-- ── 대화 (문의 ↔ 답변) ──────────────────────────────
--
-- 답변을 티켓에 한 칸으로 두지 않는다. 실제 문의는 한 번에 끝나지 않고
-- "추가로 여쭤봅니다 → 답변 → 확인했습니다"로 이어진다.
CREATE TABLE IF NOT EXISTS help_replies (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES help_tickets(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name varchar(100) NOT NULL,
  /** true 면 운영자 답변 — 화면에서 다르게 표시한다 */
  is_staff boolean NOT NULL DEFAULT false,
  content text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS help_replies_ticket_idx ON help_replies (ticket_id, created_at);

-- ── FAQ ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS help_faq_categories (
  id uuid PRIMARY KEY,
  name varchar(100) NOT NULL,
  slug varchar(100) NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  is_visible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS help_faqs (
  id uuid PRIMARY KEY,
  category_id uuid REFERENCES help_faq_categories(id) ON DELETE SET NULL,
  question varchar(500) NOT NULL,
  answer text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_visible boolean NOT NULL DEFAULT true,
  /** 조회수 — 어떤 질문이 많은지 알면 FAQ를 개선할 수 있다 */
  view_count integer NOT NULL DEFAULT 0,
  /** 도움이 되었나 — 답변 품질을 측정하는 유일한 신호 */
  helpful_count integer NOT NULL DEFAULT 0,
  unhelpful_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS help_faqs_category_idx ON help_faqs (category_id, sort_order);
-- 한국어 검색은 simple 사전으로 (ADR-9 와 같은 판단)
CREATE INDEX IF NOT EXISTS help_faqs_search_idx ON help_faqs
  USING gin (to_tsvector('simple', question || ' ' || answer));

-- 기본 분류 — 비어 있으면 FAQ 화면이 아무것도 못 보여준다
INSERT INTO help_faq_categories (id, name, slug, sort_order)
SELECT gen_random_uuid(), '자주 묻는 질문', 'general', 0
WHERE NOT EXISTS (SELECT 1 FROM help_faq_categories);
