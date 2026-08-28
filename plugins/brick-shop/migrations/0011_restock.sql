-- 재입고 알림
--
-- 품절 상품을 찾아온 손님에게 지금은 할 수 있는 것이 없다. 그 손님은
-- 다시 오지 않고, **팔 수 있었던 것을 못 판다.**
--
-- ── 스팸 도구가 되지 않게 ────────────────────────────
--
-- 이메일만 받아 알림을 보내는 기능은 **남의 주소로 메일을 보내는 도구**가 될
-- 수 있다. 그래서:
--
--   - 같은 (상품, 옵션, 주소) 조합에 신청은 하나뿐이다
--   - 알림은 재입고 시 **한 번만** 가고 그 자리에서 소진된다
--   - 발송은 운영자의 재입고 행위가 방아쇠다 (신청자가 시점을 못 정한다)
--   - 메일에 "신청하지 않았다면" 안내와 해지 링크를 넣는다
--
-- 공격자가 얻을 수 있는 것은 "타인에게 재입고 메일 1통"이고, 그 시점조차
-- 통제할 수 없다. 이메일 확인 절차를 요구하면 실제 손님의 신청률이 크게
-- 떨어지므로, 이 정도가 맞는 균형이다.
--
-- ── 광고가 아니다 ────────────────────────────────────
--
-- 재입고 알림은 **손님이 요청한 정보**이므로 정보통신망법 제50조의 광고성
-- 정보가 아니다(수신 동의 불필요). 단, 그 메일에 다른 상품을 끼워 넣으면
-- 광고가 된다. 그래서 본문은 **신청한 상품 정보만** 담는다 — 운영자가
-- 문구를 넣을 자리를 두지 않는다.

CREATE TABLE IF NOT EXISTS shop_restock_alerts (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  /**
   * 옵션별 신청.
   *
   * 옵션이 있는 상품은 **옵션 단위로 품절된다** — "M 사이즈만 품절"인 경우가
   * 대부분이다. 상품 단위로만 받으면 L 이 들어왔을 때 M 을 기다린 손님에게
   * 잘못된 알림이 간다.
   */
  option_id uuid REFERENCES shop_product_options(id) ON DELETE CASCADE,

  /** 회원이면 id. 비회원은 NULL */
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,

  /**
   * 알림 받을 주소.
   *
   * 회원도 저장한다 — 회원이 가입 이메일과 다른 주소로 받고 싶을 수 있고,
   * 발송 시점에 users 를 조인하면 탈퇴한 회원에게 보내려 시도한다.
   */
  email varchar(255) NOT NULL,

  /** 해지 링크에 쓰는 토큰 — 로그인 없이 취소할 수 있어야 한다 */
  token varchar(64) NOT NULL UNIQUE,

  /**
   * pending  — 재입고 대기
   * notified — 알림 발송됨 (소진)
   * cancelled — 손님이 해지
   */
  status varchar(16) NOT NULL DEFAULT 'pending',

  ip_hash varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  cancelled_at timestamptz
);

CREATE INDEX IF NOT EXISTS shop_restock_pending_idx
  ON shop_restock_alerts (product_id, option_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS shop_restock_email_idx ON shop_restock_alerts (email);

-- 같은 조합에 중복 신청을 막는다.
--
-- 소진된 것은 다시 신청할 수 있어야 한다(또 품절될 수 있다). 그래서
-- pending 인 것만 막는 부분 유니크 인덱스다.
--
-- option_id 가 NULL 이면 유니크 인덱스가 중복을 못 막으므로(NULL 은 서로
-- 다르게 취급된다) coalesce 로 고정값을 넣는다 — 이 함정을 모르면 옵션 없는
-- 상품에는 무한히 신청할 수 있다.
CREATE UNIQUE INDEX IF NOT EXISTS shop_restock_once_idx
  ON shop_restock_alerts (
    product_id,
    coalesce(option_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(email)
  )
  WHERE status = 'pending';
