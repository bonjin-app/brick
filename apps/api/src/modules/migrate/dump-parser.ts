/**
 * mysqldump 파일 읽기.
 *
 * 왜 덤프 파일인가:
 *   그누보드는 대부분 공유 호스팅에서 돌고, 그런 호스팅은 외부에서 MySQL에
 *   접속하는 것을 막는다(bind-address 127.0.0.1). 사용자가 실제로 손에 넣을 수
 *   있는 것은 **phpMyAdmin 내보내기 파일**이다.
 *   원격 접속을 전제하면 "안 되는 사람"이 대부분이 된다.
 *
 * 왜 정규식으로 안 하는가:
 *   INSERT 문 안의 문자열에 괄호·쉼표·따옴표가 들어 있다. 게시글 본문에는
 *   `),(` 도 `\'` 도 흔하다. 정규식으로 자르면 본문이 있는 실제 데이터에서
 *   조용히 깨진다 — 그리고 그 깨짐은 "글이 몇 건 빠졌다"로 나타나 눈치채기 어렵다.
 *   그래서 문자 단위로 상태를 들고 읽는다.
 *
 * 지원하는 것: INSERT INTO ... VALUES (...),(...); 와 CREATE TABLE 의 컬럼 순서.
 * 지원하지 않는 것: 저장 프로시저 · 트리거 · 뷰 (그누보드는 쓰지 않는다).
 */

export interface DumpTable {
  /** 접두어를 포함한 원래 이름 (예: g5_member) */
  name: string;
  /** CREATE TABLE 에 나온 컬럼 순서 */
  columns: string[];
}

/** 한 행 — 컬럼명 → 값. NULL 은 null */
export type DumpRow = Record<string, string | null>;

/**
 * 덤프에서 테이블 정의를 읽는다.
 *
 * INSERT 문이 컬럼 목록을 생략하는 경우(phpMyAdmin 기본값 중 하나)가 있어
 * CREATE TABLE 의 순서를 알아야 값을 컬럼에 붙일 수 있다.
 */
export function parseTables(sql: string): Map<string, DumpTable> {
  const tables = new Map<string, DumpTable>();
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([\w$]+)`?\s*\(/gi;

  let m: RegExpExecArray | null;
  while ((m = createRe.exec(sql))) {
    const name = m[1];
    const body = readBalanced(sql, m.index + m[0].length - 1);
    if (body === null) continue;

    const columns: string[] = [];
    for (const line of splitTopLevel(body)) {
      const trimmed = line.trim();
      // 컬럼 정의는 백틱으로 시작한다. KEY/PRIMARY/UNIQUE/CONSTRAINT 는 건너뛴다.
      const col = /^`([^`]+)`/.exec(trimmed);
      if (col) {
        columns.push(col[1]);
        continue;
      }
      if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FULLTEXT|SPATIAL|FOREIGN)\b/i.test(trimmed)) {
        continue;
      }
      // 백틱 없이 쓴 컬럼명 (드물지만 있다)
      const bare = /^([A-Za-z_][\w$]*)\s+\S/.exec(trimmed);
      if (bare) columns.push(bare[1]);
    }
    tables.set(name, { name, columns });
  }
  return tables;
}

/**
 * 특정 테이블의 행을 순서대로 낸다.
 *
 * 제너레이터인 이유: 그누보드 덤프는 수백 MB 가 되는 경우가 있다.
 * 모든 행을 배열로 모으면 메모리가 터진다 — 호출자가 배치로 처리할 수 있게
 * 하나씩 낸다.
 */
export function* readRows(
  sql: string,
  table: string,
  tables: Map<string, DumpTable>,
): Generator<DumpRow> {
  const defined = tables.get(table)?.columns ?? [];
  // INSERT INTO `t` (a,b) VALUES ... / INSERT INTO `t` VALUES ...
  const insertRe = new RegExp(
    `INSERT\\s+(?:IGNORE\\s+)?INTO\\s+\`?${escapeRe(table)}\`?\\s*(\\([^)]*\\))?\\s*VALUES`,
    "gi",
  );

  let m: RegExpExecArray | null;
  while ((m = insertRe.exec(sql))) {
    const columns = m[1]
      ? m[1]
          .slice(1, -1)
          .split(",")
          .map((c) => c.trim().replace(/^`|`$/g, ""))
      : defined;

    // VALUES 뒤부터 세미콜론까지 튜플을 읽는다
    let cursor = m.index + m[0].length;
    while (cursor < sql.length) {
      // 다음 여는 괄호까지
      while (cursor < sql.length && sql[cursor] !== "(") {
        const ch = sql[cursor];
        if (ch === ";") break;
        cursor += 1;
      }
      if (cursor >= sql.length || sql[cursor] === ";") break;

      const tuple = readBalanced(sql, cursor);
      if (tuple === null) break;
      cursor += tuple.length + 2; // 괄호 두 개

      const values = splitTopLevel(tuple).map(decodeValue);
      const row: DumpRow = {};
      for (let i = 0; i < columns.length; i += 1) {
        row[columns[i]] = values[i] ?? null;
      }
      yield row;

      // 다음 튜플 앞의 쉼표·공백을 넘긴다
      while (cursor < sql.length && /[\s,]/.test(sql[cursor])) cursor += 1;
      if (sql[cursor] === ";") break;
      if (sql[cursor] !== "(") break;
    }
    // 다음 INSERT 를 이어서 찾도록 커서를 옮긴다
    insertRe.lastIndex = Math.max(insertRe.lastIndex, cursor);
  }
}

