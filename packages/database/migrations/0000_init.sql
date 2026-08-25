-- Brick Core 초기 스키마.
-- 이후 스키마 변경은 drizzle-kit generate로 관리한다.

CREATE TABLE IF NOT EXISTS users (
  id                uuid PRIMARY KEY,
  email             varchar(255) NOT NULL UNIQUE,
  password_hash     text NOT NULL,
  display_name      varchar(100) NOT NULL,
  role              varchar(20) NOT NULL DEFAULT 'member',
  email_verified_at timestamptz,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

CREATE TABLE IF NOT EXISTS sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS site_settings (
  key        varchar(255) PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pages (
  id           uuid PRIMARY KEY,
  slug         varchar(255) NOT NULL,
  title        varchar(500) NOT NULL,
  blocks       jsonb NOT NULL DEFAULT '[]',
  plain_text   text NOT NULL DEFAULT '',
  status       varchar(20) NOT NULL DEFAULT 'draft',
  seo          jsonb NOT NULL DEFAULT '{}',
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pages_slug_idx ON pages (slug);
CREATE INDEX IF NOT EXISTS pages_status_idx ON pages (status);
CREATE INDEX IF NOT EXISTS pages_fts_idx ON pages USING gin (to_tsvector('simple', title || ' ' || plain_text));

CREATE TABLE IF NOT EXISTS menus (
  id         uuid PRIMARY KEY,
  location   varchar(50) NOT NULL,
  items      jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_files (
  id           uuid PRIMARY KEY,
  storage_key  text NOT NULL UNIQUE,
  file_name    varchar(500) NOT NULL,
  content_type varchar(200) NOT NULL,
  size         varchar(20) NOT NULL,
  uploader_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_uploader_idx ON media_files (uploader_id);

CREATE TABLE IF NOT EXISTS installed_plugins (
  name         varchar(100) PRIMARY KEY,
  version      varchar(50) NOT NULL,
  manifest     jsonb NOT NULL,
  is_active    boolean NOT NULL DEFAULT false,
  installed_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE TABLE IF NOT EXISTS installed_themes (
  name         varchar(100) PRIMARY KEY,
  version      varchar(50) NOT NULL,
  manifest     jsonb NOT NULL,
  is_active    boolean NOT NULL DEFAULT false,
  installed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plugin_migrations (
  id          varchar(255) PRIMARY KEY,
  plugin_name varchar(100) NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Redis 없이 동작하기 위한 인프라 테이블
-- 캐시는 UNLOGGED: 크래시 시 사라져도 되는 데이터라 WAL 부하를 없앤다
CREATE UNLOGGED TABLE IF NOT EXISTS cache_entries (
  key        varchar(500) PRIMARY KEY,
  value      jsonb NOT NULL,
  tags       jsonb NOT NULL DEFAULT '[]',
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS cache_expires_idx ON cache_entries (expires_at);

CREATE TABLE IF NOT EXISTS queue_jobs (
  id           varchar(36) PRIMARY KEY,
  name         varchar(200) NOT NULL,
  payload      jsonb NOT NULL,
  status       varchar(20) NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_at       timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_poll_idx ON queue_jobs (status, name, run_at);
