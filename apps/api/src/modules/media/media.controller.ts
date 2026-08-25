import {
  BadRequestException, Controller, Delete, Get, Inject, NotFoundException,
  Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import { count, desc, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { extname } from "node:path";
import type { FastifyRequest } from "fastify";
import type { BrickDb } from "@brick/database";
import { mediaFiles } from "@brick/database";
import type { StorageProvider } from "@brick/core";
import { AdminGuard } from "../auth/auth.guard.js";
import { DB, STORAGE } from "../../runtime.module.js";

/**
 * 허용 확장자/MIME 화이트리스트.
 * 블랙리스트가 아니라 화이트리스트여야 한다 — .php/.jsp/.html 업로드는
 * 정적 서빙과 결합되면 원격 코드 실행이나 저장형 XSS로 이어진다.
 */
const ALLOWED: Record<string, string[]> = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
  ".svg": [], // SVG는 스크립트를 담을 수 있어 업로드를 허용하지 않는다
  ".pdf": ["application/pdf"],
  ".zip": ["application/zip", "application/x-zip-compressed"],
  ".mp4": ["video/mp4"],
  ".webm": ["video/webm"],
  ".txt": ["text/plain"],
  ".csv": ["text/csv", "application/vnd.ms-excel"],
};

@Controller("api/media")
export class MediaController {
  constructor(
    @Inject(DB) private readonly db: BrickDb,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  @Get()
  @UseGuards(AdminGuard)
  async list(@Query("page") pageParam?: string) {
    const page = Math.max(1, Number(pageParam ?? 1));
    const size = 40;
    const [items, [total]] = await Promise.all([
      this.db.select().from(mediaFiles).orderBy(desc(mediaFiles.createdAt)).limit(size).offset((page - 1) * size),
      this.db.select({ value: count() }).from(mediaFiles),
    ]);
    return {
      items: items.map((f) => ({ ...f, url: this.storage.publicUrl(f.storageKey) })),
      total: Number(total?.value ?? 0),
      page,
      pageSize: size,
    };
  }

  @Post("upload")
  @UseGuards(AdminGuard)
  async upload(@Req() req: FastifyRequest & { user: { id: string } }) {
    const file = await req.file();
    if (!file) throw new BadRequestException("파일이 없습니다.");

    const ext = extname(file.filename ?? "").toLowerCase();
    const allowedMimes = ALLOWED[ext];
    if (!allowedMimes) {
      throw new BadRequestException(
        `허용되지 않는 파일 형식입니다: ${ext || "(확장자 없음)"} — 허용: ${Object.keys(ALLOWED).filter((e) => ALLOWED[e].length).join(", ")}`,
      );
    }
    if (!allowedMimes.includes(file.mimetype)) {
      throw new BadRequestException(`파일 내용과 확장자가 일치하지 않습니다 (${file.mimetype}).`);
    }

    const buffer = await file.toBuffer();
    // 저장 키는 서버가 생성한다 — 원본 파일명을 경로에 쓰지 않는다 (traversal/충돌 방지)
    const id = uuidv7();
    const now = new Date();
    const storageKey = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${id}${ext}`;

    const stored = await this.storage.put(storageKey, buffer, file.mimetype);
    await this.db.insert(mediaFiles).values({
      id,
      storageKey,
      fileName: (file.filename ?? "untitled").slice(0, 500),
      contentType: file.mimetype,
      size: String(stored.size),
      uploaderId: req.user.id,
    });

    return { id, url: stored.url, fileName: file.filename, size: stored.size };
  }

  @Delete(":id")
  @UseGuards(AdminGuard)
  async remove(@Param("id") id: string) {
    const [row] = await this.db.select().from(mediaFiles).where(eq(mediaFiles.id, id)).limit(1);
    if (!row) throw new NotFoundException();
    await this.storage.delete(row.storageKey);
    await this.db.delete(mediaFiles).where(eq(mediaFiles.id, id));
    return { ok: true };
  }
}
