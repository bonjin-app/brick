-- 여분 필드 (게시판마다 정하는 추가 입력칸)
--
-- 그누보드5 는 게시판마다 `wr_1`~`wr_10` 열 개의 추가 입력칸을 주고, 그 이름은
-- 게시판 설정의 `bo_1_subj`~`bo_10_subj` 에 있다. 한국 사이트에서 아주 널리
-- 쓰인다 — 연락처, 지역, 학번, 차량번호, 행사 신청 항목 같은 것들이 전부 여기
-- 들어가 있다.
--
-- **우리 이전 도구는 그것을 통째로 버렸다.** 글은 옮겨지는데 그 옆의 연락처와
-- 지역은 사라지고, 사라졌다는 말조차 없었다. 옮긴 뒤에야 알아채면 원본
-- 데이터베이스를 다시 찾아야 한다.
--
-- 칸의 이름은 게시판이 갖고, 값은 글이 갖는다. 그누보드와 같은 구조다.
ALTER TABLE board_boards
  ADD COLUMN IF NOT EXISTS extra_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

-- `{"f1": "010-0000-0000", "f3": "서울"}` — 정의된 칸만 들어간다
ALTER TABLE board_posts
  ADD COLUMN IF NOT EXISTS extra jsonb NOT NULL DEFAULT '{}'::jsonb;
