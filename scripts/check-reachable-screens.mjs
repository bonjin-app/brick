#!/usr/bin/env node
/*
 * 서버가 다 만들어 둔 기능에 **손님이 닿을 수 있는가**.
 *
 * 오늘 같은 모양을 세 번 만났다. 서버에는 라우트도 검증도 스모크도 있는데,
 * 그것을 쓰는 화면이 없어서 기능이 통째로 닿지 않는 곳에 있었다:
 *
 *   - 연결된 소셜 계정: 목록·해제 API 가 다 있었다. 화면이 없어서 회원은 자기
 *     계정에 붙은 소셜 로그인을 볼 수도 뗄 수도 없었다 — 훔친 세션으로 심어진
 *     뒷문이라면 더더욱.
 *   - 포인트 사용: 견적도 주문도 pointUsed 를 받고 `pointsAvailable` 이라는
 *     필드까지 "주문서에 UI 를 띄운다" 는 주석과 함께 있었다. 읽는 화면이 없어
 *     회원은 포인트를 쌓기만 하고 한 점도 쓰지 못했다.
 *   - 약관 재동의: 개정·목록·수락 API 가 다 있고 서버는 "동의해야 계속 이용할
 *     수 있다" 고 말하는데, 물어볼 화면이 없었다.
 *   - 2단계 인증: TOTP·복구 코드·도전 토큰·감사 로그에 116개짜리 스모크까지
 *     서버는 전부 갖췄는데 화면이 하나도 없었다. 그런데 관리 설정에는 그것을
 *     **강제하는 체크박스**가 있어서, 켜는 순간 등록할 방법 없이 관리 화면에서
 *     잠겼다 — 되돌리는 것도 관리 작업이라 스스로는 풀 수 없다.
 *   - 사업자정보: 체크섬 검증도 법 조항을 인용한 경고도 테마 렌더도 스모크도
 *     있었고, 문서는 "관리자 → 설정 → 사업자정보에서 입력합니다" 라고 길까지
 *     안내했다 — 그 화면만 없었다. 모든 사이트의 푸터가 빈 채였다.
 *
 * 이 화면들은 클라이언트가 그린다 — 스모크(서버 HTML)로는 볼 수 없다. 그래서
 * **화면이 그 API 를 부르는지**를 여기서 본다. 완벽한 검사는 아니지만, 화면이
 * 통째로 사라지는 것은 잡는다.
 *
 * 보는 범위는 **화면을 그리는 파일**뿐이다 — 아래 SCREEN_FILE 을 보라. 서버
 * 파일까지 훑으면 라우트 문자열에 걸려 화면 없이도 통과한다.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** [무엇을 부르는가, 없으면 무슨 일이 생기는가] */
