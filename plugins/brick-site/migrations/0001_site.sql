-- 방문자 집계 · 팝업/배너
--
-- 그누보드는 접속자 하나하나를 g5_visit 에 남기고 g5_visit_sum 에 일별 합계를 둔다.
-- Brick도 같은 두 층을 쓰지만, 방문자 원본은 **하루치만** 남기고 매일 정리한다.
-- 이유: 원본이 무한히 쌓이면 몇 년 뒤 가장 큰 테이블이 되는데, 정작 화면에
-- 보이는 것은 일별 합계뿐이다.

-- 오늘의 방문 (중복 판별용). 하루가 지나면 정리 작업이 지운다.
CREATE TABLE IF NOT EXISTS site_visits (
  id           uuid PRIMARY KEY,
  visit_day    date NOT NULL,
  -- IP는 원문으로 두지 않는다. 해시만으로 "같은 사람인가"를 판별할 수 있고,
  -- 유출되어도 접속자 IP 목록이 되지 않는다.
  visitor_key  varchar(64) NOT NULL,
  ip_prefix    varchar(40),           -- 지역 통계용 축약 (a.b.*)
  referer_host varchar(200),
  user_agent   varchar(300),
  is_mobile    boolean NOT NULL DEFAULT false,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- 같은 사람은 하루에 한 번만 센다
CREATE UNIQUE INDEX IF NOT EXISTS site_visits_once_idx ON site_visits (visit_day, visitor_key);
CREATE INDEX IF NOT EXISTS site_visits_day_idx ON site_visits (visit_day);

-- 일별 합계 (영구 보관)
CREATE TABLE IF NOT EXISTS site_visit_daily (
  visit_day    date PRIMARY KEY,
  total        integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  members      integer NOT NULL DEFAULT 0 CHECK (members >= 0),
  mobile       integer NOT NULL DEFAULT 0 CHECK (mobile >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 팝업 · 배너
CREATE TABLE IF NOT EXISTS site_popups (
  id           uuid PRIMARY KEY,
  title        varchar(200) NOT NULL,
  -- 'popup' = 레이어 팝업, 'banner' = 배너 블록에 노출
  kind         varchar(16) NOT NULL DEFAULT 'popup',
  content      text NOT NULL DEFAULT '',
  image_url    varchar(1000),
  link_url     varchar(1000),
  link_target  varchar(10) NOT NULL DEFAULT '_self',
  -- 노출 위치: '*' 이면 모든 경로, 그 외는 접두어 매칭 (/shop 이면 /shop/... 포함)
  path_prefix  varchar(300) NOT NULL DEFAULT '*',
  -- 레이어 팝업 위치·크기 (배너는 무시)
  pos_top      integer NOT NULL DEFAULT 40,
  pos_left     integer NOT NULL DEFAULT 40,
  width        integer NOT NULL DEFAULT 400,
  -- '하루 동안 보지 않기' 허용 여부
  hide_days    integer NOT NULL DEFAULT 1 CHECK (hide_days >= 0),
  starts_at    timestamptz,
  ends_at      timestamptz,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  view_count   integer NOT NULL DEFAULT 0,
  click_count  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_popups_live_idx
  ON site_popups (is_active, kind, sort_order);
