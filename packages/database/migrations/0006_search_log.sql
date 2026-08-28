-- 검색 로그 · 인기 검색어
--
-- **무엇을 찾다가 못 찾고 나갔는지가 운영자에게 가장 값진 데이터다.**
-- 지금은 아무 기록도 없어서, 손님이 있는 줄 알고 검색한 것이 실제로 있는지도
-- 알 수 없다.
--
-- 쇼핑몰이면 "결과 0건" 은 곧 팔 수 있었는데 못 판 것이고, 사이트면
-- 안내가 없어서 문의로 이어지는 것이다.

CREATE TABLE IF NOT EXISTS search_logs (
  id uuid PRIMARY KEY,

  /**
   * 정규화된 검색어.
   *
   * 집계의 기준이다. 앞뒤 공백을 떼고, 연속 공백을 하나로 줄이고, 소문자로
   * 바꾼다 — "  아이폰  케이스 " 와 "아이폰 케이스" 가 다른 검색어로 집계되면
   * 인기 검색어가 흩어져 아무 의미가 없다.
   */
  query varchar(200) NOT NULL,

  /** 원문 — 정규화가 무엇을 지웠는지 확인할 때 쓴다 */
  raw_query varchar(200) NOT NULL,

  /**
   * 결과 수.
   *
   * 0 인 것을 따로 본다. 그것이 이 테이블의 존재 이유다.
   */
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),

  /** 특정 분류만 검색했으면 그 코드 (posts, products…) */
  scope varchar(30),

  /** 로그인한 회원이면 id. 비회원은 NULL */
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  /**
   * IP 해시 — 원본을 남기지 않는다 (ADR-35 와 같은 원칙).
   *
   * 같은 사람이 연속 입력한 것을 묶어 세는 데만 쓴다. 검색어는 그 자체로
   * 민감할 수 있어서(질병·법률 문의) 접속 위치와 함께 보관할 이유가 없다.
   */
  ip_hash varchar(64),

  created_at timestamptz NOT NULL DEFAULT now()
);

-- 인기 검색어 집계 — 기간으로 자르고 검색어별로 센다
CREATE INDEX IF NOT EXISTS search_logs_created_idx ON search_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS search_logs_query_idx ON search_logs (query, created_at DESC);
-- 결과 0건만 보는 화면 — 부분 인덱스로 그것만 빠르게 읽는다
CREATE INDEX IF NOT EXISTS search_logs_empty_idx
  ON search_logs (created_at DESC) WHERE result_count = 0;

-- ── 검색어 치환·차단 ────────────────────────────────
--
-- 두 가지 실제 필요:
--
--   치환 — 손님이 "아이폰15" 로 찾는데 상품명이 "iPhone 15" 면 결과가 0건이다.
--          로그를 보고 운영자가 연결해줄 수 있어야 한다.
--   차단 — 경쟁사명·욕설·의미 없는 문자열이 인기 검색어에 뜨는 것을 막는다.
--          인기 검색어는 화면에 노출되므로 방치하면 사이트가 이상해진다.
CREATE TABLE IF NOT EXISTS search_rules (
  id uuid PRIMARY KEY,
  /** 정규화된 검색어 (입력값) */
  term varchar(200) NOT NULL UNIQUE,
  /**
   * replace — 다른 검색어로 바꿔 검색한다
   * block   — 인기 검색어 집계에서 제외한다 (검색 자체는 막지 않는다)
   */
  kind varchar(16) NOT NULL,
  /** kind = replace 일 때 바꿀 검색어 */
  replacement varchar(200),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_rules_replacement_chk
    CHECK (kind <> 'replace' OR (replacement IS NOT NULL AND replacement <> ''))
);
