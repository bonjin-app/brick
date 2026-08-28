import {
  BadRequestException, Body, Controller, Post, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuditService } from "../audit/audit.service.js";
import { MigrateService } from "./migrate.service.js";
import { DEFAULT_LEVEL_MAPPING, type LevelMapping, type MigratePlan } from "./gnuboard-map.js";

/**
 * 그누보드 데이터 이전.
 *
 * 덤프를 **업로드**해서 처리한다. 원격 MySQL 접속을 전제하지 않는 이유:
 * 공유 호스팅은 외부 접속을 막는 경우가 대부분이고, 사용자가 실제로 손에 넣을
 * 수 있는 것은 phpMyAdmin 내보내기 파일이다.
 *
 * 반드시 analyze 를 먼저 부르게 되어 있지 않다(강제할 방법이 없다).
 * 대신 run 응답이 무엇을 했는지 상세히 돌려주고, 감사 로그에 남긴다.
 */
@Controller("api/admin/migrate")
@UseGuards(AdminGuard)
export class MigrateController {
  constructor(
    private readonly migrate: MigrateService,
    private readonly audit: AuditService,
  ) {}

  /** 리허설 — 아무것도 쓰지 않고 무엇이 옮겨질지 보고한다 */
  @Post("analyze")
  async analyze(@Body() body: { dump?: string; levelMapping?: LevelMapping }) {
    const dump = readDump(body?.dump);
    return await this.migrate.analyze(dump, normalizeMapping(body?.levelMapping));
  }

  @Post("run")
  async run(
    @Req() req: FastifyRequest & { user: { id: string } },
    @Body() body: {
      dump?: string;
      prefix?: string;
      levelMapping?: LevelMapping;
      boards?: string[];
      members?: boolean;
      points?: boolean;
      shop?: boolean;
    },
  ) {
    const dump = readDump(body?.dump);
    const plan: MigratePlan = {
      prefix: String(body?.prefix ?? ""),
      levelMapping: normalizeMapping(body?.levelMapping),
      boards: Array.isArray(body?.boards) ? body.boards.map(String) : [],
      members: body?.members !== false,
      points: body?.points !== false,
      shop: body?.shop !== false,
      strictEmail: false,
    };

    const result = await this.migrate.run(dump, plan);

    await this.audit.record({
      action: "migrate.gnuboard",
      summary:
        `회원 ${result.members.created} · 게시판 ${result.boards.created} · ` +
        `글 ${result.posts.created} · 댓글 ${result.comments.created} · ` +
        `상품 ${result.shop.products} · 주문 ${result.shop.orders}`,
      ip: req.ip,
    });
    return result;
  }
}

/**
 * 덤프 본문 검증.
 *
 * 크기 상한을 둔다. 수백 MB 를 JSON 본문으로 받으면 메모리가 터지고,
 * 그 경우 CLI 로 안내하는 것이 맞다(문서에 적었다).
 */
const MAX_DUMP_BYTES = 64 * 1024 * 1024;

function readDump(raw: unknown): string {
  const dump = String(raw ?? "");
  if (!dump.trim()) {
    throw new BadRequestException("덤프 내용이 비어 있습니다.");
  }
  if (Buffer.byteLength(dump, "utf8") > MAX_DUMP_BYTES) {
    throw new BadRequestException(
      "덤프가 64MB를 넘습니다. 큰 덤프는 서버에서 CLI로 처리해주세요 " +
        "(docs/migrate-gnuboard.md 참고).",
    );
  }
  return dump;
}

function normalizeMapping(raw: LevelMapping | undefined): LevelMapping {
  const adminFrom = clampLevel(raw?.adminFrom, DEFAULT_LEVEL_MAPPING.adminFrom);
  const managerFrom = clampLevel(raw?.managerFrom, DEFAULT_LEVEL_MAPPING.managerFrom);
  // manager 경계가 admin 보다 높으면 manager 가 아무도 없게 된다 —
  // 조용히 이상한 결과를 만들지 않고 바로잡는다
  return { adminFrom, managerFrom: Math.min(managerFrom, adminFrom) };
}

function clampLevel(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : fallback;
}
