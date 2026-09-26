/**
 * 페이지 블록 트리 연산 — 배치 편집기가 쓴다.
 *
 * 모두 **새 트리를 돌려준다**(원본을 바꾸지 않는다). 되돌리기가 옛 트리를 그대로 들고 있어야 하고,
 * React 가 바뀐 것을 알아야 하기 때문이다.
 *
 * 위치는 경로(`[0, 2, 1]` = 첫 블록의 셋째 안쪽 블록의 둘째 안쪽 블록)로 가리킨다. 서버가 미리보기에
 * 다는 `data-brick-node="0.2.1"` 과 같은 표기다.
 *
 * 이 파일은 아무것도 불러오지 않는다 — 스모크가 node 로 직접 실행해 시험한다
 * (scripts/smoke-layout-editor.sh).
 */

export interface BlockNode {
  block: string;
  props: Record<string, unknown>;
  children?: BlockNode[];
}

export type Path = number[];

export const pathKey = (p: Path): string => p.join(".");

export function parsePath(s: string): Path | null {
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  return s.split(".").map(Number);
}

export const samePath = (a: Path | null, b: Path | null): boolean =>
  Boolean(a && b && a.length === b.length && a.every((v, i) => v === b[i]));

/** a 가 b 의 조상인가(또는 같은가) — 블록을 자기 안으로 옮기는 것을 막는다 */
export const isPrefix = (a: Path, b: Path): boolean => a.length <= b.length && a.every((v, i) => v === b[i]);

export function getNode(tree: BlockNode[], path: Path): BlockNode | undefined {
  let list: BlockNode[] | undefined = tree;
  let node: BlockNode | undefined;
  for (const i of path) {
    node = list?.[i];
    if (!node) return undefined;
    list = node.children;
  }
  return node;
}

/** 경로의 형제 목록 (부모의 children, 최상위면 트리) */
function siblingsOf(tree: BlockNode[], path: Path): BlockNode[] | undefined {
  if (!path.length) return undefined;
  return path.length === 1 ? tree : getNode(tree, path.slice(0, -1))?.children;
}

/** 부모 경로의 children 목록을 fn 으로 바꾼 새 트리 (parent = [] 면 최상위) */
function withList(tree: BlockNode[], parent: Path, fn: (list: BlockNode[]) => BlockNode[]): BlockNode[] {
  if (!parent.length) return fn([...tree]);
  const [head, ...rest] = parent;
  return tree.map((n, i) =>
    i === head ? { ...n, children: withList(n.children ?? [], rest, fn) } : n,
  );
}

export function updateAt(tree: BlockNode[], path: Path, fn: (n: BlockNode) => BlockNode): BlockNode[] {
  if (!path.length || !getNode(tree, path)) return tree;
  return withList(tree, path.slice(0, -1), (list) => {
    const i = path[path.length - 1];
    list[i] = fn(list[i]);
    return list;
  });
}

export function removeAt(tree: BlockNode[], path: Path): BlockNode[] {
  if (!getNode(tree, path)) return tree;
  return withList(tree, path.slice(0, -1), (list) => {
    list.splice(path[path.length - 1], 1);
    return list;
  });
}

/** parent 의 index 자리에 넣는다. index 가 범위를 넘으면 끝에 */
export function insertAt(tree: BlockNode[], parent: Path, index: number, node: BlockNode): { tree: BlockNode[]; path: Path } {
  let at = 0;
  const next = withList(tree, parent, (list) => {
    at = Math.max(0, Math.min(index, list.length));
    list.splice(at, 0, node);
    return list;
  });
  return { tree: next, path: [...parent, at] };
}

/**
 * from 의 블록을 toParent 의 toIndex 자리로 옮긴다. toIndex 는 **옮기기 전** 목록 기준이다
 * (끌어다 놓을 때 화면에 보이던 자리 그대로).
 *
 * 자기 자신이나 자기 안쪽으로는 옮기지 않는다 — 블록이 트리에서 사라진다.
 */
