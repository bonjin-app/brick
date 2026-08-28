import { Injectable } from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants.js";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";

/**
 * OpenAPI 문서 생성 — 코드가 곧 문서다.
 *
 * 스펙 파일을 손으로 쓰지 않는다. 손으로 쓴 문서는 라우트가 바뀌는 순간부터
 * 거짓말을 시작한다. 대신 실제로 등록된 라우트에서 만든다:
 *
 *  - 코어: Nest 컨트롤러 메타데이터를 런타임에 읽는다 (DiscoveryService).
 *  - 플러그인: 로더의 라우트 테이블을 읽는다 — registerRoute 로 등록한
 *    라우트는 자동으로 문서에 실린다. summary 는 선택 인자로 붙인다.
 *
 * 스키마(요청/응답 본문)는 담지 않는다 — 플러그인 핸들러는 불투명하고,
 * 코어에 데코레이터를 도배하는 것은 문서를 위해 코드를 무겁게 만드는 일이다.
 * 경로·메서드·파라미터·인증 요구가 정확한 것이 스키마가 그럴듯한 것보다 낫다.
 */
@Injectable()
export class OpenApiService {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly loader: PluginLoaderService,
  ) {}

  buildDocument(): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    const tags = new Set<string>();

    const add = (url: string, method: string, op: Record<string, unknown>) => {
      // ":param" → "{param}" (OpenAPI 규격)
      const oaUrl = url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      paths[oaUrl] ??= {};
      // 경로 파라미터는 스펙상 선언이 필수다
      const params = [...oaUrl.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
      if (params.length) op.parameters = params;
      // 관리자 경로는 세션 인증을 요구한다고 표시한다
      if (oaUrl.includes("/admin/")) op.security = [{ cookieAuth: [] }];
      paths[oaUrl][method.toLowerCase()] = op;
    };

    // ── 코어 라우트 (Nest 컨트롤러 메타데이터) ────────
    const METHOD_NAME: Record<number, string> = {
      [RequestMethod.GET]: "GET",
      [RequestMethod.POST]: "POST",
      [RequestMethod.PUT]: "PUT",
      [RequestMethod.DELETE]: "DELETE",
      [RequestMethod.PATCH]: "PATCH",
    };
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const prefix = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? "");
      const proto = Object.getPrototypeOf(instance) as object;

      for (const methodName of this.scanner.getAllMethodNames(proto)) {
        const ref = (proto as Record<string, unknown>)[methodName];
        if (typeof ref !== "function") continue;
        const routePath = Reflect.getMetadata(PATH_METADATA, ref) as string | undefined;
        const routeMethod = Reflect.getMetadata(METHOD_METADATA, ref) as number | undefined;
        if (routePath === undefined || routeMethod === undefined) continue;
        const httpMethod = METHOD_NAME[routeMethod];
        if (!httpMethod) continue; // ALL/OPTIONS/HEAD 는 문서에서 뺀다

        const full = `/${[prefix, routePath].map((s) => String(s).replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`;
        // 정적 파일·업로드 등 와일드카드는 API 가 아니다
        if (full.includes("*")) continue;

        const tag = tagOf(full, "core");
        tags.add(tag);
        add(full, httpMethod, {
          tags: [tag],
          summary: `${metatype.name}.${methodName}`,
          operationId: `${metatype.name}_${methodName}`,
        });
      }
    }

    // ── 플러그인 라우트 (로더의 라우트 테이블) ────────
    for (const r of this.loader.routes) {
      const url = `/${r.segments.join("/")}`;
      const tag = `plugin:${r.plugin}`;
      tags.add(tag);
      add(url, r.method, {
        tags: [tag],
        summary: r.docs?.summary ?? "",
        operationId: `${r.plugin}_${r.method}_${r.segments.slice(3).join("_") || "root"}`,
      });
    }

    return {
      openapi: "3.1.0",
      info: {
        title: "Brick API",
        description:
          "실제로 등록된 라우트에서 생성된 문서입니다. 플러그인을 켜고 끄면 이 문서도 함께 변합니다. " +
          "인증은 세션 쿠키(brick_session)로 하며, 로그인은 POST /api/auth/login 입니다.",
        version: "live",
      },
      tags: [...tags].sort().map((name) => ({ name })),
      paths,
      components: {
        securitySchemes: {
          cookieAuth: { type: "apiKey", in: "cookie", name: "brick_session" },
        },
      },
    };
  }
}

/** /api/pages/:id → "pages", /api/plugins/... 는 호출부에서 plugin: 태그 */
function tagOf(url: string, fallback: string): string {
  const seg = url.split("/").filter(Boolean);
  if (seg[0] !== "api") return fallback;
  return seg[1] ?? fallback;
}
