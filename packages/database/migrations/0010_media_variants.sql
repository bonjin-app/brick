-- 업로드 이미지의 치수와 썸네일 (M32)
--
-- width/height: 업로드 시점에 읽어 둔다. 목록·에디터가 이미지 비율을 미리 알면 레이아웃이
--   흔들리지 않고(CLS), 관리자가 "이 이미지가 너무 큰가"를 눈으로 판단할 수 있다.
-- thumb_key: 목록용 정사각 WebP. 원본을 CSS 로 줄여 보여주면 내려받는 양은 그대로다 —
--   휴대폰 사진 한 장이 4MB 이므로 목록 40장이면 160MB 다.
-- 값이 NULL 인 행은 sharp 없이 올라온(또는 이 기능 이전의) 파일이다 — 화면은 원본으로 폴백한다.
ALTER TABLE media_files
  ADD COLUMN IF NOT EXISTS width integer,
  ADD COLUMN IF NOT EXISTS height integer,
  ADD COLUMN IF NOT EXISTS thumb_key text;
