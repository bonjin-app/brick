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

/** 서버가 만든 저장 키의 표식 — UUIDv7 이 파일명에 들어 있다 */
const UUID_IN_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
      versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600", req);
  }

  @Get("uploads/*")
  async upload(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/uploads\//, "");
    /*
     * 업로드 키는 서버가 UUID 로 만들고 **절대 덮어쓰지 않는다**(미디어·아바타·게시판·공유 이미지 모두).
     * 내용이 바뀌면 주소가 바뀌므로 1년 immutable 이 안전하다 — 목록 썸네일 40장이 재방문마다 다시
     * 내려오는 일이 없어진다. 이름에 UUID 가 없는 파일(플러그인이 고정 키로 저장한 경우)은 하루.
     */
    const immutable = UUID_IN_NAME.test(rel);
    return this.serve(join(this.uploadsDir, rel), this.uploadsDir, reply,
      immutable ? "public, max-age=31536000, immutable" : "public, max-age=86400", req);
  }

  private async serve(path: string, baseDir: string, reply: FastifyReply, cacheControl: string, req?: FastifyRequest): Promise<void> {
    const norm = normalize(path);
    if (!norm.startsWith(baseDir)) throw new NotFoundException(); // path traversal 방어
    const info = await stat(norm).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException();
    // 조건부 요청 — 캐시가 만료된 뒤에도 파일이 같으면 본문 없이 304 로 끝낸다
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const lastModified = new Date(info.mtimeMs).toUTCString();
    reply.header("etag", etag).header("last-modified", lastModified).header("cache-control", cacheControl);
    const inm = req?.headers["if-none-match"];
    const ims = req?.headers["if-modified-since"];
    if ((inm && inm === etag) || (!inm && ims && new Date(ims).getTime() >= Math.floor(info.mtimeMs / 1000) * 1000)) {
      return reply.code(304).send();
    }
    reply
      .header("content-type", MIME[extname(norm).toLowerCase()] ?? "application/octet-stream")
      .header("content-length", info.size);
    return reply.send(createReadStream(norm));
  }
}
