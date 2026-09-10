/**
 * 캡차가 정답을 흘리지 않는지 확인한다.
 *
 * 왜 스모크(HTTP)가 아니라 여기인가: "제대로 풀면 통과한다"를 검증하려면 정답을 알아야
 * 하는데, 정답은 HTTP 로 나가지 않는 것이 이 검사의 요지다. 그래서 제공자를 프로세스
 * 안에서 직접 만들어(테스트 이음매로 정답을 받아) 암호적 성질을 전부 확인한다.
 *
 * 이 검사가 없던 동안 캡차는 봇을 하나도 막지 못했다 — SVG 의 <text> 와 토큰의
 * base64 페이로드, 두 군데로 정답이 평문으로 나가고 있었다.
 *
 * 사용법: node scripts/check-captcha-secrecy.mjs   (apps/api 빌드 후)
 */
import { SvgCaptchaProvider } from "../apps/api/dist/providers/svg-captcha.provider.js";

const store = new Map();
const cache = {
  async get(k) { return store.get(k); },
  async set(k, v) { store.set(k, v); },
  async del(k) { store.delete(k); },
};

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✅ ${m}`); };
const bad = (m) => { fail++; console.log(`  ❌ ${m}`); };
const check = (m, cond) => (cond ? ok(m) : bad(m));

const SECRET = "test-secret-for-captcha-check";
const answers = [];
const captcha = new SvgCaptchaProvider(SECRET, cache, (a) => answers.push(a));

console.log("▶ 캡차 비밀 유지 검사");

console.log("── 정답이 응답 어디에도 없다 (200회)");
let textNode = 0, inSvg = 0, inToken = 0;
for (let i = 0; i < 200; i++) {
  const { token, svg } = await captcha.issue();
  const answer = answers.at(-1);
  if (/<text/i.test(svg)) textNode++;
  // 마크업에서 태그를 걷어낸 나머지 = 사람이 아닌 기계가 그냥 읽을 수 있는 문자열
  const bare = svg.replace(/<[^>]*>/g, "");
  if (bare.includes(answer)) inSvg++;
  const body = token.slice(0, token.lastIndexOf("."));
  const decoded = Buffer.from(body, "base64url").toString("utf8");
  if (decoded.includes(answer)) inToken++;
}
check("SVG 에 <text> 가 없다 (문자열로 그리면 정답이 마크업에 박힌다)", textNode === 0);
check("SVG 태그를 걷어내도 정답이 없다", inSvg === 0);
check("토큰을 base64 디코드해도 정답이 없다 (서명은 위조만 막는다)", inToken === 0);

console.log("── 그래도 캡차로서 동작한다");
{
  const { token } = await captcha.issue();
  const a = answers.at(-1);
  check("제대로 풀면 통과", (await captcha.verify(token, a)) === true);
}
{
  const { token } = await captcha.issue();
  check("틀리면 거부", (await captcha.verify(token, "ZZZZZ")) === false);
}
{
  const { token } = await captcha.issue();
  const a = answers.at(-1);
  check("대소문자는 구분하지 않는다", (await captcha.verify(token, a.toLowerCase())) === true);
}
{
  const { token } = await captcha.issue();
  const a = answers.at(-1);
  await captcha.verify(token, a);
  check("같은 토큰 재사용 거부 (한 번 풀고 무한히 쓰는 것을 막는다)", (await captcha.verify(token, a)) === false);
}
{
  const { token } = await captcha.issue();
  const a = answers.at(-1);
  const other = new SvgCaptchaProvider("다른-비밀키", cache, () => {});
  check("다른 비밀키로는 검증되지 않는다", (await other.verify(token, a)) === false);
}
{
  // 서명 없이 페이로드만 바꿔치기 — 옛 구조({"a":"AAAAA"})를 흉내낸다
  const body = Buffer.from(JSON.stringify({ h: "x", e: Date.now() + 60000, n: "fake" })).toString("base64url");
  check("위조 토큰 거부", (await captcha.verify(`${body}.badsignature`, "AAAAA")) === false);
}
{
  const { token } = await captcha.issue();
  const a = answers.at(-1);
  check("빈 답 거부", (await captcha.verify(token, "")) === false);
  check("토큰 없이 거부", (await captcha.verify("", a)) === false);
}

console.log("── 문제가 매번 다르다");
{
  const seen = new Set();
  const svgs = new Set();
  for (let i = 0; i < 50; i++) {
    const { svg } = await captcha.issue();
    seen.add(answers.at(-1));
    svgs.add(svg);
  }
  check(`정답이 반복되지 않는다 (50회 중 ${seen.size}종)`, seen.size >= 45);
  check("같은 그림이 두 번 나오지 않는다", svgs.size === 50);
}

console.log("── 글자가 실제로 그려진다 (선이 빠진 글자가 있으면 못 읽는다)");
{
  const alphabet = "34679ACDEFGHJKLMNPQRTUVWXY";
  const missing = [];
  for (const ch of alphabet) {
    // 그 글자만 나올 때까지 뽑는 대신, 획 수를 세어 글리프가 비어있지 않은지 본다
    let found = false;
    for (let i = 0; i < 400 && !found; i++) {
      const { svg } = await captcha.issue();
      if (!answers.at(-1).includes(ch)) continue;
      found = true;
      const paths = svg.match(/<path d="M[^"]*"/g) ?? [];
      if (paths.length < 5) missing.push(ch);
    }
    if (!found) missing.push(`${ch}(뽑히지 않음)`);
  }
  check(`26글자 모두 획이 있다${missing.length ? ` — 빠짐: ${missing.join(",")}` : ""}`, missing.length === 0);
}

console.log(`\n결과: ${pass}개 통과, ${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
