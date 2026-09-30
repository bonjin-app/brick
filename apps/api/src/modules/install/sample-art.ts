/**
 * 스타터 샘플 그림 — 쇼핑몰을 고르고 설치했을 때 **첫 화면이 완성된 가게처럼** 보이게.
 *
 * 전에는 상품마다 두 색 그라데이션 사각형이었다. 격자가 "색 견본" 처럼 보여서 테마가 어떤지 판단할 수 없었고,
 * 카페24·메이크샵의 디자인 템플릿이 데모 사진부터 갖춰 두는 이유가 거기 있다. 사진은 저작권이 걸려 동봉할 수
 * 없으므로 평면 일러스트로 그린다 — 배경·바닥 그림자·물건 두세 톤. 글자는 넣지 않는다(서버의 글꼴에 따라
 * 깨지고, 배너 문구는 운영자가 HTML 로 고친다).
 *
 * 설치 때 한 번 JPEG 으로 구워 미디어에 들어간다(install.controller.ts 의 addSampleImage) — 여기 있는 것은 원본이다.
 */

const S = 1000;

/** 배경 + 바닥 그림자 — 모든 상품 사진의 공통 무대 */
function stage(bg: [string, string], body: string, shadow = { cx: 500, cy: 800, rx: 250, ry: 34 }): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">` +
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient>` +
    `<radialGradient id="sh" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".22"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="lit" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient>` +
    `</defs>` +
    `<rect width="${S}" height="${S}" fill="url(#bg)"/>` +
    // 뒤 벽과 바닥의 경계 — 사진처럼 공간감이 생긴다
    `<rect y="690" width="${S}" height="310" fill="#000" opacity=".035"/>` +
    `<ellipse cx="${shadow.cx}" cy="${shadow.cy}" rx="${shadow.rx}" ry="${shadow.ry}" fill="url(#sh)"/>` +
    body +
    `</svg>`
  );
}

export const PRODUCT_ART: Record<string, () => string> = {
  /** 무광 머그컵 */
  mug: () =>
    stage(["#f4efe7", "#e6ddd0"],
      `<path d="M640 430c90 0 120 60 120 115s-40 115-130 115" fill="none" stroke="#c7a489" stroke-width="42" stroke-linecap="round"/>` +
      `<path d="M300 360h360v330c0 60-50 110-110 110H410c-60 0-110-50-110-110z" fill="#d9b99b"/>` +
      `<path d="M300 360h360v330c0 60-50 110-110 110H410c-60 0-110-50-110-110z" fill="url(#lit)"/>` +
      `<ellipse cx="480" cy="360" rx="180" ry="38" fill="#c9a687"/>` +
      `<ellipse cx="480" cy="364" rx="156" ry="28" fill="#5b3d2b"/>` +
      `<path d="M430 300c-20-40 20-60 0-100M500 300c-20-40 20-60 0-100" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".7"/>`,
      { cx: 500, cy: 805, rx: 260, ry: 34 }),

  /** 세라믹 접시 세트 */
  plate: () =>
    stage(["#eef2f1", "#dde5e3"],
      `<ellipse cx="500" cy="700" rx="330" ry="78" fill="#b9c9c6"/>` +
      `<ellipse cx="500" cy="680" rx="330" ry="78" fill="#f7f8f6"/>` +
      `<ellipse cx="500" cy="680" rx="250" ry="56" fill="#e9eeec"/>` +
      `<ellipse cx="500" cy="610" rx="290" ry="68" fill="#a9bdb9"/>` +
      `<ellipse cx="500" cy="592" rx="290" ry="68" fill="#fbfbf9"/>` +
      `<ellipse cx="500" cy="592" rx="214" ry="48" fill="#edf1ef"/>` +
      `<path d="M300 520c0 60 90 110 200 110s200-50 200-110" fill="#6f928c"/>` +
      `<ellipse cx="500" cy="520" rx="200" ry="52" fill="#86a6a0"/>` +
      `<ellipse cx="500" cy="520" rx="176" ry="42" fill="#f4f6f4"/>` +
      `<path d="M330 540c40 40 300 40 340 0" fill="none" stroke="#fff" stroke-width="8" opacity=".5"/>`,
      { cx: 500, cy: 770, rx: 360, ry: 40 }),

  /** 원목 커팅보드 */
  board: () =>
    stage(["#f5efe6", "#e9dfcf"],
      `<g transform="rotate(-8 500 520)">` +
      `<rect x="300" y="250" width="380" height="520" rx="60" fill="#b98556"/>` +
      `<rect x="300" y="250" width="380" height="520" rx="60" fill="url(#lit)"/>` +
      `<rect x="455" y="170" width="70" height="120" rx="35" fill="#b98556"/>` +
      `<circle cx="490" cy="215" r="18" fill="#e9dfcf"/>` +
      `<path d="M350 330c80 30 200-20 280 10M340 450c90 25 210-15 300 5M350 580c80 30 200-20 280 10M360 690c70 20 180-10 260 0" fill="none" stroke="#9c6b40" stroke-width="6" stroke-linecap="round" opacity=".55"/>` +
      `</g>` +
      `<ellipse cx="660" cy="720" rx="60" ry="28" fill="#e04e39"/><ellipse cx="660" cy="712" rx="60" ry="28" fill="#f06a52"/>`,
      { cx: 500, cy: 800, rx: 280, ry: 34 }),

  /** 캔버스 토트백 */
  tote: () =>
    stage(["#eceff3", "#dce2e9"],
      `<path d="M400 360c0-110 40-150 100-150s100 40 100 150" fill="none" stroke="#6b5846" stroke-width="22" stroke-linecap="round"/>` +
      `<path d="M300 360h400l40 440H260z" fill="#e4d8c3"/>` +
      `<path d="M300 360h400l40 440H260z" fill="url(#lit)"/>` +
      `<path d="M300 360h400l6 60H294z" fill="#d6c7ad"/>` +
      `<rect x="400" y="520" width="200" height="150" rx="10" fill="#27415e"/>` +
      `<path d="M430 560h140M430 600h100" stroke="#e4d8c3" stroke-width="10" stroke-linecap="round" opacity=".8"/>` +
      `<path d="M292 420h416M284 480h432" stroke="#c9b894" stroke-width="3" stroke-dasharray="10 10" opacity=".7"/>`,
      { cx: 500, cy: 815, rx: 300, ry: 36 }),

  /** 린넨 쿠션 커버 */
  cushion: () =>
    stage(["#f3eee8", "#e7ddd3"],
      `<path d="M260 320q-20-70 50-60 190 30 380 0 70-10 50 60-30 190 0 380 20 70-50 60-190-30-380 0-70 10-50-60 30-190 0-380z" fill="#9aa88d"/>` +
      `<path d="M260 320q-20-70 50-60 190 30 380 0 70-10 50 60-30 190 0 380 20 70-50 60-190-30-380 0-70 10-50-60 30-190 0-380z" fill="url(#lit)"/>` +
      `<path d="M300 320q200 28 400 0M300 700q200-28 400 0" fill="none" stroke="#7f8e72" stroke-width="5" opacity=".7"/>` +
      `<path d="M330 380q170 40 340 0M330 450q170 40 340 0M330 520q170 40 340 0M330 590q170 40 340 0" fill="none" stroke="#b3bfa7" stroke-width="4" opacity=".6"/>` +
      `<circle cx="500" cy="510" r="22" fill="#7f8e72"/>`,
      { cx: 500, cy: 800, rx: 290, ry: 34 }),

  /** 세라믹 화병 + 마른 가지 */
  vase: () =>
    stage(["#f1ede6", "#e2d9cc"],
      `<path d="M500 520C470 380 430 260 380 170M500 520c20-150 70-260 140-330M500 520c-10-120-10-220 20-300" fill="none" stroke="#8a6f52" stroke-width="7" stroke-linecap="round"/>` +
      `<g fill="#c9a26e">` +
      [[380, 170], [405, 215], [430, 260], [640, 190], [610, 230], [580, 275], [520, 220], [512, 270]]
        .map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="22" ry="11" transform="rotate(-35 ${x} ${y})"/>`).join("") +
      `</g>` +
      `<path d="M440 470c0-40 20-60 60-60s60 20 60 60c0 40 120 90 120 200 0 90-70 130-180 130s-180-40-180-130c0-110 120-160 120-200z" fill="#e7e1d6"/>` +
      `<path d="M440 470c0-40 20-60 60-60s60 20 60 60c0 40 120 90 120 200 0 90-70 130-180 130s-180-40-180-130c0-110 120-160 120-200z" fill="url(#lit)"/>` +
      `<ellipse cx="500" cy="414" rx="58" ry="14" fill="#cfc6b6"/>` +
      `<path d="M345 640c90 30 220 30 310 0" fill="none" stroke="#c7b8a1" stroke-width="10" opacity=".7"/>`,
      { cx: 500, cy: 805, rx: 230, ry: 32 }),

  /** 소이 향초 */
  candle: () =>
    stage(["#efe6e3", "#ded0cb"],
      `<rect x="330" y="380" width="340" height="410" rx="36" fill="#8d6a64" opacity=".92"/>` +
      `<rect x="330" y="380" width="340" height="410" rx="36" fill="url(#lit)"/>` +
      `<ellipse cx="500" cy="384" rx="170" ry="36" fill="#a88a83"/>` +
      `<ellipse cx="500" cy="392" rx="148" ry="26" fill="#f4ece2"/>` +
      `<rect x="380" y="520" width="240" height="150" rx="8" fill="#f4ece2"/>` +
      `<rect x="420" y="560" width="160" height="10" rx="5" fill="#8d6a64" opacity=".6"/>` +
      `<rect x="445" y="595" width="110" height="8" rx="4" fill="#8d6a64" opacity=".4"/>` +
      `<path d="M500 390v-40" stroke="#3b2b27" stroke-width="6" stroke-linecap="round"/>` +
      `<path d="M500 250c30 40 36 70 0 100-36-30-30-60 0-100z" fill="#ffb347"/>` +
      `<path d="M500 290c14 20 16 36 0 52-16-16-14-32 0-52z" fill="#fff2c6"/>`,
      { cx: 500, cy: 800, rx: 230, ry: 30 }),

  /** 리드 디퓨저 */
  diffuser: () =>
    stage(["#e9ece9", "#d7ddd8"],
      [-28, -16, -6, 6, 16, 30]
        .map((a) => `<path d="M500 540L${500 + Math.sin((a * Math.PI) / 180) * 420} ${540 - Math.cos((a * Math.PI) / 180) * 420}" stroke="#7a6547" stroke-width="7" stroke-linecap="round"/>`).join("") +
      `<path d="M440 500h120v40c70 20 110 70 110 140v40c0 50-40 80-100 80H430c-60 0-100-30-100-80v-40c0-70 40-120 110-140z" fill="#56766a" opacity=".92"/>` +
      `<path d="M440 500h120v40c70 20 110 70 110 140v40c0 50-40 80-100 80H430c-60 0-100-30-100-80v-40c0-70 40-120 110-140z" fill="url(#lit)"/>` +
      `<rect x="440" y="470" width="120" height="44" rx="10" fill="#2f3f3a"/>` +
      `<rect x="390" y="640" width="220" height="90" rx="10" fill="#eef1ee"/>` +
      `<rect x="430" y="672" width="140" height="9" rx="4" fill="#56766a" opacity=".7"/>` +
      `<rect x="455" y="698" width="90" height="7" rx="3" fill="#56766a" opacity=".45"/>`,
      { cx: 500, cy: 810, rx: 230, ry: 30 }),
};

