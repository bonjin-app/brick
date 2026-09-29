#!/usr/bin/env node
/*
 * 플러그인의 핵심 함수를 가짜 DB 로 직접 시험한다 — API 도 PostgreSQL 도 필요 없다(빌드된 dist 만 읽는다).
 *
 * 스모크는 실제 서버를 띄워 끝에서 끝까지 확인하는 대신 **재현할 수 없는 분기**가 있다. 이 검사가 그 자리를 맡는다:
 *   - 결제완료 직후 취소가 끼어드는 경합 — API 로는 알림이 취소보다 먼저 끝나서 열리지 않는다(역검증에서 "취소 확인을
 *     빼도" 스모크가 통과했다). 가짜 DB 는 "그 사이 취소됐다" 를 바로 만든다.
 *   - 원글 비밀번호의 시도 횟수 키 — 어느 글의 몫으로 확인하는지.
 *   - 글 지우기의 커밋 뒤 미루기 — 트랜잭션 안에서는 파일·알림이 아직 일어나지 않아야 한다.
 *   - 포인트 돌려주기·거두기의 순서와 선택 항목.
 */
import { announcePaid, sweepUnannouncedPaid } from "../plugins/brick-shop/dist/order-lifecycle.js";
import { restoreOrderPoints } from "../plugins/brick-shop/dist/orders.js";
import { canReadSecret, canReadSecretAsMember, secretPostRef } from "../plugins/brick-board/dist/access.js";
import { deletePosts } from "../plugins/brick-board/dist/posts.js";