/** 덤프에 들어 있는 테이블 접두어를 추측한다 (g5_ · gnu_ · 사용자 지정) */
export function detectPrefix(tables: Map<string, DumpTable>): string {
  // member 테이블은 그누보드에 반드시 있다. 그 이름에서 접두어를 뽑는다.
  for (const name of tables.keys()) {
    const m = /^(.*)member$/.exec(name);
    if (m && tables.has(`${m[1]}board`) && tables.has(`${m[1]}write_free`) === false) {
      // write_free 는 게시판마다 다르므로 없어도 된다 — board 만 확인한다
      return m[1];
    }
    if (m && tables.has(`${m[1]}board`)) return m[1];
  }
  return "";
}

/* ── 내부 ──────────────────────────────────────────── */

/**
 * `start` 위치의 여는 괄호에 대응하는 닫는 괄호까지의 **내용**을 반환한다.
 *
 * 문자열 리터럴 안의 괄호는 세지 않는다. 이것이 정규식으로 안 되는 이유다 —
 * 게시글 본문에 `)` 가 하나만 있어도 잘못 끊긴다.
 */
function readBalanced(sql: string, start: number): string | null {
  if (sql[start] !== "(") return null;
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let inBacktick = false;

  for (let i = start; i < sql.length; i += 1) {
    const ch = sql[i];

    if (inString) {
      if (ch === "\\") {
        i += 1; // 이스케이프된 다음 문자를 건너뛴다
        continue;
      }
      // MySQL 은 '' 로도 따옴표를 이스케이프한다
      if (ch === inString) {
        if (sql[i + 1] === inString) {
          i += 1;
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (inBacktick) {
      if (ch === "`") inBacktick = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(start + 1, i);
    }
  }
  return null;
}

/** 최상위 쉼표로 자른다 (문자열·괄호 안의 쉼표는 무시) */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let inBacktick = false;
  let buf = "";

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      buf += ch;
      if (ch === "\\") {
        buf += text[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === inString) {
        if (text[i + 1] === inString) {
          buf += text[i + 1];
          i += 1;
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (inBacktick) {
      buf += ch;
      if (ch === "`") inBacktick = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      buf += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

/**
 * SQL 값 리터럴 → JS 값.
 *
 * MySQL 의 이스케이프를 되돌린다. `\n` 을 문자 그대로 두면 게시글의 줄바꿈이
 * 백슬래시-n 두 글자로 보이게 된다.
 */
function decodeValue(raw: string): string | null {
  const v = raw.trim();
  if (v === "" || /^NULL$/i.test(v)) return null;

  if (v.startsWith("'") || v.startsWith('"')) {
    const quote = v[0];
    const inner = v.slice(1, v.length - (v.endsWith(quote) ? 1 : 0));
    let out = "";
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch === "\\") {
        const next = inner[i + 1];
        i += 1;
        switch (next) {
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "0": out += "\0"; break;
          case "b": out += "\b"; break;
          case "Z": out += "\x1a"; break;
          case "\\": out += "\\"; break;
          case "'": out += "'"; break;
          case '"': out += '"'; break;
          // \% 와 \_ 는 LIKE 용이라 백슬래시를 유지한다
          case "%": out += "\\%"; break;
          case "_": out += "\\_"; break;
          default: out += next ?? "";
        }
        continue;
      }
      // '' → '
      if (ch === quote && inner[i + 1] === quote) {
        out += quote;
        i += 1;
        continue;
      }
      out += ch;
    }
    return out;
  }

  // 0x... 바이너리 리터럴 (드물게 blob 컬럼에 쓰인다)
  if (/^0x[0-9a-f]+$/i.test(v)) {
    return Buffer.from(v.slice(2), "hex").toString("utf8");
  }
  return v;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
