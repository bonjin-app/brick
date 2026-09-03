import { Controller, Get, NotFoundException, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".json": "application/json", ".txt": "text/plain", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm",
};

/**
 * 정적 파일 서빙 — 테마 자산과 업로드 파일.
 * 프로덕션에서는 Nginx/CDN을 앞에 둘 수 있지만, 기본 설치에서는 이걸로 충분하다.
 */
@Controller()
export class StaticController {
  private readonly themesDir = resolve(process.env.BRICK_THEMES_DIR ?? "themes");
  private readonly uploadsDir = resolve(process.env.BRICK_UPLOADS_DIR ?? "uploads");

  @Get("themes/:name/assets/*")
  async themeAsset(@Param("name") name: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const [pathPart, query = ""] = req.url.split("?");
    const rel = decodeURIComponent(pathPart).replace(/^\/themes\//, "");
    // 테마가 ?v=<스탬프> 로 부르는 자산은 내용이 바뀌면 주소도 바뀐다 — 1년 immutable 로 두어도 안전하다.
    // 스탬프 없이 부르면(직접 링크) 1시간.
    const versioned = /(^|&)v=/.test(query);
    return this.serve(join(this.themesDir, rel), this.themesDir, reply,
      versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600");
  }

  @Get("uploads/*")
  async upload(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/uploads\//, "");
    return this.serve(join(this.uploadsDir, rel), this.uploadsDir, reply, "public, max-age=86400");
  }

  private async serve(path: string, baseDir: string, reply: FastifyReply, cacheControl: string): Promise<void> {
    const norm = normalize(path);
    if (!norm.startsWith(baseDir)) throw new NotFoundException(); // path traversal 방어
    const info = await stat(norm).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException();
    reply
      .header("content-type", MIME[extname(norm).toLowerCase()] ?? "application/octet-stream")
      .header("content-length", info.size)
      .header("cache-control", cacheControl);
    return reply.send(createReadStream(norm));
  }
}
