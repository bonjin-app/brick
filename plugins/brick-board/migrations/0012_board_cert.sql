-- 게시판별 본인인증·성인 인증 (그누보드의 bo_use_cert)
--
-- 실명 커뮤니티·중고거래는 본인인증한 회원만, 성인 게시판은 청소년보호법상 성인만 쓰게 한다.
-- 판정은 코어의 본인인증 결과로 한다(ctx.identity). 이 칸은 "이 게시판이 그 확인을 요구한다" 뿐이다.
--   ''        요구하지 않음
--   verified  본인인증한 회원만 (목록·글·댓글·첨부·쓰기)
--   adult     본인인증으로 19세 이상임을 확인한 회원만
ALTER TABLE board_boards
  ADD COLUMN IF NOT EXISTS cert_required varchar(10) NOT NULL DEFAULT ''
    CHECK (cert_required IN ('', 'verified', 'adult'));
