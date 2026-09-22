import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * 백업/복원 — `node dist/backup.js dump <파일>` / `restore <파일>`
 *
 * DB는 pg_dump/pg_restore에 위임한다 (직접 SQL을 짜는 것보다 안전하고 검증된 경로).
 * 파일(uploads/plugins/themes)은 Docker 볼륨이므로 문서에서 tar 방법을 안내한다.
 */
/** 명령을 돌리고 stdout 을 문자열로 받는다 (덤프 검증이 쓴다) */
function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise(out) : reject(new Error(err.trim() || `${cmd} exited with ${code}`)),
    );
  });
}

/**
 * **뜬 덤프를 실제로 읽어 본다.**
 *
 * `pg_dump` 가 0 으로 끝났다는 것은 "명령이 성공했다" 일 뿐이고, 운영자가
 * 알아야 하는 것은 **복원할 수 있는 파일이 생겼는가** 다. 디스크가 가득 찼거나
 * 도중에 끊긴 덤프도 파일은 남는다 — 그리고 그 사실은 정말 필요한 순간에,
 * 복원을 시도할 때 알게 된다. 설치형 CMS 에서 그보다 늦게 알면 안 되는 것은 없다.
 *
 * `pg_restore --list` 는 덤프의 목차(TOC)를 읽는다. 읽히지 않으면 그 파일로는
 * 복원할 수 없고, 목차에 테이블 데이터가 하나도 없으면 되돌릴 것이 없다.
 */
async function verifyDump(path: string): Promise<{ bytes: number; tables: number }> {
  const { size } = await stat(path).catch(() => ({ size: 0 }) as { size: number });
  if (!size) throw new Error("덤프 파일이 비어 있습니다 (디스크 공간·권한을 확인하세요).");

  const toc = await capture("pg_restore", ["--list", path]).catch((err: unknown) => {
    throw new Error(
      `덤프를 읽을 수 없습니다 — 이 파일로는 복원할 수 없습니다: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  const tables = toc.split("\n").filter((line) => / TABLE DATA /.test(line)).length;
  if (!tables) throw new Error("덤프에 테이블 데이터가 없습니다 — 되돌릴 것이 없는 백업입니다.");
  return { bytes: size, tables };
}

function run(cmd: string, args: string[], outFile?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: outFile ? ["ignore", "pipe", "inherit"] : "inherit" });
    if (outFile && child.stdout) child.stdout.pipe(createWriteStream(outFile));
    child.on("error", (err) =>
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`${cmd} 명령을 찾을 수 없습니다. postgresql-client를 설치하세요.`)
          : err,
      ),
    );
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

async function main() {
  const [action, file] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (!action || !file) {
    console.log("사용법:\n  node dist/backup.js dump <파일.dump>\n  node dist/backup.js restore <파일.dump>");
    process.exit(1);
  }
  const path = resolve(file);

  if (action === "dump") {
    await mkdir(dirname(path), { recursive: true });
    // custom 포맷(-Fc): 압축되고 선택 복원이 가능하다
    await run("pg_dump", ["-Fc", "--no-owner", "--no-privileges", "-d", url, "-f", path]);

    // 떴다고 끝이 아니다 — 읽히는 파일인지 확인하고 숫자로 말해 준다
    const { bytes, tables } = await verifyDump(path);
    console.log(`[backup] 백업 완료: ${path} (${(bytes / 1024 / 1024).toFixed(1)}MB · 테이블 ${tables}개)`);

    /*
     * 백업을 **백업 대상 안에** 두고 있지 않은가.
     *
     * 운영 문서가 `/app/uploads/db-....dump` 를 예로 드는데, 그 볼륨은 업로드
     * 파일 백업의 대상이기도 하다. 그대로 두면 백업이 백업을 품고 부풀다가
     * 업로드 볼륨을 채운다 — 문서도 "흔한 사고" 라고 적어 두었다. 말만 해 준다:
     * 임시로 그 자리에 뜨는 것이 편할 때가 있고, 막을 일은 아니다.
     */
    const uploads = process.env.BRICK_UPLOADS_DIR ? resolve(process.env.BRICK_UPLOADS_DIR) : "";
    if (uploads && (path === uploads || path.startsWith(uploads + sep))) {
      console.warn(
        "[backup] ⚠ 업로드 폴더 안에 백업을 두었습니다. 업로드 볼륨을 통째로 보관하는 백업이 " +
          "이 파일까지 안고 부풀어 볼륨을 채웁니다 — 다른 곳으로 옮기거나 오래된 것을 지우세요.",
      );
    }
    console.log("[backup] 업로드 파일도 함께 보관하세요 — docker run --rm -v brick_uploads:/d -v $PWD:/b alpine tar czf /b/uploads.tgz -C /d .");
  } else if (action === "restore") {
    console.log("[backup] 복원은 기존 데이터를 덮어씁니다. 5초 후 시작합니다...");
    await new Promise((r) => setTimeout(r, 5000));
    await run("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-privileges", "-d", url, path]);
    console.log(`[backup] 복원 완료: ${path}`);
  } else {
    throw new Error(`알 수 없는 명령: ${action}`);
  }
}

main().catch((err) => {
  console.error("[backup] 실패:", err instanceof Error ? err.message : err);
  process.exit(1);
});
