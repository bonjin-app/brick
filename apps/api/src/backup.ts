import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * 백업/복원 — `node dist/backup.js dump <파일>` / `restore <파일>`
 *
 * DB는 pg_dump/pg_restore에 위임한다 (직접 SQL을 짜는 것보다 안전하고 검증된 경로).
 * 파일(uploads/plugins/themes)은 Docker 볼륨이므로 문서에서 tar 방법을 안내한다.
 */
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
    console.log(`[backup] 백업 완료: ${path}`);
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