/**
 * 배너(1920×720). 왼쪽 아래에 문구가 얹힌다(슬라이드 캡션) — 물건은 오른쪽 절반에 모은다.
 */
function banner(bg: [string, string], body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="720" viewBox="0 0 1920 720">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient>` +
    `<radialGradient id="sh" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#000" stop-opacity=".2"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="lit" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".25"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient></defs>` +
    `<rect width="1920" height="720" fill="url(#bg)"/>` +
    `<rect y="560" width="1920" height="160" fill="#000" opacity=".04"/>` +
    body +
    `</svg>`
  );
}

export const BANNER_ART: Record<string, () => string> = {
  /** 가을 리빙 — 화병과 쿠션 */
  living: () =>
    banner(["#efe6da", "#dccab4"],
      `<circle cx="1480" cy="250" r="230" fill="#e9b872" opacity=".35"/>` +
      `<ellipse cx="1330" cy="610" rx="330" ry="36" fill="url(#sh)"/>` +
      `<path d="M1080 360q-14-50 36-44 140 22 280 0 50-6 36 44-22 140 0 280 14 50-36 44-140-22-280 0-50 6-36-44 22-140 0-280z" fill="#b5705a"/>` +
      `<path d="M1080 360q-14-50 36-44 140 22 280 0 50-6 36 44-22 140 0 280 14 50-36 44-140-22-280 0-50 6-36-44 22-140 0-280z" fill="url(#lit)"/>` +
      `<circle cx="1256" cy="496" r="16" fill="#8f5443"/>` +
      `<path d="M1560 420c-20-110-60-200-110-260M1560 420c16-120 60-210 120-270M1560 420c-8-100-4-180 20-240" fill="none" stroke="#8a6f52" stroke-width="6" stroke-linecap="round"/>` +
      `<path d="M1520 380c0-30 16-46 40-46s40 16 40 46c0 30 90 70 90 150 0 70-56 100-130 100s-130-30-130-100c0-80 90-120 90-150z" fill="#f3efe7"/>` +
      `<path d="M1520 380c0-30 16-46 40-46s40 16 40 46c0 30 90 70 90 150 0 70-56 100-130 100s-130-30-130-100c0-80 90-120 90-150z" fill="url(#lit)"/>`),

  /** 주방 — 접시와 머그 */
  kitchen: () =>
    banner(["#e7eeec", "#cddbd7"],
      `<circle cx="1500" cy="300" r="250" fill="#fff" opacity=".35"/>` +
      `<ellipse cx="1400" cy="615" rx="380" ry="38" fill="url(#sh)"/>` +
      `<ellipse cx="1300" cy="580" rx="260" ry="60" fill="#a9bdb9"/><ellipse cx="1300" cy="565" rx="260" ry="60" fill="#fbfbf9"/><ellipse cx="1300" cy="565" rx="190" ry="42" fill="#edf1ef"/>` +
      `<ellipse cx="1300" cy="505" rx="220" ry="52" fill="#a9bdb9"/><ellipse cx="1300" cy="492" rx="220" ry="52" fill="#fbfbf9"/><ellipse cx="1300" cy="492" rx="160" ry="36" fill="#edf1ef"/>` +
      `<path d="M1700 360c60 0 80 40 80 76s-26 76-86 76" fill="none" stroke="#c7a489" stroke-width="28" stroke-linecap="round"/>` +
      `<path d="M1500 310h230v210c0 40-32 72-72 72h-86c-40 0-72-32-72-72z" fill="#d9b99b"/>` +
      `<path d="M1500 310h230v210c0 40-32 72-72 72h-86c-40 0-72-32-72-72z" fill="url(#lit)"/>` +
      `<ellipse cx="1615" cy="310" rx="115" ry="24" fill="#c9a687"/><ellipse cx="1615" cy="313" rx="98" ry="17" fill="#5b3d2b"/>`),

  /** 향 — 향초와 디퓨저, 해질녘 톤 */
  scent: () =>
    banner(["#4a3b3a", "#2c2426"],
      `<circle cx="1440" cy="260" r="260" fill="#ffb347" opacity=".12"/>` +
      `<ellipse cx="1420" cy="620" rx="360" ry="36" fill="url(#sh)"/>` +
      `<rect x="1180" y="360" width="250" height="260" rx="26" fill="#a88a83"/>` +
      `<rect x="1180" y="360" width="250" height="260" rx="26" fill="url(#lit)"/>` +
      `<ellipse cx="1305" cy="364" rx="125" ry="26" fill="#c2a69f"/><ellipse cx="1305" cy="370" rx="108" ry="18" fill="#f4ece2"/>` +
      `<path d="M1305 368v-30" stroke="#2c2426" stroke-width="5" stroke-linecap="round"/>` +
      `<path d="M1305 262c24 32 28 56 0 80-28-24-24-48 0-80z" fill="#ffb347"/><path d="M1305 294c11 16 12 28 0 40-12-12-11-24 0-40z" fill="#fff2c6"/>` +
      [-24, -10, 4, 18].map((a) => `<path d="M1620 440L${1620 + Math.sin((a * Math.PI) / 180) * 320} ${440 - Math.cos((a * Math.PI) / 180) * 320}" stroke="#b39a78" stroke-width="5" stroke-linecap="round"/>`).join("") +
      `<path d="M1575 410h90v30c54 16 84 54 84 106v30c0 38-30 60-76 60h-106c-46 0-76-22-76-60v-30c0-52 30-90 84-106z" fill="#56766a"/>` +
      `<path d="M1575 410h90v30c54 16 84 54 84 106v30c0 38-30 60-76 60h-106c-46 0-76-22-76-60v-30c0-52 30-90 84-106z" fill="url(#lit)"/>` +
      `<rect x="1575" y="388" width="90" height="34" rx="8" fill="#1f2a27"/>`),
};

