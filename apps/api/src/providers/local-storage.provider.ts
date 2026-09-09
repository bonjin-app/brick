import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { StorageProvider, StoredFile } from "@brick/core";

/** 기본 스토리지: uploads/ 디렉터리. S3/R2는 설정 시 교체 */
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    const p = normalize(join(this.baseDir, key));
    if (!p.startsWith(normalize(this.baseDir))) throw new Error("path traversal");
    return p;
  }

  async put(key: string, data: Buffer | NodeJS.ReadableStream, contentType: string): Promise<StoredFile> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    const source = Buffer.isBuffer(data) ? Readable.from(data) : data;
    await pipeline(source, createWriteStream(path));
    const { size } = await stat(path);
    return { key, size, contentType, url: this.publicUrl(key) };
  }

  async get(key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch(() => undefined);
  }

  publicUrl(key: string): string {
    return `/uploads/${key}`;
  }

  keyFromUrl(url: string): string | null {
    const path = String(url ?? "").trim();
    if (!path.startsWith("/uploads/")) return null;
    const key = decodeURIComponent(path.slice("/uploads/".length));
    // 상대 경로 탈출은 키가 아니다 — 이 값으로 DB 를 조회하고 파일을 열게 되므로 여기서 막는다
    if (!key || key.startsWith("/") || key.split("/").includes("..")) return null;
    return key;
  }
}
