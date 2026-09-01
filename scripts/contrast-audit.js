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

    const out = [], seen = new Set();
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
    return out;
  };

  const DEFAULT_PATHS = ["/", "/about", "/search?q=a", "/no-such-page"];

  window.brickContrastAudit = async (paths = DEFAULT_PATHS, themes = ["light", "dark"]) => {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;left:-9999px;top:0;width:1280px;height:900px";
    document.body.appendChild(frame);
    const problems = {};
    try {
      for (const theme of themes) {
        for (const path of paths) {
          await new Promise((res) => { frame.onload = res; frame.src = path; });
          const doc = frame.contentDocument;
          doc.documentElement.dataset.theme = theme;
          // 블록의 인라인 스크립트가 목록을 채울 시간을 준다
          await new Promise((r) => setTimeout(r, 300));
          const v = auditDoc(doc);
          if (v.length) problems[`${theme} ${path}`] = v;
        }
      }
    } finally {
      frame.remove();
    }
    const count = Object.values(problems).reduce((n, v) => n + v.length, 0);
    console.log(`${paths.length * themes.length}개 화면 검사 — 위반 ${count}건`);
    for (const [where, list] of Object.entries(problems)) {
      console.group(where);
      console.table(list);
      console.groupEnd();
    }
    return { checked: paths.length * themes.length, count, problems };
  };

  console.log("brickContrastAudit() 준비됨 — 예: await brickContrastAudit(['/', '/board/free'])");
})();
