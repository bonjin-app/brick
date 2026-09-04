-- 첨부 이미지의 목록용 썸네일 (M32)
--
-- 갤러리·웹진 목록의 thumb_url 이 첨부 **원본**을 가리키고 있었다. 원본을 2000px 로 줄여도
-- 수백 KB 이고, 목록 20장이면 수 MB 다. 400px WebP 썸네일(10~20KB)을 따로 두고 목록은 그것을 쓴다.
-- NULL 이면 이 기능 이전에 올린 파일 — 화면은 원본으로 폴백하고, backfill-thumbs 가 채운다.
ALTER TABLE board_attachments
  ADD COLUMN IF NOT EXISTS thumb_key text;