/** 반쪽 기획전 배너(960×480) — 홈 가운데의 두 칸 */
export const PROMO_ART: Record<string, () => string> = {
  gift: () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480" viewBox="0 0 960 480">` +
    `<rect width="960" height="480" fill="#f1dcd3"/><circle cx="740" cy="170" r="150" fill="#fff" opacity=".35"/>` +
    `<rect x="560" y="220" width="280" height="200" rx="12" fill="#c75f4c"/><rect x="540" y="180" width="320" height="60" rx="12" fill="#d8735f"/>` +
    `<rect x="680" y="180" width="40" height="240" fill="#f6d57a"/>` +
    `<path d="M700 180c-60-70-130-40-100 0M700 180c60-70 130-40 100 0" fill="none" stroke="#f6d57a" stroke-width="18" stroke-linecap="round"/>` +
    `</svg>`,
  sale: () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480" viewBox="0 0 960 480">` +
    `<rect width="960" height="480" fill="#2f3b37"/><circle cx="720" cy="240" r="170" fill="#56766a" opacity=".6"/>` +
    `<circle cx="720" cy="240" r="110" fill="none" stroke="#e9d9a8" stroke-width="10" stroke-dasharray="4 16" stroke-linecap="round"/>` +
    `<path d="M660 300l120-120" stroke="#e9d9a8" stroke-width="14" stroke-linecap="round"/>` +
    `<circle cx="670" cy="190" r="26" fill="none" stroke="#e9d9a8" stroke-width="12"/><circle cx="770" cy="290" r="26" fill="none" stroke="#e9d9a8" stroke-width="12"/>` +
    `</svg>`,
};

