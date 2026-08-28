import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AdminGuard } from "../auth/auth.guard.js";
import { AuthService } from "../auth/auth.service.js";
import { SearchService } from "./search.service.js";

@Controller("api")
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly auth: AuthService,
  ) {}

  /** 화면의 분류 탭 — 켜진 플러그인에 따라 달라진다 */
  @Get("search/scopes")
  scopes() {
    return { items: this.search.scopes() };
  }

  /**
   * 통합검색.
   *
   * 로그인 여부에 따라 결과가 달라진다 — 회원만 읽는 게시판, 자기 문의 등.
   * 그래서 세션을 해석해 공급자에게 넘긴다.
   */
  @Get("search")
  async doSearch(
    @Req() req: FastifyRequest,
    @Query("q") q?: string,
    @Query("scope") scope?: string,
    @Query("page") page?: string,
  ) {
    const user = await this.auth.resolveFromRequest(req);
    return this.search.search({
      raw: q ?? "",
      scope: scope || undefined,
      page: Number(page ?? 1),
      viewer: user ? { id: user.id, role: user.role } : null,
      ip: req.ip,
    });
  }

  /**
   * 인기 검색어 — 공개.
   *
   * 화면에 노출하는 값이므로 차단 규칙이 걸린 것은 서비스가 제외한다.
   */
  @Get("search/popular")
  async popular(@Query("days") days?: string, @Query("limit") limit?: string) {
    return {
      items: await this.search.popular({
        days: Number(days ?? 7),
        limit: Number(limit ?? 10),
      }),
    };
  }

  // ── 운영자용 ──────────────────────────────────────

  /**
   * 결과 0건 검색어.
   *
   * 공개하지 않는다 — 손님이 무엇을 찾았는지는 운영 정보이고, 검색어 자체가
   * 민감할 수 있다.
   */
  @Get("admin/search/no-results")
  @UseGuards(AdminGuard)
  async noResults(@Query("days") days?: string, @Query("limit") limit?: string) {
    return {
      items: await this.search.noResults({
        days: Number(days ?? 30),
        limit: Number(limit ?? 50),
      }),
      hint:
        "손님이 찾았는데 결과가 없던 검색어입니다. 상품·안내가 빠졌거나, " +
        "부르는 이름이 달라서 못 찾은 것입니다(치환 규칙으로 연결할 수 있습니다).",
    };
  }

  @Get("admin/search/rules")
  @UseGuards(AdminGuard)
  async rules() {
    return { items: await this.search.listRules() };
  }

  @Post("admin/search/rules")
  @UseGuards(AdminGuard)
  async upsertRule(
    @Body() body: { term?: string; kind?: string; replacement?: string; note?: string },
  ) {
    try {
      return await this.search.upsertRule({
        term: String(body?.term ?? ""),
        kind: String(body?.kind ?? ""),
        replacement: body?.replacement,
        note: body?.note,
      });
    } catch (err) {
      // 서비스가 던지는 것은 입력 오류다 — 500 으로 보내면 원인을 알 수 없다
      throw new BadRequestException(err instanceof Error ? err.message : "잘못된 요청입니다.");
    }
  }

  @Delete("admin/search/rules/:id")
  @UseGuards(AdminGuard)
  async deleteRule(@Param("id") id: string) {
    return this.search.deleteRule(id);
  }
}
