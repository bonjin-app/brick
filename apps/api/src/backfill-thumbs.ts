import { drizzle } from "drizzle-orm/node-postgres";
import { and, isNull, sql } from "drizzle-orm";
import { Client } from "pg";
import { mediaFiles } from "@brick/database";
import { ImageService } from "./modules/images/image.service.js";
import { LocalStorageProvider } from "./providers/local-storage.provider.js";
import { loadEnv } from "./config/env.js";

/**
 * 이미 올라온 이미지의 썸네일·치수를 채운다 — `node dist/backfill-thumbs.js [--dry]`
 *
 * 이미지 최적화는 **업로드 시점**에만 동작한다. 그 기능 이전에 운영해 온 사이트에는 썸네일이
 * 없는 파일이 쌓여 있고, 목록은 원본(4MB 사진)을 그대로 내려보낸다 — 업그레이드한 운영자가
 * 얻을 것을 못 얻는 셈이다. 이 도구가 한 번 돌면서 빠진 것만 채운다.
 *
 * 원본은 건드리지 않는다. 이미 저장된 파일을 다시 압축하면 화질이 한 번 더 깎이고,
 * 무엇보다 운영자가 올린 그대로여야 하는 파일(정밀한 로고·인쇄용 이미지)이 있을 수 있다.
 * 새로 만드는 것은 목록용 썸네일과 DB 의 치수뿐이다.
 *
 * 안전 장치:
 *   - `--dry` 로 무엇을 할지만 보여준다
 *   - 파일을 못 읽거나(스토리지에서 지워진 경우) 처리에 실패하면 그 항목만 건너뛴다
 *   - 여러 번 돌려도 같은 결과다 (thumb_key 가 있는 행은 건드리지 않는다)
 */
async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 필요합니다.");

  const images = new ImageService();
  if (!(await images.isAvailable())) {
    console.error("✖ sharp 를 쓸 수 없어 썸네일을 만들 수 없습니다. 이 서버 아키텍처의 바이너리를 설치한 뒤 다시 실행하세요.");
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  const db = drizzle(client);
  // 업로드 경로는 서버와 같은 판단(loadEnv)을 쓴다 — 설정 파일·환경변수 우선순위가 어긋나면 엉뚱한 곳을 본다
  const storage = new LocalStorageProvider(loadEnv().uploadsDir);

  // 이미지인데 썸네일이 없는 것만 (동영상·문서는 대상이 아니다)
  const rows = await db
    .select()
    .from(mediaFiles)
    .where(and(isNull(mediaFiles.thumbKey), sql`${mediaFiles.contentType} LIKE 'image/%'`));

  console.log(`대상 ${rows.length}건${dry ? " (--dry: 실제로 만들지 않습니다)" : ""}`);
  let done = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!images.canProcess(row.contentType)) {
      skipped++;
      continue; // GIF·SVG 는 원본을 그대로 쓴다
    }
    try {
      const buffer = await readAll(await storage.get(row.storageKey));
      const thumb = await images.thumbnail(buffer, row.contentType);
      if (!thumb) {
        skipped++;
        continue;
      }
      const dot = row.storageKey.lastIndexOf(".");
      const base = dot > 0 ? row.storageKey.slice(0, dot) : row.storageKey;
      const thumbKey = `${base}-thumb${thumb.ext ?? ".webp"}`;
      // 치수는 썸네일이 아니라 원본에서 읽어야 한다
      const meta = await images.optimize(buffer, row.contentType, { maxWidth: 100000, maxHeight: 100000 });

      if (!dry) {
        await storage.put(thumbKey, thumb.buffer, thumb.contentType);
        await db
          .update(mediaFiles)
          .set({ thumbKey, width: meta.width, height: meta.height })
          .where(sql`${mediaFiles.id} = ${row.id}`);
      }
      done++;
      console.log(`  ${dry ? "[예정]" : "✓"} ${row.fileName} → ${thumbKey}${meta.width ? ` (${meta.width}×${meta.height})` : ""}`);
    } catch (err) {
      skipped++;
      console.warn(`  ! ${row.fileName} 건너뜀: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await client.end();
  console.log(`\n완료: ${done}건 ${dry ? "예정" : "생성"}, ${skipped}건 건너뜀`);
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

main().catch((err) => {
  console.error("✖", err instanceof Error ? err.message : err);
  process.exit(1);
});
