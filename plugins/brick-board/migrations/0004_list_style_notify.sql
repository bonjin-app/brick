-- 목록 스킨 · 알림 메일 · 썸네일 (그누보드 동등성, M25)
--
-- list_style: 기본(표) / 갤러리(썸네일 격자) / 웹진(카드 목록).
--   그누보드의 게시판 스킨 선택에 해당한다 — 같은 글 데이터를 화면만 달리 보인다.
-- notify_email: 새 글이 오면 알릴 주소 (비우면 안 보낸다). 그누보드의 새글 알림.
-- notify_comment: 댓글이 달리면 원글 작성자(회원, 이메일 있음)에게 알린다.
ALTER TABLE board_boards
  ADD COLUMN IF NOT EXISTS list_style     varchar(20)  NOT NULL DEFAULT 'basic',
  ADD COLUMN IF NOT EXISTS notify_email   varchar(255),
  ADD COLUMN IF NOT EXISTS notify_comment boolean      NOT NULL DEFAULT true;

-- 썸네일은 목록을 그릴 때 매번 본문을 파싱하지 않도록 저장 시점에 뽑아 둔다.
-- 첫 이미지 첨부의 공개 URL 또는 본문의 첫 <img src>. 없으면 NULL — 스킨이 자리표시를 그린다.
ALTER TABLE board_posts
  ADD COLUMN IF NOT EXISTS thumb_url text;
