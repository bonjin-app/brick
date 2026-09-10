/*
 * 화면 기본기 점검 — 브라우저 콘솔에 붙여 실행한다 (contrast-audit.js 의 짝).
 *
 * 대비 측정이 "읽히는가"를 보듯, 이 검사는 "쓸 수 있는가"를 본다. 여러 경로를
 * iframe 으로 순회하며 375px(모바일)·1280px(데스크톱) 두 폭에서 다음을 잡는다:
 *   - 가로 넘침 (화면보다 넓은 문서 · 넘치는 첫 요소)
 *   - alt 없는 <img>
 *   - 이름 없는 버튼·링크 (텍스트도 aria-label 도 없음 — 스크린리더에 "버튼"으로만 읽힌다)
 *   - 라벨 없는 입력·select·textarea
 *   - 28px 미만 터치 영역 (모바일만; 본문 문단·표 안·푸터는 제외)
 *   - "undefined" · "NaN" · "[object Object]" 가 화면에 찍힌 곳
 *   - 가로 스크롤 상자에 숨은 조작 요소 (모바일만 — 보이지 않는 버튼은 없는 버튼이다)
 *
 * 사용법:
 *   1. 사이트를 브라우저로 연다 (관리 화면을 보려면 로그인한 상태로)
 *   2. 개발자도구 콘솔에 이 파일 내용을 붙인다
 *   3. await brickUiAudit()                          — 기본 경로
 *      await brickUiAudit(['/', '/board/free'], [375]) — 경로·폭 지정
 *
 * 한계: iframe 으로 여는 화면만 본다. 클라이언트가 그리는 관리 화면은 로드 뒤 1.4초를 기다린다 —
 * 느린 환경이면 wait 를 늘릴 것. 색 대비는 보지 않는다(contrast-audit.js).
 * 로그인·장바구니처럼 **상태가 있어야 보이는 화면**은 그 상태를 만들어 두고 돌려야 한다
 * (관리 화면은 관리자로 로그인, 주문서는 장바구니에 담은 뒤).
 */
