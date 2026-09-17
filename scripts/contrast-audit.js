/*
 * 글자 대비 점검 — 브라우저 콘솔에 붙여 실행한다.
 *
 * 라이트·다크 두 벌을 만들면 **눈으로 보기엔 괜찮은데 읽기 힘든** 조합이
 * 생긴다. 흐린 회색 글자를 선 색 위에 올리는 식이다. 실제로 상품 상세의
 * "이미지 없음"과 문의 상태 배지가 그랬다 — 화면을 봐도 티가 안 나는데
 * 측정하면 4.5 를 못 넘긴다.
 *
 * 이 검사는 화면마다 눌러 보는 대신 **여러 경로를 iframe 으로 순회하며**
 * WCAG AA 기준(작은 글자 4.5:1, 큰 글자 3:1)을 넘기는지 본다. 자기 테마를
 * 만들었다면 이걸 돌려 보고 시작하는 것이 CSS 를 눈으로 다시 보는 것보다 빠르다.
 *
 * 사용법:
 *   1. 사이트를 브라우저로 연다 (사이트의 어느 페이지든 상관없다)
 *   2. 개발자도구 콘솔에 이 파일 내용을 붙인다
 *   3. await brickContrastAudit()                     — 기본 경로 순회
 *      await brickContrastAudit(['/', '/board/free']) — 경로 지정
 *
 * 한계: iframe 으로 여는 화면만 본다(로그인이 필요한 화면은 로그인 상태로
 * 열어야 한다). 배경 이미지 위의 글자는 계산하지 않는다 — 이미지 위 글자는
 * 사람이 봐야 한다.
 */