/** 풍경(1200×900) — 커뮤니티 스타터의 갤러리 게시판 예시 글에 들어간다 */
function scene(sky: [string, string], body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">` +
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>` +
    `<rect width="1200" height="900" fill="url(#sky)"/>` + body + `</svg>`
  );
}

export const GALLERY_ART: Record<string, () => string> = {
  /** 새벽 산 */
  mountain: () =>
    scene(["#f6d3b8", "#e8a7a1"],
      `<circle cx="850" cy="300" r="90" fill="#fff4dc" opacity=".9"/>` +
      `<path d="M0 620L230 360l150 170 170-250 220 300 150-150 280 330V900H0z" fill="#b87f86"/>` +
      `<path d="M0 700l260-190 190 130 210-170 250 200 140-90 150 110V900H0z" fill="#8c5a6b"/>` +
      `<path d="M0 800l300-110 260 70 300-100 340 120V900H0z" fill="#5f3a52"/>`),
  /** 여름 바다 */
  sea: () =>
    scene(["#a9dcef", "#e6f6fb"],
      `<circle cx="300" cy="220" r="70" fill="#fff8d6"/>` +
      `<rect y="470" width="1200" height="430" fill="#3a8fb7"/>` +
      `<path d="M0 520q150-30 300 0t300 0 300 0 300 0" fill="none" stroke="#bfe6f5" stroke-width="6" opacity=".7"/>` +
      `<path d="M0 600q150-30 300 0t300 0 300 0 300 0" fill="none" stroke="#bfe6f5" stroke-width="5" opacity=".5"/>` +
      `<path d="M0 760c200-40 420-40 620 0s420 40 580 0V900H0z" fill="#f2dfb4"/>` +
      `<path d="M760 470l40-120 40 120z" fill="#fff"/><path d="M760 470h90l-10 18h-70z" fill="#2e5b73"/>`),
  /** 도시의 밤 */
  city: () =>
    scene(["#1d2340", "#3a3f6b"],
      `<circle cx="960" cy="180" r="60" fill="#f4efd2"/>` +
      [[60, 420, 120], [200, 360, 90], [310, 460, 140], [470, 300, 110], [600, 400, 130], [750, 340, 100], [870, 440, 150], [1040, 380, 120]]
        .map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="${900 - y}" fill="#141830"/>` +
          Array.from({ length: 6 }, (_, i) => `<rect x="${x + 16 + (i % 3) * (w / 3)}" y="${y + 30 + Math.floor(i / 3) * 60}" width="14" height="22" fill="#f6c86b" opacity="${i % 2 ? 0.9 : 0.45}"/>`).join(""))
        .join("")),
  /** 가을 숲 */
  forest: () =>
    scene(["#f7ecd9", "#efd9b4"],
      `<rect y="700" width="1200" height="200" fill="#c79a5e"/>` +
      [[120, "#c9632f"], [300, "#e0913a"], [470, "#b44a2a"], [650, "#d9a441"], [830, "#c9632f"], [1020, "#e0913a"]]
        .map(([x, c]) => `<rect x="${Number(x) - 10}" y="520" width="20" height="200" fill="#6b4a33"/><circle cx="${x}" cy="470" r="110" fill="${c}"/><circle cx="${Number(x) + 50}" cy="420" r="70" fill="${c}" opacity=".85"/>`).join("")),
};