(() => {
  const audit = (doc, w) => {
    const v = doc.defaultView;
    const issues = [];
    if (doc.documentElement.scrollWidth > w + 1) {
      issues.push(`가로 넘침 ${doc.documentElement.scrollWidth}px`);
      for (const el of doc.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 2 && v.getComputedStyle(el).position !== "fixed") {
          issues.push(`넘치는 요소 ${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} right=${Math.round(r.right)}`);
          break;
        }
      }
    }
    doc.querySelectorAll("img:not([alt])").forEach((i) => issues.push(`alt 없는 img ${(i.getAttribute("src") || "").slice(0, 40)}`));
    doc.querySelectorAll("button, a").forEach((b) => {
      const name = (b.getAttribute("aria-label") || b.textContent || "").trim();
      if (!name && !b.querySelector("img[alt]") && b.getBoundingClientRect().width > 0) {
        issues.push(`이름 없는 ${b.tagName.toLowerCase()} ${String(b.className).slice(0, 30)}`);
      }
    });
    doc.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea").forEach((i) => {
      const labelled = (i.id && doc.querySelector(`label[for="${i.id}"]`)) || i.closest("label") || i.getAttribute("aria-label")
        || i.getAttribute("aria-labelledby") || i.getAttribute("placeholder") || i.getAttribute("title");
      if (!labelled && i.getBoundingClientRect().width > 0) issues.push(`라벨 없는 ${i.tagName.toLowerCase()} name=${i.name || i.className || i.type}`);
    });
    if (w < 500) {
      doc.querySelectorAll("a, button").forEach((b) => {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.height < 28 || r.width < 28) && !b.closest("p, td, .brick-footer, .brick-business")) {
          issues.push(`작은 터치 ${b.tagName.toLowerCase()} "${(b.textContent || b.getAttribute("aria-label") || "").trim().slice(0, 12)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      });
    }
    /*
     * 가로 스크롤 상자 안에 숨은 내용 (모바일만).
     *
     * 문서 넘침 검사로는 잡히지 않는다 — `overflow-x: auto` 가 넘침을 상자 안에
     * 가두므로 문서는 멀쩡해 보인다. 그런데 손님·운영자에게는 **내용이 사라진 것**
     * 이다. 관리자의 주문 목록이 그랬다: 폰에서는 주문번호만 보이고 상태·금액·수정
     * 버튼은 오른쪽으로 밀려 있었다. 주문 하나를 확인하려고 좌우로 밀어야 했고,
     * 그것이 작은 쇼핑몰 운영자가 가장 자주 하는 일이다.
     *
     * 스크롤이 **필요한 것 자체**가 문제는 아니다(넓은 표를 미는 것은 흔한 해법이다).
     * 문제는 그 안에 **조작 요소**가 숨을 때다 — 보이지 않는 버튼은 없는 버튼이다.
     */
    if (w <= 480) {
      for (const box of doc.querySelectorAll("*")) {
        const st = v.getComputedStyle(box);
        if (!/auto|scroll/.test(st.overflowX)) continue;
        if (box.scrollWidth <= box.clientWidth + 2) continue;
        const edge = box.getBoundingClientRect().right;
        const hidden = [...box.querySelectorAll("a[href], button, input, select, textarea")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.left > edge - 2;
          });
        if (hidden.length) {
          issues.push(
            `가로 스크롤에 숨은 조작 요소 ${hidden.length}개 (${box.tagName.toLowerCase()}.${
              String(box.className || "").split(" ")[0] || "-"
            }: ${box.scrollWidth}px > ${box.clientWidth}px) 예: "${
              (hidden[0].textContent || hidden[0].getAttribute("aria-label") || hidden[0].name || "").trim().slice(0, 14)
            }"`,
          );
        }
      }
    }
    if (/undefined|NaN|\[object Object\]/.test(doc.body.innerText || "")) issues.push("undefined/NaN 문자열 노출");
    return [...new Set(issues)].slice(0, 12);
  };

  /*
   * 기본 경로.
   *
   * 다섯 개(홈·검색·로그인·가입·404)뿐이었다. 그 사이 화면은 손님 쪽 열몇 개와
   * 관리자 쪽 열몇 개로 늘었고, **가장 자주 쓰는 화면이 목록에 없었다** — 폰에서
   * 관리 주문 목록의 수정 버튼이 가로 스크롤 뒤에 숨어 있던 것을 이 도구가 놓친
   * 이유의 절반이 그것이다(나머지 절반은 검사 자체가 없었던 것).
   *
   * 없는 화면은 404 로 그려지고 검사는 그냥 통과한다 — 플러그인을 켜지 않은
   * 사이트에서도 이 목록을 그대로 쓸 수 있다.
   */
  const DEFAULT_PATHS = [
    // 손님
    "/", "/search?q=a", "/login", "/register", "/forgot-password", "/no-such-page",
    "/account", "/board/notice", "/board/free",
    "/shop", "/shop/cart", "/shop/orders", "/shop/coupons", "/shop/wishlist",
    "/memo", "/points", "/scraps",
    // 운영자 — 로그인한 상태로 열어야 내용이 보인다
    "/admin", "/admin/pages", "/admin/media", "/admin/menus", "/admin/users",
    "/admin/settings", "/admin/themes", "/admin/plugins", "/admin/audit",
    "/admin/x/brick-shop/orders", "/admin/x/brick-shop/products", "/admin/x/brick-shop/settings",
    "/admin/x/brick-board/posts",
  ];

  window.brickUiAudit = async (paths = DEFAULT_PATHS, widths = [375, 1280], wait = 1400) => {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:-9999px;top:0;height:900px;border:0";
    document.body.appendChild(frame);
    const problems = {};
    try {
      for (const w of widths) {
        frame.style.width = w + "px";
        for (const path of paths) {
          await new Promise((res) => { frame.onload = res; frame.src = path; });
          await new Promise((r) => setTimeout(r, wait));
          const v = audit(frame.contentDocument, w);
          if (v.length) problems[`${w} ${path}`] = v;
        }
      }
    } finally {
      frame.remove();
    }
    const count = Object.values(problems).reduce((n, v) => n + v.length, 0);
    console.log(`${paths.length * widths.length}개 화면 검사 — 발견 ${count}건`);
    for (const [where, list] of Object.entries(problems)) { console.group(where); list.forEach((l) => console.log(l)); console.groupEnd(); }
    return { checked: paths.length * widths.length, count, problems };
  };

  console.log("brickUiAudit() 준비됨 — 예: await brickUiAudit(['/', '/board/free'])");
})();
