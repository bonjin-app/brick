-- 페이지 이전 버전 (리비전)
--
-- **덮어쓰면 되돌릴 길이 없었다.** 블록 열 개를 지우고 저장한 뒤에야 잘못을
-- 알아채도, 운영자가 할 수 있는 일은 기억을 더듬어 다시 만드는 것뿐이었다.
-- 워드프레스에서 옮겨 오는 사람은 이 기능이 있는 줄 안다(20년 된 기본 기능이다).
--
-- 저장할 때마다 **그때 저장한 내용**을 한 판 남긴다. 되돌리기는 옛 판을 다시
-- 저장하는 것이므로, 되돌린 것 자체도 판으로 남는다 — 되돌리기를 되돌릴 수 있다.
CREATE TABLE IF NOT EXISTS page_revisions (
  id uuid PRIMARY KEY,

  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,

  /**
   * 페이지 안에서의 판 번호 (1부터).
   *
   * 시각이 아니라 번호로 부른다 — 같은 초에 두 번 저장할 수 있고, 운영자에게
   * "세 번째 판" 은 말이 되지만 "2026-09-22 10:31:07 판" 은 말이 되지 않는다.
   */
  rev_no integer NOT NULL,

  title varchar(500) NOT NULL,
  /**
   * 그때의 주소.
   *
   * 되돌릴 때 **쓰지는 않는다**(주소를 되돌리면 그 사이에 걸어 둔 링크·메뉴가
   * 끊기고, 다른 페이지가 그 주소를 가져갔으면 저장 자체가 실패한다).
   * 다만 "이 판에서는 주소가 달랐다" 를 보여줄 수 있어야 한다.
   */
  slug varchar(255) NOT NULL,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  /** 그때의 공개 상태. 되돌릴 때 쓰지 않는다 — 내용을 되돌리는 것이 공개·비공개를 바꿔서는 안 된다 */
  status varchar(20) NOT NULL DEFAULT 'draft',

  /** 누가 저장했나. 탈퇴해도 판은 남는다 */
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  /** 사람이 읽을 한 줄 (되돌리기로 만들어진 판이면 그 사실) */
  note varchar(200) NOT NULL DEFAULT '',

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT page_revisions_no_uniq UNIQUE (page_id, rev_no)
);

-- 편집기 옆의 목록 — 최신 판부터
CREATE INDEX IF NOT EXISTS page_revisions_page_idx ON page_revisions (page_id, rev_no DESC);