let bad = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : ` (기대 ${JSON.stringify(want)}, 실제 ${JSON.stringify(got)})`}`);
};

/** 가짜 DB — execute 는 미리 준 응답을 차례로 돌려주고(모자라면 빈 결과), 부른 SQL 글자를 모은다 */
function fakeDb(...replies) {
  const calls = [];
  const db = {
    calls,
    execute: async (q) => {
      calls.push(JSON.stringify(q));
      return { rows: replies.shift() ?? [] };
    },
    transaction: async (fn) => fn(db),
  };
  return db;
}

console.log("▶ 플러그인 핵심 함수 (가짜 DB)");

// ── 결제 완료 알림 ─────────────────────────────
console.log("── announcePaid");
{
  const run = async (status, hookImpl) => {
    const db = fakeDb(status ? [{ order_no: "N1", user_id: "u1", total: 1000, status }] : []);
    const fired = [];
    const hooks = { doActionOrThrow: hookImpl ?? (async (h, p) => { fired.push([h, p]); }) };
    let thrown = null;
    try { await announcePaid({ db, hooks, logger: { warn() {} }, notifyOrder: async () => {} }, "o1"); } catch (e) { thrown = e; }
    return { fired, db, thrown };
  };
  const doneMarks = (r) => r.db.calls.filter((c) => c.includes("paid_announced_at")).length;
  const paid = await run("paid");
  eq("결제완료면 shop.order.paid 를 알린다", paid.fired, [["shop.order.paid", { orderNo: "N1", userId: "u1", amount: 1000 }]]);
  eq("주문 행을 잠그고 읽는다 (취소와 줄을 선다)", paid.db.calls[0].includes("FOR UPDATE"), true);
  eq("끝나면 알림 완료를 기록한다 (개인결제 표시 + 완료 기록)", [paid.db.calls.length, doneMarks(paid)], [3, 1]);
  const failedRun = await run("paid", async () => { throw new Error("구독자 실패"); });
  eq("구독자가 실패하면 던지고 완료를 기록하지 않는다 (재처리 대상으로 남는다)", [!!failedRun.thrown, doneMarks(failedRun)], [true, 0]);
  for (const s of ["cancelled", "refunded"]) {
    const r = await run(s);
    eq(`그 사이 ${s} 됐으면 알리지 않는다 (취소된 주문이 적립을 가져가면 안 된다)`, r.fired, []);
    eq(`${s} 주문은 완료로 적어 재처리 대상에서 뺀다`, doneMarks(r), 1);
  }
  eq("주문이 없으면 아무것도 하지 않는다", (await run(null)).fired, []);
  const shipped = await run("shipped");
  eq("이미 발송까지 갔어도 결제 알림은 나간다", shipped.fired.length, 1);
}

// ── 결제 완료 알림 재처리 ──────────────────────
console.log("── sweepUnannouncedPaid");
{
  // 첫 응답은 대상 목록, 이어지는 응답은 announcePaid 의 주문 조회
  const db = fakeDb(
    [{ id: "a" }, { id: "b" }],
    [{ order_no: "NA", user_id: "u1", total: 100, status: "paid" }], [], [],
    [{ order_no: "NB", user_id: "u2", total: 200, status: "paid" }],
  );
  const fired = [];
  const warns = [];
  const deps = {
    db, logger: { warn: (m) => warns.push(m) }, notifyOrder: async () => {},
    hooks: { doActionOrThrow: async (h, p) => { if (p.orderNo === "NA") throw new Error("실패"); fired.push(p.orderNo); } },
  };
  const r = await sweepUnannouncedPaid(deps);
  eq("한 주문이 실패해도 나머지는 계속한다", [r.found, r.done, r.failed], [2, 1, 1]);
  eq("실패는 기록만 하고 던지지 않는다", warns.length, 1);
  const q = db.calls[0];
  eq("결제됐고 알림이 끝나지 않은 주문만 고른다", q.includes("paid_announced_at") && q.includes("paid_at IS NOT NULL"), true);
  eq("유예와 기간 창으로 원래 경로·영구 실패를 거른다", q.includes("minutes") && q.includes("days"), true);
}

// ── 포인트 돌려주기·거두기 ─────────────────────
console.log("── restoreOrderPoints");
{
  const mk = (withRevoke = true) => {
    const calls = [];
    return {
      calls,
      port: {
        balance: async () => 0, spend: async () => true,
        refund: async (p, tx) => { calls.push(["refund", p.refType, p.refId, p.reason, tx]); return 1; },
        ...(withRevoke ? { revoke: async (p, tx) => { calls.push(["revoke", p.refType, p.refId, p.reason, tx]); return 1; } } : {}),
      },
    };
  };
  const tx = { tag: "tx" };
  let m = mk();
  await restoreOrderPoints(m.port, { userId: "u1", orderNo: "N1", pointUsed: 500, cause: "취소" }, tx);
  eq("쓴 포인트를 돌려준 뒤에 적립을 거둔다 (순서)", m.calls.map((c) => c[0]), ["refund", "revoke"]);
  eq("같은 표지(shop.order)와 주문번호", m.calls.map((c) => [c[1], c[2]]), [["shop.order", "N1"], ["shop.order", "N1"]]);
  eq("트랜잭션을 그대로 넘긴다", m.calls.map((c) => c[4] === tx), [true, true]);
  eq("사유에 원인이 남는다", m.calls.map((c) => c[3]), ["주문 취소 포인트 반환 (N1)", "주문 취소로 구매 적립 회수 (N1)"]);
  m = mk();
  await restoreOrderPoints(m.port, { userId: "u1", orderNo: "N2", pointUsed: 0, cause: "반품" });
  eq("쓴 포인트가 없으면 돌려주지 않고 거두기만", m.calls.map((c) => c[0]), ["revoke"]);
  eq("조사가 받침을 따른다 (반품으로)", m.calls[0]?.[3], "주문 반품으로 구매 적립 회수 (N2)");
  m = mk();
  await restoreOrderPoints(m.port, { userId: "u1", orderNo: "N3", pointUsed: 10, cause: "환불" });
  eq("조사가 ㄹ 받침은 로 (환불로)", m.calls[1]?.[3], "주문 환불로 구매 적립 회수 (N3)");
  m = mk(false);
  await restoreOrderPoints(m.port, { userId: "u1", orderNo: "N4", pointUsed: 10, cause: "취소" });
  eq("거두기를 모르는 옛 포인트 서비스여도 취소는 실패하지 않는다", m.calls.map((c) => c[0]), ["refund"]);
  m = mk();
  await restoreOrderPoints(null, { userId: "u1", orderNo: "N5", pointUsed: 10, cause: "취소" });
  await restoreOrderPoints(m.port, { userId: null, orderNo: "N5", pointUsed: 10, cause: "취소" });
  eq("포인트 서비스가 없거나 비회원 주문이면 아무것도 하지 않는다", m.calls, []);
}

// ── 비밀글 읽기 ────────────────────────────────
console.log("── canReadSecret");
{
  const keys = [];
  const checkFor = (postId) => async (pw, hash) => { keys.push(postId); return pw === "rightpw" && hash === "ROOTHASH"; };
  const reply = { id: "reply1", threadId: "root1", authorId: "admin1", guestPasswordHash: null, isSecret: true };
  const rootRow = (over = {}) => [{ author_id: null, guest_password: "ROOTHASH", ...over }];

  eq("비밀글이 아니면 누구나", await canReadSecret({ ...reply, isSecret: false }, null, undefined, checkFor), true);
  eq("운영진은 DB 없이 통과", await canReadSecret(reply, { id: "m", role: "manager", displayName: "m" }, undefined, checkFor), true);
  eq("답변글이면 원글 작성자(회원)도 읽는다", await canReadSecret(reply, { id: "u1", role: "member", displayName: "u" }, undefined, checkFor, fakeDb(rootRow({ author_id: "u1" }))), true);
  eq("다른 회원은 못 읽는다", await canReadSecret(reply, { id: "u2", role: "member", displayName: "u" }, undefined, checkFor, fakeDb(rootRow({ author_id: "u1" }))), false);
  eq("DB 를 안 주면 원글을 찾지 않는다", await canReadSecret(reply, { id: "u1", role: "member", displayName: "u" }, undefined, checkFor), false);
  keys.length = 0;
  eq("비회원 원글은 원글의 비밀번호로 연다", await canReadSecret(reply, null, "rightpw", checkFor, fakeDb(rootRow())), true);
  eq("그 비밀번호 확인은 **원글의 시도 횟수 키**로 한다 (답변마다 새 몫이 생기면 안 된다)", keys, ["root1"]);
  keys.length = 0;
  await canReadSecret({ id: "g1", threadId: "g1", authorId: null, guestPasswordHash: "H", isSecret: true }, null, "x", checkFor);
  eq("비회원 글 자신의 확인은 자기 키", keys, ["g1"]);
  eq("비밀번호를 안 내면 확인하지 않고 거절", await canReadSecret(reply, null, undefined, checkFor, fakeDb(rootRow())), false);
  eq("회원 전용 판정은 비회원 비밀번호를 받지 않는다", await canReadSecretAsMember(reply, null, fakeDb(rootRow())), false);
  eq("행 → 판정 입력 (스네이크 열, 첨부 행은 post_id)",
    secretPostRef({ id: "att1", post_id: "p9", thread_id: "t9", author_id: "a9", guest_password: "h", is_secret: true }, "post_id"),
    { id: "p9", threadId: "t9", authorId: "a9", guestPasswordHash: "h", isSecret: true });
}

// ── 글 지우기 ──────────────────────────────────
console.log("── deletePosts");
{
  const replies = () => [[{ id: "c1", author_id: "u2" }, { id: "c2", author_id: null }], [{ storage_key: "k1", thumb_key: "t1" }], [{ id: "p1", author_id: "u1" }, { id: "p2", author_id: null }]];
  const mk = () => {
    const log = { files: [], hooks: [] };
    return { log, deps: { storage: { delete: async (k) => { log.files.push(k); } }, hooks: { doAction: async (h, p) => { log.hooks.push([h, p]); } } } };
  };
  let m = mk();
  const n = await deletePosts(fakeDb(...replies()), m.deps, ["p1", "p2"]);
  eq("지운 글 수", n, 2);
  eq("바로 지울 때: 파일을 지운다", m.log.files, ["k1", "t1"]);
  eq("바로 지울 때: 회원 글·회원 댓글만 알린다 (비회원은 적립이 없다)", m.log.hooks, [
    ["board.post.deleted", { postId: "p1", authorId: "u1" }],
    ["board.comment.deleted", { commentId: "c1", authorId: "u2" }],
  ]);
  m = mk();
  const later = [];
  await deletePosts(fakeDb(...replies()), m.deps, ["p1", "p2"], { afterCommit: (fn) => later.push(fn) });
  eq("트랜잭션 안에서는 파일도 알림도 아직 일어나지 않는다", [m.log.files, m.log.hooks], [[], []]);
  eq("커밋 뒤에 실행할 일이 하나 맡겨진다", later.length, 1);
  await later[0]?.();
  eq("커밋 뒤에 파일을 지운다", m.log.files, ["k1", "t1"]);
  eq("커밋 뒤에 알린다", m.log.hooks.length, 2);
  eq("글이 없으면 아무것도 하지 않는다", await deletePosts(fakeDb(), mk().deps, []), 0);
}

console.log(bad ? `\n${bad}개 실패` : "\n모두 맞습니다.");
process.exit(bad ? 1 : 0);
