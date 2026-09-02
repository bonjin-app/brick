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
 *
 * 사용법:
 *   1. 사이트를 브라우저로 연다 (관리 화면을 보려면 로그인한 상태로)
 *   2. 개발자도구 콘솔에 이 파일 내용을 붙인다
 *   3. await brickUiAudit()                          — 기본 경로
 *      await brickUiAudit(['/', '/board/free'], [375]) — 경로·폭 지정
 *
 * 한계: iframe 으로 여는 화면만 본다. 클라이언트가 그리는 관리 화면은 로드 뒤 1.4초를 기다린다 —
 * 느린 환경이면 wait 를 늘릴 것. 색 대비는 보지 않는다(contrast-audit.js).
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
    if (/undefined|NaN|\[object Object\]/.test(doc.body.innerText || "")) issues.push("undefined/NaN 문자열 노출");
    return [...new Set(issues)].slice(0, 12);
  };

  const DEFAULT_PATHS = ["/", "/search?q=a", "/login", "/register", "/no-such-page"];

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
