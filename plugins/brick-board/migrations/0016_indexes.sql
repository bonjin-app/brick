-- 새 조회 조건을 받치는 인덱스
--
--  - board_comments.parent_id: 지운 댓글의 자리를 치우는 반복(comments.ts removeComments)이 "이 자리 아래에 답글이 있는가"
--    를 묻고, parent_id 의 ON DELETE CASCADE 도 같은 조회를 한다. 인덱스가 없어 매번 댓글 전체를 훑었다.
--  - board_posts.thread_id: "이 글 아래에 답변글이 있는가"(작성자 삭제 제한 · access.ts authorChangeBlock). 스레드 인덱스는
--    (board_id, ...) 로 시작해 이 조회를 받치지 못했다. text_pattern_ops 는 `thread_path LIKE 'x.%'` 접두 검색을 받친다.
--  - board_comments(post_id) WHERE deleted_at IS NOT NULL: 지운 자리만 모은 작은 인덱스 — 치우는 반복이 쓴다.
CREATE INDEX IF NOT EXISTS board_comments_parent_idx ON board_comments (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS board_posts_thread_id_idx ON board_posts (thread_id, thread_path text_pattern_ops);
CREATE INDEX IF NOT EXISTS board_comments_placeholder_idx ON board_comments (post_id) WHERE deleted_at IS NOT NULL;
