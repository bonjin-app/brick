import {
  All, BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, Inject, Logger,
  NotFoundException, Param, Post, Req, Res, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { siteSettings, type BrickDb } from "@brick/database";
import type { MailProvider, QueueProvider } from "@brick/core";
import { SITE_TZ, isRawResponse, rankOf, translateCoreLabel, type PluginUploadedFile } from "@brick/core";
import { PluginLoaderService } from "./plugin-loader.service.js";
import { AdminGuard, ManagerGuard } from "../auth/auth.guard.js";
import { IdentityService } from "../identity/identity.service.js";
import { AuthService } from "../auth/auth.service.js";
import { ExtensionInstallerService } from "../extensions/extension-installer.service.js";
import { ExtensionUpdaterService } from "../extensions/extension-updater.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CORE_CATALOGS, makeTranslator } from "@brick/core";
import { ThemesService } from "../themes/themes.service.js";
import { MaintenanceModeService } from "../site/maintenance-mode.service.js";
import { bypassesMaintenance, isWrite } from "../site/maintenance-mode.js";
import { DB, MAIL, QUEUE } from "../../runtime.module.js";
import { isLocalUrl, loadEnv } from "../../config/env.js";
import { sawProxyHeaders } from "../../config/proxy-hint.js";
import { msg } from "../../common/localized-error.js";

@Controller("api")
export class PluginsController {
  private readonly logger = new Logger(PluginsController.name);
  constructor(
    private readonly loader: PluginLoaderService,
    private readonly auth: AuthService,
    private readonly installer: ExtensionInstallerService,
    private readonly updater: ExtensionUpdaterService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: BrickDb,
    @Inject(MAIL) private readonly mail: MailProvider,
    @Inject(QUEUE) private readonly queue: QueueProvider,
    private readonly themes: ThemesService,
    private readonly maintenance: MaintenanceModeService,
    private readonly identity: IdentityService,
  ) {}

  @Get("plugins")
  async list() {
    const manifests = await this.loader.discover();
    const failed = this.loader.failedPlugins();
    const rows = manifests.map((m) => ({
      ...m,
      isActive: this.loader.isActive(m.name),
      failed: failed.find((f) => f.name === m.name)?.message ?? null,
    }));
    /*
     * 파일이 사라진 플러그인은 `discover()` 에 잡히지 않는다 — 목록에서 **통째로
     * 없어진다.** 켜 두었던 쇼핑몰이 화면에서 사라지면 운영자는 자기가 지웠나
     * 의심하게 되고, 어디를 고쳐야 하는지 알 수 없다. 이름과 이유를 남긴다.
     */
    const vanished = failed
      .filter((f) => !manifests.some((m) => m.name === f.name))
      .map((f) => ({
        name: f.name,
        displayName: f.name,
        version: "",
        description: f.message,
        isActive: false,
        failed: f.message,
      }));
    return [...rows, ...vanished];
  }

  /** plugin.zip 업로드 설치 (관리자) */
  @Post("plugins/upload")
  @UseGuards(AdminGuard)
  async upload(@Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new BadRequestException("zip 파일을 선택해주세요.");
    const result = await this.installer.installPlugin(await file.toBuffer());
    // 업데이트인 경우(이미 활성) 새 버전으로 자동 재적재 — 새 마이그레이션이 여기서 적용된다
    await this.loader.reload(result.name);
    await this.audit.fromRequest(req as never, {
      action: "plugin.install",
      targetType: "plugin",
      targetId: result.name,
      summary: `${result.name}@${result.version} 업로드 설치`,
    });
    return { ...result, reloaded: this.loader.isActive(result.name) };
  }

  @Post("plugins/:name/activate")
  @UseGuards(AdminGuard)
  async activate(@Param("name") name: string, @Req() req: FastifyRequest) {
    await this.loader.activate(name);
    await this.audit.fromRequest(req as never, {
      action: "plugin.activate", targetType: "plugin", targetId: name, summary: `${name} 활성화`,
    });
    return { ok: true };
  }

  @Post("plugins/:name/deactivate")
  @UseGuards(AdminGuard)
  async deactivate(@Param("name") name: string, @Req() req: FastifyRequest) {
    await this.loader.deactivate(name);
    await this.audit.fromRequest(req as never, {
      action: "plugin.deactivate", targetType: "plugin", targetId: name, summary: `${name} 비활성화`,
    });
    return { ok: true };
  }

  /**
   * 플러그인이 registerRoute로 등록한 라우트 디스패치 (":param" 지원, 세션 사용자 주입).
   *
   * 두 경로를 모두 받는다 — `plugins/:name/*` 와 **뒤 경로가 없는**
   * `plugins/:name`. 플러그인은 자기 루트(`registerRoute("POST", "/")`)에
   * 등록할 수 있는데, 와일드카드만 있으면 그 라우트에 도달할 수 없다:
   * 클라이언트가 `/api/plugins/x/` 로 보내도 프록시·브라우저가 후행
   * 슬래시를 정규화해 `/api/plugins/x` 가 되고, 와일드카드는 최소 한
   * 세그먼트를 요구하므로 404 가 된다. 실제로 쪽지 발송(POST "/")이
   * **웹에서 항상 404** 였다 — API 직접 호출만 동작했다.
   */
  @All("plugins/:name")
  async dispatchRoot(
    @Param("name") name: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    return this.dispatch(name, req, reply, body);
  }

  @All("plugins/:name/*")
  async dispatch(
    @Param("name") name: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const url = req.url.split("?")[0];
    const match = this.loader.matchRoute(req.method, url);
    if (!match) throw new NotFoundException();
    // ctx.t 가 읽는 사이트 언어 캐시를 갱신한다 (TTL 이라 사실상 공짜)
    await this.loader.refreshLocale();
    const user = await this.auth.resolveFromRequest(req);

    /*
     * 관리 경로는 **규칙으로** 닫는다.
     *
     * 이 디스패처는 지금까지 아무 가드도 걸지 않았고, 플러그인의 관리 라우트
     * 마흔 개 남짓이 각자 첫 줄에서 역할을 확인하고 있었다. 지금은 전부 확인하지만,
     * 그것은 저자가 매번 기억한 결과다 — 한 번 잊으면 그 라우트는 그냥 열린다.
     * 상품·주문·쿠폰·회원 등급을 누구나 바꿀 수 있게 되는 종류의 실수다.
     *
     * 그래서 여기서 운영자(manager 이상)를 요구한다. 핸들러의 자기 검사는 그대로
     * 둔다 — admin 만 허용하는 라우트는 여기서 통과해도 자기 줄에서 막힌다.
     * 이 층은 더 느슨한 바닥이고, 잊었을 때 열리지 않게 하는 것이 목적이다.
     *
     * 403 으로 돌려준다 — 기존 플러그인 가드와 같은 응답이라야 화면과 스모크가
     * 같은 것을 본다(비로그인도 403 이다: 관리 경로의 존재를 알려줄 이유가 없다).
     */
    if (match.adminOnly && rankOf(user?.role) < rankOf("manager")) {
      throw new ForbiddenException("권한이 없습니다.");
    }
    /*
     * 권한 범위 — "이 운영자는 주문만". 여기 한 곳에서 막는다: 플러그인 라우트는 역할만 보고
     * (`admin` 또는 `manager`) 범위는 모른다. 저자마다 범위를 검사하게 하면 한 번 잊은 라우트로
     * 주문 담당이 상품 가격을 바꾼다.
     */
    if (match.adminOnly && user?.role === "manager" && Array.isArray(user.scopes)) {
      const inPlugin = url.slice(`/api/plugins/${name}`.length) || "/";
      if (!this.loader.scopeAllows(name, inPlugin, user.scopes)) {
        throw new ForbiddenException("이 관리 화면을 다룰 권한이 없습니다.");
      }
    }

    /*
     * 점검 중에는 **쓰기를 막는다.**
     *
     * 화면만 가리면 열어 둔 탭에서 댓글·주문이 계속 들어온다 — 복원 중에 들어온
     * 그 글이 정확히 사라지는 글이다. 읽기는 막지 않는다: 관리 화면이 이 API 로
     * 돌아가고, 점검 중에 운영자가 보는 것이 그 화면이다.
     */
    if (isWrite(req.method) && !bypassesMaintenance(user?.role) && (await this.maintenance.isOn())) {
      throw new ServiceUnavailableException(msg("err.maintenance"));
    }

    /*
     * 회원 본인인증 필수(사이트 설정) — 인증하지 않은 회원은 글·댓글·주문·장바구니 같은 **쓰기**를
     * 할 수 없다. 여기 한 곳에서 막는다: 플러그인마다 검사하게 하면 새 기능이 생길 때마다 뚫린다.
     * 읽기는 막지 않는다(둘러보고 인증하러 가는 길이 있어야 한다). 비회원·운영진·관리 경로는
     * 대상이 아니다. `field: identity` 로 화면이 본인인증 길을 붙인다.
     */
    if (isWrite(req.method) && !match.adminOnly && user?.role === "member" && (await this.identity.isRequired())) {
      if (!(await this.identity.status(user.id)).verified) {
        throw new ForbiddenException({ message: "이 사이트는 본인인증한 회원만 이용할 수 있습니다. 본인인증을 먼저 해주세요.", field: "identity" });
      }
    }

    try {
      const result = await match.handler({
        params: match.params,
        query: req.query as Record<string, string>,
        body,
        user,
        ip: req.ip,
        // 지연 로딩: 업로드를 받지 않는 라우트는 본문을 읽지 않는다
        files: () => this.readFiles(req),
      });

      // 플러그인이 원본 응답(RSS 등)을 돌려주면 content-type을 지정해 그대로 보낸다
      if (isRawResponse(result)) {
        reply.status(result.status ?? 200).header("content-type", result.contentType);
        for (const [key, value] of Object.entries(result.headers ?? {})) reply.header(key, value);
        return result.body;
      }
      return result;
    } catch (err) {
      // 플러그인이 { status } 를 가진 에러를 던지면 HTTP 상태코드로 매핑한다
      const status = (err as { status?: number })?.status;
      if (status && status >= 400 && status < 600) {
        /*
         * `field` 가 있으면 함께 보낸다 — 어느 입력이 문제인지 화면이 알아야 손님을 그
         * 칸으로 데려갈 수 있다. 긴 폼에서 "형식이 올바르지 않습니다"만 받으면 손님은
         * 여덟 칸을 하나씩 되짚어야 한다.
         */
        const field = (err as { field?: unknown })?.field;
        /*
         * 오류 메시지도 사이트 언어를 따른다.
         *
         * 플러그인은 오류를 한국어 문장으로 던진다("재고가 부족합니다."). 영어
         * 사이트에서도 그대로 나갔다 — 화면은 전부 영어인데 주문 버튼을 누르면
         * 한국어 경고가 뜨는, **가장 눈에 띄는 자리에서만 번역이 없는** 상태였다.
         * 선언 라벨과 같은 gettext 규칙을 쓴다: 원문이 곧 키이고, 번역이 없으면
         * 원문이 나간다(자연 폴백). 플러그인 코드는 한 줄도 바뀌지 않는다.
         *
         * 값이 박힌 문장(`재고가 3개 남았습니다`)은 원문과 키가 달라 걸리지
         * 않는다 — 그런 문장은 ctx.t 에 파라미터로 넘겨야 번역된다.
         */
        const message = this.loader.trCatalog(name, (err as Error).message);
        throw new HttpException(
          typeof field === "string" && field
            ? { statusCode: status, message, field }
            : message,
          status,
        );
      }
      throw err;
    }
  }

  /**
   * multipart 파일을 모두 읽는다.
   * multipart 요청이 아니면 빈 배열 — 플러그인이 분기하지 않아도 되게 한다.
   */
  private async readFiles(req: FastifyRequest): Promise<PluginUploadedFile[]> {
    if (!req.isMultipart?.()) return [];
    const out: PluginUploadedFile[] = [];
    for await (const part of req.files()) {
      out.push({
        fileName: part.filename ?? "untitled",
        contentType: part.mimetype ?? "application/octet-stream",
        buffer: await part.toBuffer(),
      });
    }
    return out;
  }

  /**
   * 관리자 내비게이션 — 플러그인이 등록한 메뉴와 리소스.
   * 코어 관리자 셸이 이걸 읽어 사이드바를 구성한다.
   *
   * **운영자(manager)도 읽는다.** 여기 실리는 것은 플러그인이 등록한 관리
   * 리소스뿐이고, 그 라우트들은 디스패처가 manager 까지 통과시킨다(위 참고).
   * 그런데 이 목록만 admin 으로 닫혀 있어서, 운영자는 **자기가 쓸 수 있는
   * 화면을 사이드바에서 찾을 수 없었다** — 게시판 관리도 주문 관리도 주소를
   * 외워야 닿았다. 권한은 있는데 길이 없으면 역할이 없는 것과 같다.
   */
  @Get("admin/nav")
  @UseGuards(ManagerGuard)
  async adminNav(@Req() req: FastifyRequest & { user?: { role: string; scopes?: string[] | null } }) {
    // 선언 라벨은 서빙 시점에 번역한다 (원문=키 — 로더 localizeAdminResource)
    await this.loader.refreshLocale();
    const isAdmin = req.user?.role === "admin";
    const scopes = !isAdmin && Array.isArray(req.user?.scopes) ? req.user!.scopes! : null;
    return {
      menus: this.loader.adminMenus.map((m) => this.loader.localizeAdminMenu(m)),
      resources: this.loader.adminResources
        .slice()
        // 관리자 전용으로 선언된 화면은 운영자에게 보여주지 않는다 —
        // 목록에 있는데 누르면 403 이면 목록이 거짓말을 하는 것이다
        .filter((r) => isAdmin || !r.adminOnly)
        // 범위가 있는 운영자에게는 받은 화면만 — 누르면 403 인 메뉴는 거짓말이다
        .filter((r) => !scopes || scopes.includes(r.plugin) || scopes.includes(`${r.plugin}/${r.name}`))
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        .map((r) => this.loader.localizeAdminResource(r.plugin, r))
        .map((r) => ({
          plugin: (r as { plugin: string }).plugin,
          name: r.name,
          title: r.title,
          itemLabel: r.itemLabel,
          order: r.order,
        })),
    };
  }

  /**
   * 관리자 대시보드 — "오늘의 사이트" 숫자들.
   *
   * 코어 통계(회원·페이지)와 플러그인 카드(registerDashboardCard)를 합친다.
   * 카드 하나가 실패해도 나머지는 나간다 — 플러그인 하나가 죽었다고
   * 대시보드 전체가 비면 운영자는 아무것도 볼 수 없다.
   */
  @Get("admin/dashboard")
  @UseGuards(AdminGuard)
  async adminDashboard() {
    const [core, cards, businessMissing, themeProblem, maintenanceOn, jobFailures] = await Promise.all([
      this.coreStats(),
      this.loader.collectDashboardCards(),
      this.businessInfoMissing(),
      this.themes.problem(),
      this.maintenance.isOn(),
      // 경고 하나 때문에 대시보드가 죽으면 안 된다
      this.queue.recentFailures(7).catch(() => []),
    ]);
    const setup = this.setupWarnings();
    /*
     * 켜 두었는데 돌지 않는 플러그인 — 볼륨이 안 붙었거나 경로가 어긋났다.
     *
     * 이것이야말로 "틀려도 아무 일도 일어나지 않는" 설정이다: 서버는 멀쩡히 뜨고,
     * 관리 화면도 열리고, **손님 쪽에서만** 상품과 게시판이 통째로 사라진다.
     */
    const failed = this.loader.failedPlugins();
    if (failed.length) {
      setup.push({
        id: "pluginNotRunning",
        docs: "https://github.com/bonjin-app/brick/blob/main/docs/plugin-development.md",
      });
    }
    /*
     * 활성 테마를 못 읽어 대체로 그리는 중 — 사이트는 나가지만 운영자가 고른
     * 디자인이 아니다. 500 으로 죽지 않으니 아무도 신고하지 않고, 운영자는
     * "왜 이렇게 허전하지" 하고 지나간다.
     */
    /*
     * 점검 모드가 켜져 있다.
     *
     * 이 기능의 진짜 위험은 켜는 것이 아니라 **끄는 것을 잊는 것**이다. 운영자는
     * 관리 화면으로 들어오므로 점검 화면을 보지 못한다 — 손님만 며칠째 503 을 본다.
     */
    if (maintenanceOn) {
      setup.push({
        id: "maintenanceOn",
        docs: "https://github.com/bonjin-app/brick/blob/main/docs/operations.md",
      });
    }
    if (themeProblem) {
      setup.push({
        id: "themeNotRendering",
        docs: "https://github.com/bonjin-app/brick/blob/main/docs/operations.md",
      });
    }
    /*
     * 백그라운드 작업이 끝내 실패했다 — 정기결제 청구, 재입고 알림, 메일 발송.
     *
     * 이것도 "틀려도 조용한" 종류다. 큐는 실패를 기록하고 로그에 한 줄 남기지만,
     * 운영자는 로그를 보지 않는다. 정기결제가 며칠째 청구되지 않아도 손님이 먼저 알고,
     * 운영자는 매출이 왜 줄었는지 나중에 찾는다.
     */
    if (jobFailures.length) {
      const total = jobFailures.reduce((n, f) => n + f.count, 0);
      setup.push({
        id: "jobsFailed",
        docs: "https://github.com/bonjin-app/brick/blob/main/docs/operations.md",
        params: {
          count: total,
          jobs: jobFailures.map((f) => f.name).join(", "),
          error: (jobFailures[0].lastError ?? "").split("\n")[0].slice(0, 160),
        },
      });
    }
    if (businessMissing) {
      setup.push({
        id: "businessInfoMissing",
        docs: "https://github.com/bonjin-app/brick/blob/main/docs/business-info.md",
      });
    }
    return { core, cards, setup };
  }

  /*
   * 운영자가 모르는 채로 잘못 설정한 것들.
   *
   * 공통점: **틀려도 아무 일도 일어나지 않는다**. 예외도, 빨간 로그도 없다.
   * 메일은 보냈다고 나오고, 링크는 멀쩡해 보이고, 요청 제한은 걸려 있다.
   * 손님 쪽에서만 조용히 망가진다. 그래서 운영자가 매일 보는 화면에서
   * 한 번 말해 준다 — 이 목록이 비어 있는 것이 정상이다.
   */
  /**
   * 사업자정보가 비어 있는가.
   *
   * 전자상거래법 제13조는 상호·대표자·사업자등록번호·주소·연락처를 **초기 화면에
   * 표시**하라고 정한다. 테마 푸터는 값이 있을 때만 그리므로(없는 것을 지어내지
   * 않는다) 입력 전에는 그 자리가 조용히 비어 있다 — 운영자는 푸터가 원래
   * 그런 줄 안다. 물건을 팔기 시작한 뒤에 아는 것이 가장 나쁘다.
   *
   * 상호와 사업자등록번호 둘 중 하나라도 없으면 아직 채우지 않은 것으로 본다.
   */
  private async businessInfoMissing(): Promise<boolean> {
    try {
      const [row] = await this.db
        .select()
        .from(siteSettings)
        .where(eq(siteSettings.key, "site.business_info"))
        .limit(1);
      const info = (row?.value ?? {}) as { companyName?: string; businessNo?: string };
      return !String(info.companyName ?? "").trim() || !String(info.businessNo ?? "").trim();
    } catch {
      // 못 읽었으면 경고하지 않는다 — 대시보드가 이것 때문에 깨지면 안 된다
      return false;
    }
  }

  private setupWarnings(): Array<{ id: string; docs: string; params?: Record<string, string | number> }> {
    const env = loadEnv();
    const out: Array<{ id: string; docs: string; params?: Record<string, string | number> }> = [];
    const doc = (f: string) => `https://github.com/bonjin-app/brick/blob/main/docs/${f}`;
    /*
     * SMTP 가 없으면 모든 메일이 콘솔로만 나간다 — 주문 안내(무통장 계좌!),
     * 비밀번호 재설정, 이메일 인증이 **조용히** 사라진다. 손님은 계좌를 못 받아
     * 입금하지 못하고, 운영자는 "주문 안내 메일" 스위치가 켜져 있으니 되는 줄 안다.
     */
    if (!this.mail.enabled) out.push({ id: "mailOff", docs: doc("mailing.md") });
    /*
     * 주소를 안 바꿨으면 메일 안의 링크가 전부 localhost 다 — 메일은 나가는데
     * 받는 사람은 아무것도 못 연다. 부팅 로그에도 경고를 찍지만, 로그는
     * 아무도 안 본다.
     */
    if (env.isProduction && isLocalUrl(env.siteUrl)) out.push({ id: "siteUrlLocal", docs: doc("installation.md") });
    /*
     * 프록시 뒤인데 신뢰하지 않으면 모든 손님이 같은 IP 로 보인다 — IP 제한이
     * 한 바구니로 합쳐지고 IP 차단이 무력해진다. 요청 헤더를 보고 판단한다.
     */
    if (!env.trustProxy && sawProxyHeaders()) out.push({ id: "trustProxyOff", docs: doc("security.md") });
    return out;
  }

  /**
   * 코어 통계 — 실패해도 카드처럼 격리한다 (null 반환). 잘못된
   * BRICK_TIMEZONE 하나로 대시보드 전체가 500 이 되면 정상 로드된
   * 플러그인 카드까지 전부 사라진다.
   *
   * "회원"의 정의는 members 모듈과 같아야 한다 (탈퇴·휴면 제외,
   * role='member') — 두 화면의 회원 수가 다르면 운영자는 어느 쪽도 믿지
   * 않는다. "오늘"의 경계는 판매 리포트와 같은 사이트 시간대(SITE_TZ)다.
   */
  private async coreStats(): Promise<{ members: number; membersToday: number; pages: number } | null> {
    try {
      const { rows } = await this.db.execute(sql`
        SELECT
          count(*) FILTER (
            WHERE withdrawn_at IS NULL AND dormant_at IS NULL AND role = 'member'
          ) AS members,
          count(*) FILTER (
            WHERE withdrawn_at IS NULL AND dormant_at IS NULL AND role = 'member'
              AND created_at >= (date_trunc('day', now() AT TIME ZONE ${SITE_TZ}) AT TIME ZONE ${SITE_TZ})
          ) AS members_today,
          (SELECT count(*) FROM pages WHERE status = 'published') AS pages
        FROM users
      `);
      return {
        members: Number(rows[0]?.members ?? 0),
        membersToday: Number(rows[0]?.members_today ?? 0),
        pages: Number(rows[0]?.pages ?? 0),
      };
    } catch (err) {
      this.logger.error(`대시보드 코어 통계 실패: ${String(err)}`);
      return null;
    }
  }

  /**
   * 특정 리소스의 전체 스키마 — 관리 화면이 목록/폼을 생성하는 데 쓴다.
   *
   * 내비게이션과 같은 이유로 **운영자도 읽는다**(위 adminNav 참고). 이것만
   * 닫혀 있으면 사이드바에서 찾아 들어간 화면이 "오류" 로 뜬다 — 정작 그
   * 뒤의 데이터 라우트는 열려 있는데.
   */
  @Get("admin/resources/:plugin/:name")
  @UseGuards(ManagerGuard)
  async adminResource(
    @Req() req: FastifyRequest & { user?: { role: string; scopes?: string[] | null } },
    @Param("plugin") plugin: string,
    @Param("name") name: string,
  ) {
    const found = this.loader.adminResources.find((r) => r.plugin === plugin && r.name === name);
    if (!found) throw new NotFoundException(msg("err.unknownAdminScreen", { screen: `${plugin}/${name}` }));
    // 목록에서 가린 화면은 주소를 쳐도 열리지 않는다 (라우트의 자기 검사는 그대로다)
    if (found.adminOnly && req.user?.role !== "admin") {
      throw new ForbiddenException("관리자만 할 수 있는 작업입니다.");
    }
    const scopes = req.user?.role === "manager" && Array.isArray(req.user.scopes) ? req.user.scopes : null;
    if (scopes && !scopes.includes(plugin) && !scopes.includes(`${plugin}/${name}`)) {
      throw new ForbiddenException("이 관리 화면을 다룰 권한이 없습니다.");
    }
    await this.loader.refreshLocale();
    return this.loader.localizeAdminResource(plugin, found);
  }

  /**
   * 업데이트 확인 — 설치된 확장의 업데이트 매니페스트를 조회한다.
   *
   * 자동으로 적용하지 않는다. 무엇이 바뀌는지 보여주고 운영자가 누른다 —
   * 자동 적용은 새벽에 사이트가 바뀌는 것이고, 그것을 원하는 운영자는 없다.
   */
  /** 운영자에게 줄 수 있는 관리 화면 — 회원 관리의 권한 범위 칸이 읽는다 */
  @Get("admin/areas")
  @UseGuards(AdminGuard)
  async adminAreas() {
    await this.loader.refreshLocale();
    const names = new Map((await this.loader.discover()).map((m) => [m.name, m.displayName]));
    const areas = this.loader.adminAreas();
    const plugins = [...new Set(areas.map((a) => a.plugin))].map((p) => ({
      key: p,
      title: this.loader.trCatalog(p, names.get(p) ?? p),
      areas: areas.filter((a) => a.plugin === p).map((a) => ({ key: a.key, title: a.title })),
    }));
    return { plugins };
  }

  @Get("admin/updates")
  @UseGuards(AdminGuard)
  async checkUpdates() {
    return this.updater.check();
  }

  /** 업데이트 적용 — 서명 검증을 통과해야만 설치된다 (extension-updater.service.ts) */
  @Post("admin/updates/:kind/:name/apply")
  @UseGuards(AdminGuard)
  async applyUpdate(
    @Param("kind") kind: string,
    @Param("name") name: string,
    @Req() req: FastifyRequest,
  ) {
    if (kind !== "plugin" && kind !== "theme") {
      throw new BadRequestException("kind 는 plugin 또는 theme 이어야 합니다.");
    }
    const result = await this.updater.apply(kind, name);
    // 활성 플러그인이면 새 코드로 재적재 — 새 마이그레이션이 여기서 적용된다
    if (kind === "plugin" && this.loader.isActive(name)) {
      await this.loader.reload(name);
    }
    await this.audit.fromRequest(req as never, {
      action: "extension.update",
      targetType: kind,
      targetId: name,
      summary: `${name} ${result.from} → ${result.to} (원클릭 업데이트)`,
    });
    return { ...result, reloaded: kind === "plugin" && this.loader.isActive(name) };
  }

  /**
   * 레지스트리 목록 — 설치 가능한 확장과 설치 상태.
   * 레지스트리는 목록일 뿐, 신뢰는 서명이 결정한다 (ADR-74).
   */
  @Get("admin/registry")
  @UseGuards(AdminGuard)
  async registry() {
    return this.updater.listRegistry();
  }

  /** 레지스트리에서 설치 — 서명 검증을 통과해야만 설치된다 */
  @Post("admin/registry/:kind/:name/install")
  @UseGuards(AdminGuard)
  async installFromRegistry(
    @Param("kind") kind: string,
    @Param("name") name: string,
    @Body() body: { activate?: boolean } | undefined,
    @Req() req: FastifyRequest,
  ) {
    if (kind !== "plugin" && kind !== "theme") {
      throw new BadRequestException("kind 는 plugin 또는 theme 이어야 합니다.");
    }
    const result = await this.updater.installFromRegistry(kind, name);
    // "몇 번의 클릭"을 줄인다 — 설치 화면에서 바로 켤 수 있게 (선택)
    if (kind === "plugin" && body?.activate === true) {
      await this.loader.activate(name);
    }
    await this.audit.fromRequest(req as never, {
      action: "extension.registry_install",
      targetType: kind,
      targetId: name,
      summary: `${name}@${result.version} 레지스트리 설치`,
    });
    return { ...result, activated: kind === "plugin" && this.loader.isActive(name) };
  }

  /**
   * 회원 메뉴 — 플러그인이 선언한 회원 화면 목록.
   *
   * 인증을 요구하지 않는다: 어떤 기능이 있는지는 비밀이 아니고, 내용은 각 화면이
   * 스스로 지킨다. 로그인 화면에서 "가입하면 이런 게 있다"를 보여줄 수도 있다.
   */
  @Get("member/menu")
  async memberMenu() {
    await this.loader.refreshLocale();
    /*
     * 알림함은 코어가 가진 회원 화면이다 — 플러그인이 없는 사이트에도 있어야
     * 하므로 여기서 얹는다. 머리의 종 아이콘만으로는 마이페이지에서 찾을 수 없다.
     */
    const t = makeTranslator({ locale: this.loader.siteLocale, catalogs: CORE_CATALOGS });
    return { items: [{ label: t("noti.title"), path: "/notifications" }, ...this.loader.memberMenu()] };
  }

  /**
   * 페이지 빌더가 사용할 블록 카탈로그.
   *
   * 이름과 속성 제목도 **사이트 언어를 따른다.** 빌더는 여기서 준 문자열을
   * 그대로 그리므로, 번역하지 않으면 영어 사이트의 운영자에게도 블록 서랍이
   * "제목 · 문단 · 히어로 (큰 제목 영역)" 로 보인다 — 관리 화면의 나머지는 다
   * 영어인데 **페이지를 만드는 바로 그 화면만** 한국어였다.
   *
   * 선언 라벨과 같은 gettext 규칙이다(원문=키): 플러그인 블록은 각자의
   * locales/en.json 이, 코어 블록(`core/…`)은 코어 카탈로그가 받는다.
   */
  @Get("blocks")
  async blocks() {
    await this.loader.refreshLocale();
    const locale = this.loader.siteLocale;
    const tr = (name: string, text?: string): string | undefined => {
      if (!text) return text;
      const plugin = name.split("/")[0];
      return plugin === "core" ? translateCoreLabel(locale, text) : this.loader.trCatalog(plugin, text);
    };
    return [...this.loader.blocks.values()].map(({ name, displayName, propsSchema }) => ({
      name,
      displayName: tr(name, displayName) ?? displayName,
      propsSchema: localizeSchema(propsSchema, (text) => tr(name, text) ?? text),
    }));
  }

  /** 블록 서버 렌더 (Next.js가 페이지 조립 시 호출). 블록 이름에 "/"가 포함되므로 body로 받는다 */
  @Post("blocks/render")
  async renderBlock(
    @Body() body: {
      name: string;
      props?: Record<string, unknown>;
      path?: string;
      pathTail?: string;
      query?: Record<string, string>;
    },
    @Req() req: FastifyRequest,
  ) {
    const block = this.loader.blocks.get(body?.name ?? "");
    if (!block) throw new NotFoundException(msg("err.unknownBlock", { name: String(body?.name) }));
    const user = await this.auth.resolveFromRequest(req);
    const html = await block.render(body?.props ?? {}, {
      children: [],
      path: body?.path ?? "",
      pathTail: body?.pathTail ?? "",
      query: body?.query ?? {},
      user: user ? { id: user.id, role: user.role, displayName: user.displayName } : null,
    });
    return { html };
  }
}

/**
 * 블록 속성 스키마의 **보이는 글자만** 갈아 끼운다.
 *
 * 키(`limit`·`columns`)와 타입·기본값은 그대로 둔다 — 그것은 데이터이고,
 * 저장된 페이지의 props 가 그 키로 붙어 있다. 번역되면 페이지가 깨진다.
 */
function localizeSchema(
  schema: { type?: string; properties?: Record<string, Record<string, unknown>> } | undefined,
  tr: (text: string) => string,
): unknown {
  const props = schema?.properties;
  if (!props) return schema;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, meta] of Object.entries(props)) {
    const next: Record<string, unknown> = { ...meta };
    for (const field of ["title", "description"]) {
      if (typeof next[field] === "string") next[field] = tr(next[field] as string);
    }
    out[key] = next;
  }
  return { ...schema, properties: out };
}
