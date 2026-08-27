import { Inject, Injectable, BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { createHash } from "node:crypto";
import type { BrickDb } from "@brick/database";
import { DB } from "../../runtime.module.js";

/**
 * 약관과 동의 이력.
 *
 * 왜 코어에 있는가:
 *   회원가입이 코어 기능이고, 가입은 동의 없이 완료될 수 없다.
 *   플러그인으로 두면 플러그인을 끄는 순간 법적 요건이 사라진다.
 *
 * 왜 버전을 관리하는가:
 *   "동의받았다"를 증명할 책임은 사업자에게 있다. 약관을 고쳐 쓰면 그 사람이
 *   동의한 문서가 무엇이었는지 알 수 없게 된다. 그래서 개정은 새 버전이고,
 *   이전 버전은 지우지 않는다.
 */

export type AgreementKind = "terms" | "privacy" | "marketing" | "third_party";

export const AGREEMENT_KINDS: AgreementKind[] = ["terms", "privacy", "marketing", "third_party"];

export const KIND_LABEL: Record<AgreementKind, string> = {
  terms: "이용약관",
  privacy: "개인정보 수집·이용",
  marketing: "광고성 정보 수신",
  third_party: "제3자 제공",
};

export interface ActiveAgreement {
  id: string;
  kind: AgreementKind;
  version: number;
  title: string;
  body: string;
  isRequired: boolean;
}

@Injectable()
export class AgreementsService {
  constructor(@Inject(DB) private readonly db: BrickDb) {}

  /**
   * 지금 발효 중인 약관들.
   *
   * 종류별로 effective_at 이 지난 것 중 가장 높은 버전 하나씩.
   * 미래 날짜로 만들어두면 그 시점부터 자동으로 바뀐다(예약 개정).
   */
  async listActive(): Promise<ActiveAgreement[]> {
    const { rows } = await this.db.execute(sql`
      SELECT DISTINCT ON (kind) id, kind, version, title, body, is_required
      FROM agreements
      WHERE effective_at <= now()
      ORDER BY kind, version DESC
    `);
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as AgreementKind,
      version: Number(r.version),
      title: String(r.title),
      body: String(r.body),
      isRequired: r.is_required === true,
    }));
  }

  /**
   * 가입 시 받은 동의를 검증하고 기록한다.
   *
   * 두 가지를 막는다:
   *  - 필수 항목에 동의하지 않은 가입 (거부)
   *  - 선택 항목을 필수처럼 강제하는 것 (선택은 false 여도 통과시킨다)
   *
   * @param accepted 클라이언트가 보낸 동의 목록 (kind → 동의 여부)
   * @returns 광고 수신 동의 여부 (users.marketing_opt_in 에 반영)
   */
  async recordForUser(
    tx: BrickDb,
    params: { userId: string; accepted: Record<string, boolean>; ip?: string | null },
  ): Promise<{ marketingOptIn: boolean }> {
    const active = await this.listActive();
    const ipHash = params.ip ? hashIp(params.ip) : null;
    let marketingOptIn = false;

    for (const item of active) {
      const agreed = params.accepted?.[item.kind] === true;

      if (item.isRequired && !agreed) {
        throw new BadRequestException(`${item.title}에 동의해야 가입할 수 있습니다.`);
      }
      if (item.kind === "marketing" && agreed) marketingOptIn = true;

      // 거부한 선택 항목도 기록한다 — "물어봤고 거부했다"가 남아야
      // 나중에 마케팅 발송 여부를 판단하고 증명할 수 있다
      await tx.execute(sql`
        INSERT INTO user_agreements (id, user_id, agreement_id, kind, version, agreed, ip_hash)
        VALUES (${uuidv7()}, ${params.userId}::uuid, ${item.id}::uuid,
                ${item.kind}, ${item.version}, ${agreed}, ${ipHash})
      `);
    }

    return { marketingOptIn };
  }

  /**
   * 이 회원이 다시 동의해야 하는 약관이 있는가.
   *
   * 약관이 개정되면 기존 회원은 새 버전에 동의한 기록이 없다.
   * 필수 항목만 본다 — 선택 항목의 개정으로 로그인을 막을 수는 없다.
   */
  async pendingFor(userId: string): Promise<ActiveAgreement[]> {
    const active = await this.listActive();
    if (!active.length) return [];

    const { rows } = await this.db.execute(sql`
      SELECT kind, version FROM user_agreements
      WHERE user_id = ${userId}::uuid AND agreed = true
    `);
    const agreed = new Set(rows.map((r) => `${r.kind}:${Number(r.version)}`));

    return active.filter((a) => a.isRequired && !agreed.has(`${a.kind}:${a.version}`));
  }

  /** 개정된 약관에 다시 동의 */
  async acceptPending(
    params: { userId: string; accepted: Record<string, boolean>; ip?: string | null },
  ): Promise<void> {
    const pending = await this.pendingFor(params.userId);
    if (!pending.length) return;

    const ipHash = params.ip ? hashIp(params.ip) : null;
    for (const item of pending) {
      if (params.accepted?.[item.kind] !== true) {
        throw new BadRequestException(`${item.title}에 동의해야 계속 이용할 수 있습니다.`);
      }
      await this.db.execute(sql`
        INSERT INTO user_agreements (id, user_id, agreement_id, kind, version, agreed, ip_hash)
        VALUES (${uuidv7()}, ${params.userId}::uuid, ${item.id}::uuid,
                ${item.kind}, ${item.version}, true, ${ipHash})
      `);
    }
  }

  /** 내 동의 이력 (내 정보 화면에서 보여준다) */
  async historyFor(userId: string) {
    const { rows } = await this.db.execute(sql`
      SELECT ua.kind, ua.version, ua.agreed, ua.agreed_at, a.title
      FROM user_agreements ua
      JOIN agreements a ON a.id = ua.agreement_id
      WHERE ua.user_id = ${userId}::uuid
      ORDER BY ua.agreed_at DESC
    `);
    return rows;
  }

  // ── 관리자 ────────────────────────────────────────

  async listAll() {
    const { rows } = await this.db.execute(sql`
      SELECT a.id, a.kind, a.version, a.title, a.is_required, a.effective_at, a.created_at,
             (SELECT count(*) FROM user_agreements ua WHERE ua.agreement_id = a.id AND ua.agreed) AS agreed_count
      FROM agreements a ORDER BY a.kind, a.version DESC
    `);
    return rows;
  }

  async getOne(id: string) {
    const { rows } = await this.db.execute(sql`
      SELECT id, kind, version, title, body, is_required, effective_at FROM agreements
      WHERE id = ${id}::uuid LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * 약관 개정 = 새 버전 추가.
   *
   * 기존 행을 고치지 않는다. 이미 동의한 사람들이 무엇에 동의했는지가
   * 사라지면 동의 이력이 아무것도 증명하지 못한다.
   */
  async publishRevision(params: {
    kind: string;
    title: string;
    body: string;
    isRequired: boolean;
    effectiveAt?: string | null;
  }): Promise<{ id: string; version: number }> {
    const kind = String(params.kind);
    if (!AGREEMENT_KINDS.includes(kind as AgreementKind)) {
      throw new BadRequestException("약관 종류가 올바르지 않습니다.");
    }
    const title = String(params.title ?? "").trim();
    const body = String(params.body ?? "").trim();
    if (!title) throw new BadRequestException("약관 제목을 입력해주세요.");
    if (!body) throw new BadRequestException("약관 본문을 입력해주세요.");

    // 개인정보·이용약관은 선택으로 만들 수 없다.
    // 필수 동의 없이 개인정보를 수집하는 설정을 실수로 만들지 못하게 막는다.
    const isRequired =
      kind === "terms" || kind === "privacy" ? true : params.isRequired === true;

    const { rows: last } = await this.db.execute(sql`
      SELECT coalesce(max(version), 0) AS v FROM agreements WHERE kind = ${kind}
    `);
    const version = Number(last[0]?.v ?? 0) + 1;
    const id = uuidv7();

    await this.db.execute(sql`
      INSERT INTO agreements (id, kind, version, title, body, is_required, effective_at)
      VALUES (${id}, ${kind}, ${version}, ${title}, ${body}, ${isRequired},
              ${params.effectiveAt ? new Date(params.effectiveAt) : sql`now()`})
    `);
    return { id, version };
  }
}

/**
 * IP 해시 — 원문을 남기지 않는다.
 * 방문자 집계와 같은 원칙(ADR-35). 동의 시점의 접속지를 확인할 필요가 있을 때
 * "이 IP가 맞는지"는 대조로 답할 수 있고, 목록으로 뽑아볼 필요는 없다.
 */
function hashIp(ip: string): string {
  return createHash("sha256").update(`agreement:${ip}`).digest("hex").slice(0, 64);
}