const MUST_REACH = [
  ["/api/agreements/pending", "약관이 개정돼도 기존 회원에게 묻지 못합니다 (필수 약관은 동의해야 계속 이용할 수 있습니다)"],
  ["/api/agreements/accept", "회원이 개정 약관에 동의할 방법이 없습니다"],
  ["/api/auth/oauth/my/identities", "계정에 붙은 소셜 로그인을 회원이 보거나 뗄 수 없습니다"],
  ["pointUsed", "주문서에서 포인트를 쓸 수 없습니다 (쌓기만 하고 못 씁니다)"],
  ["/api/me/security/reauth", "민감한 작업 앞에서 비밀번호를 다시 물을 방법이 없습니다"],
  ["/api/me/security/2fa/begin", "2단계 인증을 켤 수 있는 화면이 없습니다 — 관리 설정에는 \"관리자에게 요구\" 체크박스가 있어서, 켜면 아무도 등록하지 못한 채 관리 화면에서 잠깁니다"],
  ["/api/auth/login/2fa", "로그인이 2단계로 갈라지는데 코드를 받는 자리가 없습니다 — 2FA 를 켠 사람은 영영 들어오지 못합니다"],
  ["twoFactorRequired", "로그인 화면이 2단계 인증 응답을 알아보지 못합니다 (200 이지만 세션이 없어서, 로그인한 줄 알고 로그아웃 상태로 홈에 떨어집니다)"],
  ["/api/business-info", "사업자정보를 입력할 관리 화면이 없습니다 — 전자상거래법 제13조 표시 의무를 지킬 방법이 없고, 테마 푸터는 빈 채로 남습니다"],
  ["/api/admin/agreements", "운영자가 이용약관·개인정보처리방침을 고칠 수 없습니다 — 기본 문서는 \"반드시 고쳐 쓰세요\" 라고 적힌 초안입니다"],
  ["/api/admin/mail", "운영자가 회원에게 단체메일을 보낼 수 없습니다 — (광고) 표기·동의자 선별·수신거부까지 서버가 다 하는데 보낼 자리가 없습니다"],
  ["/api/admin/migrate/analyze", "그누보드 이전을 화면에서 할 수 없습니다 — 문서는 \"관리자 → 이전\" 이라고 한 절을 통째로 안내합니다"],
  ["/api/plugins/brick-shop/tax/info", "손님이 현금영수증을 신청할 자리가 없습니다 — 부가가치세법 제32조의2 는 최종소비자가 요청하면 발급하라고 정하는데, 요청할 곳이 없으면 그 권리가 없는 것과 같습니다"],
  ["/api/plugins/brick-shop/returns/", "신청한 청약철회를 물릴 수 없습니다 — 잘못 누른 손님은 판매자에게 연락하는 수밖에 없습니다"],
  ["/tickets/by-no/", "비회원이 자기 문의를 볼 수 없습니다 — 조회용 비밀번호까지 받아 놓고 번호와 비밀번호를 넣을 칸이 없습니다"],
  ["/api/plugins/brick-shop/restock-alerts/cancel/", "재입고 알림을 끊을 수 없습니다 — 메일이 보내는 해지 링크가 화면 없이 떨어집니다"],
  ["/api/plugins/brick-shop/wishlist/merge", "비회원으로 담아 둔 위시리스트가 로그인하면 사라진 것처럼 보입니다"],
  ["/api/plugins/brick-shop/payment-methods", "주문서가 결제수단을 서버에 묻지 않습니다 — PG 플러그인을 깔고 키를 넣어도 손님은 무통장입금밖에 고를 수 없고, 게이트웨이 계약도 승인·환불 코드도 닿지 않는 곳에 남습니다"],
  // `window.brickPay` 로 본다 — 복귀 주소를 읽는 `q.get('brickPay')` 만 남아도 걸리게
  ["window\\.brickPay", "주문을 만든 뒤 손님을 결제창으로 넘기지 못합니다 — 카드 주문이 결제대기로 만들어지기만 하고 승인으로 가지 않습니다"],
  ["payable", "결제대기로 남은 카드 주문을 다시 결제할 자리가 없습니다 — 결제창에서 한 번 취소하면 그 주문은 영영 미결제로 남습니다"],
  ["/me/billing-keys", "정기결제용 카드를 등록할 화면이 없습니다 — 카드가 없으면 정기배송에 가입할 수 없고, 서버의 빌링키·구독 라우트 열 개가 전부 닿지 않는 곳에 남습니다"],
  ["registerCard", "PG 의 카드 등록 창을 여는 곳이 없습니다 — 등록 버튼은 있는데 눌러도 아무 일이 일어나지 않습니다"],
  // `billingKeyId` 로 본다 — 어느 카드로 청구할지 고르는 것은 **가입 화면**뿐이다
  // (`productSlug` 는 안 된다: 재입고 목록도 그 이름의 칸을 읽는다 — 화면을 통째로
  //  지워도 초록이었다)
  ["billingKeyId", "정기배송에 **가입할 화면**이 없습니다 — 관리자가 상품에 배송 주기를 설정해도 손님은 그것을 볼 수도 신청할 수도 없고, 서버의 가입 라우트와 애써 만든 카드·해지 화면이 전부 헛것이 됩니다"],
  ["/subscriptions/quote", "정기배송 신청 화면이 청구 금액을 서버에 묻지 않습니다 — 일반 견적으로 보여 주면 등급 할인이 얹힌 금액을 보여 주고 정가를 청구하게 됩니다"],
  ["/me/subscriptions/", "회원이 정기배송을 해지할 수 없습니다 — 문서는 \"해지는 항상 즉시\" 라고 약속하고 서버도 조건 없이 그렇게 만들어져 있는데, 누를 자리가 없으면 지킬 수 없는 약속입니다"],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * **화면을 그리는 파일만** 본다.
 *
 * 플러그인은 서버 라우트와 화면 스크립트가 한 저장소에 있다. 전부 훑으면
 * 서버가 등록한 경로 문자열에 걸려서 **화면을 통째로 지워도 통과한다** —
 * 역검증에서 실제로 그랬다(`pointUsed` 항목이 주문서 UI 를 다 지워도 초록이었다).
 * 화면을 그리는 파일(`*-view.ts` · `views.ts` · `blocks.ts`)만 보면 그 구멍이 닫힌다.
 *
 * 대신 화면을 다른 이름의 파일에서 그리기 시작하면 여기가 먼저 빨개진다.
 * 그때는 이 목록에 그 이름을 더한다 — 조용히 통과하는 것보다 낫다
 * (게시판은 `client-script.ts` 에서 댓글·첨부를 그린다).
 */
const SCREEN_FILE = /(-view|views|blocks|client-script)\.tsx?$/;
const screens = walk(join(ROOT, "apps/web/src"));
for (const p of readdirSync(join(ROOT, "plugins"))) {
  const dir = join(ROOT, "plugins", p, "src");
  try {
    if (!statSync(dir).isDirectory()) continue;
    for (const f of walk(dir)) if (SCREEN_FILE.test(f)) screens.push(f);
  } catch { /* 없으면 건너뛴다 */ }
}
/*
 * **주석은 뺀다.**
 *
 * 이 저장소가 여러 번 겪은 함정이다 — 단언이 찾는 문자열을 주석에 적어 두면
 * 화면을 통째로 지워도 초록이 된다. 실제로 이 항목들을 더하면서 겪었다:
 * `brickPay` 와 `payable` 은 "이 계약을 이렇게 쓴다" 고 적어 둔 주석 때문에
 * 호출부를 다 지워도 통과했다. 부르는 코드만 남기고 본다.
 * (`//` 는 앞이 콜론이 아닐 때만 주석으로 본다 — http:// 를 지우지 않으려고.)
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const haystack = screens.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");

let fail = 0;
console.log("▶ 서버가 만들어 둔 기능에 손님이 닿을 수 있다");
for (const [needle, harm] of MUST_REACH) {
  /*
   * 따옴표까지 붙여 본다. 앞부분만 맞춰 보면 `…/pending-x` 같은 오타도 통과한다
   * (역검증에서 실제로 그랬다).
   */
  const found = needle.startsWith("/")
    ? haystack.includes(`"${needle}"`) || haystack.includes(`'${needle}'`) || haystack.includes(`\`${needle}\``)
    : new RegExp(`\\b${needle}\\b`).test(haystack);
  if (found) console.log(`  ✅ ${needle}`);
  else { console.log(`  ❌ ${needle} — 부르는 화면이 없습니다: ${harm}`); fail++; }
}
console.log(fail
  ? "\n서버에 있다고 쓸 수 있는 것이 아닙니다 — 닿는 길이 있어야 기능입니다."
  : "\n모두 닿습니다.");
process.exit(fail ? 1 : 0);
