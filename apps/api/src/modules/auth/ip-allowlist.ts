/**
 * 관리자 IP 허용목록 — 파싱과 대조.
 *
 * 형식: 쉼표/줄바꿈 구분. IPv4 단일("1.2.3.4")과 CIDR("10.0.0.0/8"),
 * IPv6 단일. IPv6 CIDR 은 받지 않는다 — 필요해질 때까지 반쪽 구현을
 * 두지 않는다(반쪽 구현은 "설정했는데 안 막히는" 보안 기능이 된다).
 *
 * IPv4-mapped IPv6(::ffff:1.2.3.4)는 IPv4 로 취급한다 — 듀얼스택에서
 * 흔하고, 이것을 안 하면 목록에 IPv4 를 적은 운영자가 잠긴다.
 */

export interface ParsedAllowlist {
  entries: Array<{ raw: string; kind: "v4" | "v4cidr" | "v6" }>;
  invalid: string[];
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** IPv6 을 비교 가능한 정규형으로 (완전 전개, 소문자) */
function normalizeV6(ip: string): string | null {
  const s = ip.trim().toLowerCase();
  if (!s.includes(":")) return null;
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (parts.length === 1 && head.length !== 8) return null;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out: string[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(g.padStart(4, "0"));
  }
  return out.join(":");
}

export function parseAllowlist(text: string): ParsedAllowlist {
  const entries: ParsedAllowlist["entries"] = [];
  const invalid: string[] = [];
  for (const raw of String(text ?? "").split(/[\n,]/)) {
    const item = raw.trim();
    if (!item) continue;
    const cidr = /^(.+)\/(\d{1,2})$/.exec(item);
    if (cidr) {
      const bits = Number(cidr[2]);
      if (ipv4ToInt(cidr[1]) !== null && bits >= 0 && bits <= 32) {
        entries.push({ raw: item, kind: "v4cidr" });
        continue;
      }
      invalid.push(item);
      continue;
    }
    if (ipv4ToInt(item) !== null) {
      entries.push({ raw: item, kind: "v4" });
      continue;
    }
    if (normalizeV6(item) !== null) {
      entries.push({ raw: item, kind: "v6" });
      continue;
    }
    invalid.push(item);
  }
  return { entries, invalid };
}

export function ipAllowed(clientIp: string, allowlistText: string): boolean {
  const { entries } = parseAllowlist(allowlistText);
  if (!entries.length) return true; // 빈 목록 = 제한 없음

  let ip = String(clientIp ?? "").trim();
  // IPv4-mapped IPv6
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (mapped) ip = mapped[1];

  const v4 = ipv4ToInt(ip);
  const v6 = v4 === null ? normalizeV6(ip) : null;

  for (const e of entries) {
    if (e.kind === "v4" && v4 !== null) {
      if (ipv4ToInt(e.raw) === v4) return true;
    } else if (e.kind === "v4cidr" && v4 !== null) {
      const [net, bitsStr] = e.raw.split("/");
      const bits = Number(bitsStr);
      const netInt = ipv4ToInt(net)!;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((v4 & mask) === (netInt & mask)) return true;
    } else if (e.kind === "v6" && v6 !== null) {
      if (normalizeV6(e.raw) === v6) return true;
    }
  }
  return false;
}
