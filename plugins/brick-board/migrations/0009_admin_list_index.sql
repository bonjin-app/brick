-- 게시글 관리 목록(모든 게시판의 글)이 순차 스캔을 하고 있었다.
--
-- board_posts_list_idx 는 (board_id, is_notice, created_at) 이라 게시판을 고르지 않은
-- 첫 화면에서는 못 쓴다. 이 목록은 사이트에서 가장 길다 — 글 20,000 개로 재서
-- 전체 목록 2.21ms → 0.01ms, 비밀글만 보기 0.78ms → 0.04ms.
CREATE INDEX IF NOT EXISTS board_posts_recent_idx ON board_posts (created_at DESC);