(() => {
  const parse = (c) => {
    if (!c) return null;
    const nums = c.match(/[-\d.]+(?:e[-+]?\d+)?/gi);
    if (!nums) return null;
    let v = nums.map(Number);
    // color(srgb 0.98 0.98 0.98) 형식은 0~1 스케일이다 (color-mix 의 computed 값)
    if (/^color\(/i.test(c)) v = [v[0] * 255, v[1] * 255, v[2] * 255, v[3] === undefined ? 1 : v[3]];
    return v;
  };
  const lum = ([r, g, b]) => {
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  /** 반투명 색을 배경에 합성한다 — alpha 를 무시하면 대비가 실제보다 좋게 나온다 */
  const over = (fg, bg) => {
    const a = fg[3] === undefined ? 1 : fg[3];
    return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const auditDoc = (doc) => {
    const view = doc.defaultView;
    /** 조상을 올라가며 실제 배경색을 합성한다 (반투명 헤더 위 글자까지) */
    const bgOf = (el) => {
      let n = el, acc = null;
      while (n && n !== doc.documentElement) {
        const c = parse(view.getComputedStyle(n).backgroundColor);
        if (c && (c[3] === undefined || c[3] > 0)) {
          acc = acc ? over(acc, c) : c;
          if ((c[3] === undefined ? 1 : c[3]) >= 0.999) return acc.slice(0, 3);
        }
        n = n.parentElement;
      }
      const root = parse(view.getComputedStyle(doc.documentElement).backgroundColor) || [255, 255, 255, 1];
      return acc ? over(acc, root).slice(0, 3) : root.slice(0, 3);
    };

    /**
     * 그림 위의 글자는 **재지 않는다.**
     *
     * 이 도구는 배경 **색**만 합성한다. 사진이나 그라디언트가 깔려 있으면 그 밑의
     * 색을 재게 되고, 결과는 실제와 아무 상관이 없다 — 기본 홈의 히어로가 그랬다:
     * 어두운 그라디언트 위의 흰 글자를 "1.1" 로 보고했다(실제로는 잘 읽힌다).
     * 틀린 숫자는 없는 것보다 나쁘다. 읽는 사람이 나머지 보고까지 믿지 않게 된다.
     *
     * 대신 **몇 개를 건너뛰었는지 세어** 돌려준다 — 조용히 빠지면 그것도 거짓말이다.
     */
    const overImage = (el) => {
      let n = el;
      while (n && n !== doc.documentElement) {
        const cs = view.getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
        const c = parse(cs.backgroundColor);
        if (c && (c[3] === undefined ? 1 : c[3]) >= 0.999) return false;
        n = n.parentElement;
      }
      return false;
    };

    const out = [], seen = new Set();
    let skipped = 0;
    for (const el of doc.querySelectorAll("body *")) {
      // 자기 텍스트 노드를 가진 요소만 — 부모까지 세면 같은 글자를 여러 번 센다
      const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
      if (!txt) continue;
      const s = view.getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.3) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const fg = parse(s.color);
      if (!fg) continue;
      if (overImage(el)) { skipped++; continue; }
      const bg = bgOf(el);
      const r = ratio(over(fg, bg), bg);
      const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (r < need) {
        const key = el.className + "|" + txt.slice(0, 18);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ 위치: String(el.className).slice(0, 34) || el.tagName, 글자: txt.slice(0, 24), 대비: +r.toFixed(2), 필요: need });
      }
    }
    out.skipped = skipped;
    return out;
  };

  const DEFAULT_PATHS = ["/", "/about", "/search?q=a", "/no-such-page"];

  /*
   * 화면 모드는 **불러오기 전에** 정한다.
   *
   * 예전에는 iframe 을 띄운 뒤 `documentElement.dataset.theme` 를 바꿨다.
   * 그러면 배경색은 새 테마로 바뀌는데 **글자색은 이전 테마 값에 머문다** —
   * 변수(--color-text-soft)는 분명히 바뀌었는데 var() 로 물린 color 가 다시
   * 계산되지 않는다(크로미움에서 재현했다: 변수 #4a4f59, 배경 #101216,
   * 그런데 글자색은 rgb(74,79,89) 그대로). 밝은 글자가 밝은 배경 위에 있는
   * 것처럼 읽혀 **헤더·내비게이션 전체가 1.1~1.9 로 보고됐다** — 한 번에
   * 59건. 틀린 숫자는 없는 것보다 나쁘다: 진짜 두어 건이 그 밑에 묻힌다.
   *
   * 사이트는 첫 페인트 전에 localStorage("brick-theme")를 읽어 테마를 정한다
   * (레이아웃의 THEME_BOOT). iframe 은 같은 출처이므로 **불러오기 전에** 그
   * 값을 넣어 두면 페이지가 처음부터 그 테마로 그려진다. 끝나면 되돌린다.
   */
  const THEME_KEY = "brick-theme";

  window.brickContrastAudit = async (paths = DEFAULT_PATHS, themes = ["light", "dark"]) => {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:-9999px;top:0;width:1280px;height:900px";
    document.body.appendChild(frame);
    const problems = {};
    let skippedTotal = 0;
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 저장소가 막혀 있으면 아래에서 걸린다 */ }
    try {
      for (const theme of themes) {
        try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 아래 확인에서 걸린다 */ }
        for (const path of paths) {
          await new Promise((res) => { frame.onload = res; frame.src = path; });
          const doc = frame.contentDocument;
          /*
           * 정말 그 테마로 그려졌는지 확인한다. 조용히 다른 테마를 재면
           * 보고서 전체가 거짓이 된다 — 그것이 이 도구가 한 번 저지른 일이다.
           */
          if (doc.documentElement.dataset.theme !== theme) {
            problems[`${theme} ${path}`] = [{ 위치: "(검사 도구)", 글자: `화면 모드가 ${theme} 로 적용되지 않았습니다`, 대비: 0, 필요: 0 }];
            continue;
          }
          // 블록의 인라인 스크립트가 목록을 채울 시간을 준다
          await new Promise((r) => setTimeout(r, 300));
          const v = auditDoc(doc);
          skippedTotal += v.skipped ?? 0;
          if (v.length) problems[`${theme} ${path}`] = v;
        }
      }
    } finally {
      try {
        if (saved === null) localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, saved);
      } catch (e) { /* 되돌리지 못해도 측정은 끝났다 */ }
      frame.remove();
    }
    const count = Object.values(problems).reduce((n, v) => n + v.length, 0);
    console.log(
      `${paths.length * themes.length}개 화면 검사 — 위반 ${count}건` +
        (skippedTotal ? ` (그림 위 글자 ${skippedTotal}개는 재지 못해 건너뜀)` : ""),
    );
    for (const [where, list] of Object.entries(problems)) {
      console.group(where);
      console.table(list);
      console.groupEnd();
    }
    return { checked: paths.length * themes.length, count, problems, skipped: skippedTotal };
  };

  console.log("brickContrastAudit() 준비됨 — 예: await brickContrastAudit(['/', '/board/free'])");
})();