export function moveNode(tree: BlockNode[], from: Path, toParent: Path, toIndex: number): { tree: BlockNode[]; path: Path } | null {
  const node = getNode(tree, from);
  if (!node || isPrefix(from, toParent)) return null;
  const fromParent = from.slice(0, -1);
  const fromIndex = from[from.length - 1];
  // 빼낸 뒤의 목적지 — 같은 목록의 뒤쪽이면 한 칸, 빼낸 블록의 뒤쪽 형제 안이면 그 자리가 한 칸 당겨진다
  const target = [...toParent];
  let index = toIndex;
  if (samePath(fromParent, toParent)) {
    if (fromIndex < toIndex) index -= 1;
  } else if (isPrefix(fromParent, toParent) && target[fromParent.length] > fromIndex) {
    target[fromParent.length] -= 1;
  }
  const without = removeAt(tree, from);
  const moved = insertAt(without, target, index, node);
  return samePath(moved.path, from) ? { tree, path: from } : moved;
}

/** 형제 사이에서 한 칸 위(-1)·아래(+1) */
export function moveSibling(tree: BlockNode[], path: Path, dir: -1 | 1): { tree: BlockNode[]; path: Path } | null {
  const list = siblingsOf(tree, path);
  const i = path[path.length - 1];
  const j = i + dir;
  if (!list || j < 0 || j >= list.length) return null;
  return moveNode(tree, path, path.slice(0, -1), dir < 0 ? j : j + 1);
}

/** 감싼 컨테이너 밖으로 — 부모 바로 뒤 */
export function outdent(tree: BlockNode[], path: Path): { tree: BlockNode[]; path: Path } | null {
  if (path.length < 2) return null;
  const parent = path.slice(0, -1);
  return moveNode(tree, path, parent.slice(0, -1), parent[parent.length - 1] + 1);
}

/** 바로 위 형제가 컨테이너면 그 안의 끝으로 — 끌어다 놓기를 못 쓰는 키보드 사용자의 길 */
export function indentIntoPrevious(
  tree: BlockNode[],
  path: Path,
  accepts: (block: string) => boolean,
): { tree: BlockNode[]; path: Path } | null {
  const i = path[path.length - 1];
  if (i === 0) return null;
  const prevPath = [...path.slice(0, -1), i - 1];
  const prev = getNode(tree, prevPath);
  if (!prev || !accepts(prev.block)) return null;
  return moveNode(tree, path, prevPath, prev.children?.length ?? 0);
}

/** 깊은 복사를 바로 뒤에 */
export function duplicateAt(tree: BlockNode[], path: Path): { tree: BlockNode[]; path: Path } | null {
  const node = getNode(tree, path);
  if (!node) return null;
  const copy = JSON.parse(JSON.stringify(node)) as BlockNode;
  return insertAt(tree, path.slice(0, -1), path[path.length - 1] + 1, copy);
}

/** 트리를 줄 목록으로 — 개요 패널이 들여쓰기로 그린다 */
export function flatten(tree: BlockNode[], base: Path = []): Array<{ path: Path; node: BlockNode; depth: number }> {
  const out: Array<{ path: Path; node: BlockNode; depth: number }> = [];
  tree.forEach((node, i) => {
    const path = [...base, i];
    out.push({ path, node, depth: base.length });
    if (node.children?.length) out.push(...flatten(node.children, path));
  });
  return out;
}

/**
 * 미리보기에서 그 자리에서 고친 글자를 트리에 반영한다.
 *
 * 값은 미리보기 창이 보낸 것이다 — 그 창에는 블록의 스크립트도 돈다. 그래서 다시 본다: 경로가 있는 노드이고,
 * 그 블록이 스키마에 **글자(string) 속성으로 선언한** 이름이어야 한다(`__proto__` 같은 이름이나 숫자·참거짓
 * 속성에 글자가 들어가지 않게). 아니면 null. 같은 값이면 원래 트리를 그대로 돌려준다(되돌리기가 헛돌지 않게).
 */
type SchemaOf = (block: string) => Record<string, { type?: string }> | undefined;

/**
 * 미리보기가 가리킨 노드의 **글자 속성** — 경로가 있는 노드이고, 그 블록의 스키마에 글자(string)로 선언된
 * 이름이어야 한다(`__proto__` 같은 이름이나 숫자·참거짓 속성에 글자가 들어가지 않게). 아니면 null.
 */
function stringPropOf(
  tree: BlockNode[], pathStr: unknown, prop: unknown, schemaOf: SchemaOf,
): { path: Path; node: BlockNode; prop: string } | null {
  if (typeof pathStr !== "string" || typeof prop !== "string") return null;
  const path = parsePath(pathStr);
  const node = path ? getNode(tree, path) : undefined;
  if (!path || !node) return null;
  const schema = schemaOf(node.block);
  if (!schema || !Object.prototype.hasOwnProperty.call(schema, prop) || schema[prop]?.type !== "string") return null;
  return { path, node, prop };
}

