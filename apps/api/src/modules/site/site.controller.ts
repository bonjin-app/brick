import {
  BadRequestException, Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { BrickDb } from "@brick/database";
import { menus, pages, siteSettings } from "@brick/database";
import type { CacheProvider, HookBus } from "@brick/core";
import { AVAILABLE_LOCALES, normalizeLocale } from "@brick/core";
import { AdminGuard } from "../auth/auth.guard.js";
import { ipAllowed, parseAllowlist } from "../auth/ip-allowlist.js";
import { ModerationService } from "../moderation/moderation.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CACHE, DB, HOOKS } from "../../runtime.module.js";
import {
  EMPTY_BUSINESS_INFO, FIELD_LABEL, isCommerceReady, validateBusinessInfo,
  type BusinessInfo,
} from "./business-info.js";

interface MenuItem {
  label: string;
  url: string;
  children?: MenuItem[];
}

/** 관리자가 편집할 수 있는 사이트 설정 화이트리스트 */
const EDITABLE_SETTINGS: Record<string, "string" | "boolean"> = {
  "site.name": "string",
  "site.description": "string",
  "site.registration_open": "boolean",
  // 검색 노출 차단 — robots.txt 가 읽는다 (SeoService)
  "site.seo_noindex": "boolean",
  // 관리자·운영자에게 2단계 인증을 요구한다.
  // 켜면 그 역할은 스스로 해제할 수 없다 — 해제할 수 있으면 강제가 아니다.
  "security.require_2fa_for_staff": "boolean",
  // 플러그인 레지스트리 주소. 비우면 공식 레지스트리.
  // 주소 안전성(https 강제 등)은 읽는 쪽(ExtensionUpdaterService)이 검사한다.
  "extensions.registry_url": "string",
  // 관리자 IP 허용목록 (쉼표/줄바꿈 구분, IPv4/CIDR/IPv6). 비우면 제한 없음.
  // 저장 시 아래 putSettings 가 자기잠금을 막는다.
  "security.admin_ip_allowlist": "string",
  // 사이트 언어 — 공개 화면(테마·404 등)의 문자열이 이것을 따른다. 기본 ko.
  "site.locale": "string",
  // 닉네임(표시 이름) 변경 주기(일). "0" 이면 제한 없음. 그누보드의 닉네임 변경 제한 —
  // 이름을 자주 바꿔 글의 책임을 흐리는 것을 막는다. 숫자 검증은 읽는 쪽(users.controller)이 한다.
  "member.nick_change_days": "string",
  // 모더레이션 (그누보드 기본 설정 동등성) — 줄바꿈/쉼표 구분 목록
  "moderation.banned_words": "string",         // 글·댓글·쪽지·이름에 못 쓰는 단어
  "moderation.denied_names": "string",         // 닉네임 금지 목록 (기본: admin·관리자·운영자 등은 항상)
  "moderation.denied_email_domains": "string", // 가입 금지 이메일 도메인
  "security.blocked_ips": "string",            // 접속 차단 IP (IPv4·CIDR·IPv6). 저장 시 자기잠금을 막는다
};

/** 사업자정보를 담는 설정 키 (단일 JSON) */
const BUSINESS_KEY = "site.business_info";

@Controller("api")
export class SiteController {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(CACHE) private readonly cache: CacheProvider,
    @Inject(HOOKS) private readonly hooks: HookBus,
    private readonly audit: AuditService,
    private readonly moderation: ModerationService,
  ) {}

  /** 사이트 언어 — **공개**. 로그인·가입 화면이 첫 페인트에 쓴다 */
  @Get("i18n")
  async i18n() {
    // 사이트명도 함께 준다 — 로그인·가입 화면이 사이트 이름을 보여주는 데
    // 쓴다 (요청 하나로: 언어와 이름은 같은 화면이 같은 시점에 필요로 한다)
    const rows = await this.db
      .select().from(siteSettings)
      .where(inArray(siteSettings.key, ["site.locale", "site.name"]));
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    return {
      locale: normalizeLocale(get("site.locale")),
      siteName: String(get("site.name") ?? "Brick"),
    };
  }

  // ── 사이트 설정 ────────────────────────────────────
  @Get("settings")
  @UseGuards(AdminGuard)
  async getSettings() {
    const rows = await this.db.select().from(siteSettings);
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      // 플러그인 전용 설정은 관리자 일반 화면에 노출하지 않는다
      if (!row.key.startsWith("plugin:")) out[row.key] = row.value;
    }
    return out;
  }

  /**
   * 사업자정보 조회 — **공개**다.
   *
   * 전자상거래법 제13조는 소비자가 쉽게 알 수 있도록 표시하라고 정한다.
   * 관리자만 볼 수 있으면 표시 의무를 지키는 것이 아니다.
   * 테마가 푸터에 렌더하지만, 별도 화면(사업자정보 페이지)을 만들 수도 있으므로
   * API 로도 낸다.
   */
  @Get("business-info")
  async getBusinessInfo() {
    const info = await this.readBusinessInfo();
    const status = isCommerceReady(info);
    return {
      info,
      labels: FIELD_LABEL,
      // 관리 화면이 "쇼핑몰을 열 수 있는 상태인가"를 알려주는 데 쓴다
      commerceReady: status.ready,
      missing: status.missing,
    };
  }

  @Put("business-info")
  @UseGuards(AdminGuard)
  async putBusinessInfo(
    @Body() body: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ) {
    const { info, errors, warnings } = validateBusinessInfo(body ?? {});
    if (errors.length) throw new BadRequestException(errors.join(" "));

    await this.db
      .insert(siteSettings)
      .values({ key: BUSINESS_KEY, value: info as never })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: info as never, updatedAt: new Date() },
      });

    // 푸터에 렌더되므로 모든 페이지 캐시를 비운다
    await this.cache.invalidateTag("pages");
    await this.audit.fromRequest(req as never, {
      action: "settings.business_info", targetType: "settings",
      summary: info.companyName || "(상호 없음)",
    });

    const status = isCommerceReady(info);
    return { ok: true, warnings, commerceReady: status.ready, missing: status.missing };
  }

  private async readBusinessInfo(): Promise<BusinessInfo> {
    const [row] = await this.db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.key, BUSINESS_KEY))
      .limit(1);
    return { ...EMPTY_BUSINESS_INFO, ...((row?.value as Partial<BusinessInfo>) ?? {}) };
  }

  @Put("settings")
  @UseGuards(AdminGuard)
  async putSettings(@Body() body: Record<string, unknown>, @Req() req: FastifyRequest) {
    for (const [key, value] of Object.entries(body ?? {})) {
      const type = EDITABLE_SETTINGS[key];
      if (!type) throw new BadRequestException(`수정할 수 없는 설정입니다: ${key}`);
      if (type === "string" && typeof value !== "string") throw new BadRequestException(`${key}: 문자열이어야 합니다.`);
      if (type === "boolean" && typeof value !== "boolean") throw new BadRequestException(`${key}: true/false여야 합니다.`);

      // 언어는 지원 목록만 받는다 — 없는 언어를 저장하면 "설정했는데 그대로
      // 한국어"인 반쪽 상태가 된다. 거절하고 목록을 알려주는 것이 맞다.
      if (key === "site.locale" && !(AVAILABLE_LOCALES as readonly string[]).includes(String(value))) {
        throw new BadRequestException(
          `지원하지 않는 언어입니다: ${String(value)} (지원: ${AVAILABLE_LOCALES.join(", ")})`,
        );
      }

      // 관리자 IP 제한 — 형식 오류와 **자기잠금**을 저장 시점에 막는다.
      // 지금 접속한 IP 가 목록에 없으면 저장하는 순간 자신이 잠긴다.
      if (key === "security.admin_ip_allowlist" && String(value).trim() !== "") {
        const parsed = parseAllowlist(String(value));
        if (parsed.invalid.length) {
          throw new BadRequestException(
            `IP 형식이 올바르지 않습니다: ${parsed.invalid.join(", ")} ` +
              `(IPv4, IPv4 CIDR, IPv6 단일 주소만 받습니다)`,
          );
        }
        if (!ipAllowed(req.ip, String(value))) {
          throw new BadRequestException(
            `지금 접속한 IP(${req.ip})가 목록에 없습니다 — 저장하면 스스로 잠깁니다. ` +
              `현재 IP 를 목록에 추가해주세요.`,
          );
        }
      }
      // 접속 차단 IP — 형식과 **자기잠금**을 저장 시점에 막는다. 지금 접속한 IP 를 차단하면
      // 저장하는 순간 관리자 자신이 403 을 본다.
      if (key === "security.blocked_ips" && String(value).trim() !== "") {
        const parsed = parseAllowlist(String(value));
        if (parsed.invalid.length) {
          throw new BadRequestException(`IP 형식이 올바르지 않습니다: ${parsed.invalid.join(", ")}`);
        }
        if (ipAllowed(req.ip, String(value))) {
          throw new BadRequestException(`지금 접속한 IP(${req.ip})가 차단 목록에 있습니다 — 저장하면 스스로 차단됩니다.`);
        }
      }
      await this.db
        .insert(siteSettings)
        .values({ key, value: value as never })
        .onConflictDoUpdate({ target: siteSettings.key, set: { value: value as never, updatedAt: new Date() } });
    }
    this.moderation.invalidate(); // 금지 단어·차단 IP 는 다음 요청부터 바로
    await this.cache.invalidateTag("pages"); // 사이트명 등이 모든 페이지에 렌더된다
    // 언어 등 설정 캐시를 가진 쪽(플러그인 로더)이 즉시 새로 읽게 알린다
    await this.hooks.doAction("site.settings_changed", { keys: Object.keys(body ?? {}) });
    await this.audit.fromRequest(req as never, {
      action: "settings.update", targetType: "settings",
      summary: Object.keys(body ?? {}).join(", "),
    });
    return { ok: true };
  }

  // ── 메뉴 ──────────────────────────────────────────
  @Get("menus/:location")
  async getMenu(@Param("location") location: string) {
    const [row] = await this.db.select().from(menus).where(eq(menus.location, location)).limit(1);
    return { location, items: (row?.items ?? []) as MenuItem[] };
  }

  @Put("menus/:location")
  @UseGuards(AdminGuard)
  async putMenu(
    @Param("location") location: string,
    @Body() body: { items: MenuItem[] },
    @Req() req: FastifyRequest,
  ) {
    const items = this.validateItems(body?.items ?? [], 0);
    const [existing] = await this.db.select().from(menus).where(eq(menus.location, location)).limit(1);
    if (existing) {
      await this.db.update(menus).set({ items: items as never, updatedAt: new Date() }).where(eq(menus.id, existing.id));
    } else {
      await this.db.insert(menus).values({ id: uuidv7(), location, items: items as never });
    }
    await this.cache.invalidateTag("pages");
    await this.audit.fromRequest(req as never, {
      action: "menu.update", targetType: "menu", targetId: location,
      summary: `${items.length}개 항목`,
    });
    return { ok: true };
  }

  private validateItems(items: MenuItem[], depth: number): MenuItem[] {
    if (depth > 2) throw new BadRequestException("메뉴는 3단계까지만 지원합니다.");
    if (items.length > 50) throw new BadRequestException("메뉴 항목이 너무 많습니다.");
    return items.map((item) => {
      const label = String(item?.label ?? "").trim();
      const url = String(item?.url ?? "").trim();
      if (!label) throw new BadRequestException("메뉴 이름은 필수입니다.");
      // javascript: 등 위험한 스킴 차단
      if (!/^(\/|https?:\/\/|#)/.test(url)) throw new BadRequestException(`허용되지 않는 주소입니다: ${url}`);
      return {
        label: label.slice(0, 100),
        url: url.slice(0, 500),
        ...(item.children?.length ? { children: this.validateItems(item.children, depth + 1) } : {}),
      };
    });
  }

}
