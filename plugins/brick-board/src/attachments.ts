import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { extname } from "node:path";
import type { StorageProvider } from "@brick/plugin-sdk";
import type { BoardRow, Db } from "./types.js";
import { ALLOWED_UPLOAD, BoardError, pgArray } from "./types.js";

export interface UploadInput {
  fileName: string;
  contentType: string;
  buffer: Buffer;
}

/**
 * 첨부파일 저장.
 *
 * 보안:
 *  - 확장자 **화이트리스트** + MIME 일치 검사. .php/.jsp/.html 은 허용하지 않는다
 *    (정적 서빙과 결합되면 원격 코드 실행이나 저장형 XSS가 된다)
 *  - 저장 키는 서버가 만든다. 원본 파일명을 경로에 쓰지 않는다 (traversal·충돌 방지)
 *  - 원본 파일명은 표시용으로만 DB에 둔다
 */
export async function attachFiles(
  db: Db,
  storage: StorageProvider,
  params: { postId: string; board: BoardRow; files: UploadInput[]; existingCount?: number },
): Promise<number> {
  const { postId, board, files } = params;
  if (!files.length) return 0;
  if (!board.allow_upload) throw new BoardError(400, "이 게시판은 파일 첨부를 허용하지 않습니다.");

  const already = params.existingCount ?? 0;
  if (already + files.length > board.max_files) {
    throw new BoardError(400, `첨부파일은 최대 ${board.max_files}개까지 가능합니다.`);
  }

  // ── 1단계: 전부 검증 ────────────────────────────────
  // 파일을 하나씩 검증하며 저장하면, 뒤쪽 파일이 거부될 때 앞쪽 파일이 남는다.
  // (스토리지와 DB에 고아 레코드가 생긴다) 그래서 저장 전에 모두 검증한다.
  const planned = files.map((file, index) => {
    const ext = extname(file.fileName ?? "").toLowerCase();
    const allowedMimes = ALLOWED_UPLOAD[ext];
    if (!allowedMimes) {
      throw new BoardError(
        400,
        `허용되지 않는 파일 형식입니다: ${ext || "(확장자 없음)"} — ` +
          `허용: ${Object.keys(ALLOWED_UPLOAD).join(", ")}`,
      );
    }
    // hwp 등 일부 형식은 브라우저가 MIME을 제대로 못 붙이므로 octet-stream을 허용한다
    if (!allowedMimes.includes(file.contentType) && file.contentType !== "application/octet-stream") {
      throw new BoardError(400, `파일 내용과 확장자가 일치하지 않습니다 (${file.contentType}).`);
    }
    if (!file.buffer?.length) {
      throw new BoardError(400, `빈 파일은 첨부할 수 없습니다: ${file.fileName}`);
    }

    const id = uuidv7();
    const now = new Date();
    return {
      id,
      file,
      ext,
      sortOrder: already + index,
      key: `board/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${id}${ext}`,
    };
  });

  // ── 2단계: 저장 ────────────────────────────────────
  // 중간에 실패하면 이미 올린 파일을 되돌린다(고아 파일을 남기지 않는다).
  const written: string[] = [];
  try {
    for (const item of planned) {
      const stored = await storage.put(item.key, item.file.buffer, item.file.contentType);
      written.push(item.key);
      await db.execute(sql`
        INSERT INTO board_attachments
          (id, post_id, storage_key, file_name, content_type, size, sort_order)
        VALUES
          (${item.id}, ${postId}::uuid, ${item.key},
           ${(item.file.fileName ?? "untitled").slice(0, 500)},
           ${item.file.contentType}, ${String(stored.size)}, ${item.sortOrder})
      `);
    }
  } catch (err) {
    for (const key of written) await storage.delete(key).catch(() => undefined);
    await db.execute(sql`
      DELETE FROM board_attachments
      WHERE post_id = ${postId}::uuid AND storage_key = ANY(${pgArray(written)}::text[])
    `).catch(() => undefined);
    throw err;
  }

  // file_count는 실제 행 수로 다시 센다 (증감 누적보다 정확하다)
  const { rows } = await db.execute(sql`
    UPDATE board_posts SET file_count =
      (SELECT count(*) FROM board_attachments a WHERE a.post_id = board_posts.id)
    WHERE id = ${postId}::uuid RETURNING file_count
  `);
  return Number(rows[0]?.file_count ?? planned.length) - already;
}

/** 글에 딸린 첨부 목록 */
export async function listAttachments(db: Db, postId: string) {
  const { rows } = await db.execute(sql`
    SELECT id, file_name, content_type, size, download_count
    FROM board_attachments WHERE post_id = ${postId}::uuid ORDER BY sort_order, created_at
  `);
  return rows;
}

/**
 * 첨부파일 삭제 — 스토리지와 DB를 함께 정리한다.
 * 스토리지 삭제가 실패해도 DB 레코드는 지운다(고아 파일이 남는 것이 낫다).
 */
export async function deleteAttachments(
  db: Db,
  storage: StorageProvider,
  postId: string,
): Promise<void> {
  const { rows } = await db.execute(sql`
    SELECT storage_key FROM board_attachments WHERE post_id = ${postId}::uuid
  `);
  for (const row of rows) {
    await storage.delete(String(row.storage_key)).catch(() => undefined);
  }
  await db.execute(sql`DELETE FROM board_attachments WHERE post_id = ${postId}::uuid`);
}

/** 다운로드 — 카운트를 올리고 저장 키를 돌려준다 */
export async function claimDownload(
  db: Db,
  attachmentId: string,
): Promise<{ storageKey: string; fileName: string; contentType: string } | null> {
  const { rows } = await db.execute(sql`
    UPDATE board_attachments SET download_count = download_count + 1
    WHERE id = ${attachmentId}::uuid
    RETURNING storage_key, file_name, content_type
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    storageKey: String(row.storage_key),
    fileName: String(row.file_name),
    contentType: String(row.content_type),
  };
}