export function applyTextEdit(
  tree: BlockNode[],
  pathStr: unknown,
  prop: unknown,
  value: unknown,
  schemaOf: SchemaOf,
): { tree: BlockNode[]; path: Path } | null {
  if (typeof value !== "string") return null;
  const target = stringPropOf(tree, pathStr, prop, schemaOf);
  if (!target) return null;
  const { path, node, prop: key } = target;
  const next = value.slice(0, 20000);
  if ((node.props ?? {})[key] === next) return { tree, path };
  return { tree: updateAt(tree, path, (n) => ({ ...n, props: { ...(n.props ?? {}), [key]: next } })), path };
}

/**
 * 미리보기 안에서 끌어다 놓은 것을 트리에 반영한다.
 *
 * 미리보기 창이 보낸 값이라 다시 본다: 두 경로 모두 있는 노드여야 하고, `inside` 는 놓은 블록이 컨테이너일 때만,
 * 자기 자신이나 자기 안쪽으로는 옮기지 않는다(moveNode 가 막는다). 아니면 null.
 */
export function applyMove(
  tree: BlockNode[],
  fromStr: unknown,
  toStr: unknown,
  where: unknown,
  accepts: (block: string) => boolean,
): { tree: BlockNode[]; path: Path } | null {
  if (typeof fromStr !== "string" || typeof toStr !== "string") return null;
  const from = parsePath(fromStr);
  const to = parsePath(toStr);
  if (!from || !to || !getNode(tree, from)) return null;
  const target = getNode(tree, to);
  if (!target) return null;
  if (where === "inside") {
    if (!accepts(target.block)) return null;
    return moveNode(tree, from, to, target.children?.length ?? 0);
  }
  if (where !== "before" && where !== "after") return null;
  return moveNode(tree, from, to.slice(0, -1), to[to.length - 1] + (where === "after" ? 1 : 0));
}

/**
 * 목록형 속성(한 줄에 하나, `|` 로 칸을 나눈 글자)의 **한 칸**을 미리보기에서 고쳤다.
 *
 * row 는 빈 줄을 뺀 몇 번째 줄인가(블록의 rows 가 세는 순서), col 은 그 줄의 몇 번째 칸인가. 그 칸만 바꾸고
 * 나머지 줄은 **글자 그대로** 둔다. 고친 값에 칸 구분자(`|`)나 줄바꿈이 들어오면 공백으로 바꾼다 — 그대로 두면
 * 칸이 하나 늘거나 줄이 갈라져 카드가 엉뚱하게 나뉜다. 스키마의 글자 속성이 아니거나 그런 줄이 없으면 null.
 */
export function applyCellEdit(
  tree: BlockNode[],
  pathStr: unknown,
  prop: unknown,
  row: unknown,
  col: unknown,
  value: unknown,
  schemaOf: SchemaOf,
): { tree: BlockNode[]; path: Path } | null {
  if (typeof value !== "string" || !Number.isInteger(row) || !Number.isInteger(col)) return null;
  const r = row as number;
  const c = col as number;
  if (r < 0 || c < 0 || c > 20) return null;
  const target = stringPropOf(tree, pathStr, prop, schemaOf);
  if (!target) return null;
  const { path, node, prop: key } = target;
  const lines = String((node.props ?? {})[key] ?? "").split("\n");
  const filled = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  const at = filled[r];
  if (at === undefined) return null;
  const cells = lines[at].split("|").map((s) => s.trim());
  const cell = value.replace(/[|\r\n]+/g, " ").trim().slice(0, 2000);
  // 같은 값이면 원래 트리 — 줄을 다시 쓰면 칸 사이 공백만 달라져도 되돌리기 기록이 쌓인다
  if ((cells[c] ?? "") === cell) return { tree, path };
  while (cells.length <= c) cells.push("");
  // 없던 칸을 채우면 그 칸까지만 늘어난다(사이의 빈 칸은 빈 채로)
  cells[c] = cell;
  const line = cells.join(" | ");
  const next = [...lines];
  next[at] = line;
  return { tree: updateAt(tree, path, (n) => ({ ...n, props: { ...(n.props ?? {}), [key]: next.join("\n") } })), path };
}