/** 회사 소개 사진 자리(1200×800) — 책상·화면·화분이 놓인 작업 공간 */
export const OFFICE_ART = (): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">` +
  `<rect width="1200" height="800" fill="#eaf0f8"/>` +
  `<rect x="760" y="90" width="320" height="380" rx="8" fill="#fff"/><path d="M920 90v380M760 280h320" stroke="#d6e0ee" stroke-width="10"/>` +
  `<rect y="560" width="1200" height="240" fill="#d7e1ee"/>` +
  `<rect x="200" y="520" width="800" height="36" rx="8" fill="#9aa9bf"/>` +
  `<rect x="400" y="280" width="400" height="250" rx="16" fill="#1f3a68"/><rect x="420" y="300" width="360" height="205" rx="8" fill="#3d6fb6"/>` +
  `<rect x="450" y="330" width="170" height="16" rx="8" fill="#cfe0f7"/><rect x="450" y="364" width="260" height="12" rx="6" fill="#9dc0ee"/><rect x="450" y="390" width="220" height="12" rx="6" fill="#9dc0ee"/>` +
  `<rect x="450" y="430" width="110" height="44" rx="10" fill="#f2b84b"/>` +
  `<rect x="570" y="530" width="60" height="30" fill="#1f3a68"/>` +
  `<rect x="230" y="440" width="90" height="80" rx="10" fill="#c96f4a"/>` +
  `<path d="M275 440c-40-60-80-60-90-120 50 10 80 50 90 120zM275 440c30-70 70-90 100-140-40 60-60 90-100 140zM275 440c0-70 10-120 40-170-10 60-20 110-40 170z" fill="#4f8a5b"/>` +
  `<rect x="860" y="470" width="120" height="50" rx="8" fill="#fff"/><rect x="880" y="486" width="80" height="8" rx="4" fill="#9aa9bf"/>` +
  `</svg>`;
