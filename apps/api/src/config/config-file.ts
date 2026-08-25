import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

/**
 * 설정 파일 — 그누보드/워드프레스식 설치를 가능하게 하는 조각.
 *
 * 왜 필요한가:
 *  Docker에서는 compose가 DATABASE_URL을 넣어주므로 환경변수만으로 충분하다.
 *  그러나 FTP로 파일만 올리는 호스팅에서는 사용자가 환경변수를 설정할 수단이 없다.
 *  그래서 브라우저에서 DB 정보를 입력받아 이 파일에 쓴다.
 *
 * 우선순위: 환경변수 > 설정 파일
 *  (Docker/k8s에서는 환경변수가 이기므로 컨테이너 재생성 시 옛 파일이 방해하지 않는다)
 */
export interface BrickConfigFile {
  databaseUrl: string;
  secret: string;
  siteUrl?: string;
  createdAt: string;
}

export function configPath(): string {
  return resolve(process.env.BRICK_CONFIG_PATH ?? "data/brick.config.json");
}

export function readConfigFile(): BrickConfigFile | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BrickConfigFile>;
    if (!parsed.databaseUrl || !parsed.secret) return null;
    return parsed as BrickConfigFile;
  } catch {
    // 손상된 설정 파일을 조용히 무시하면 원인을 못 찾는다
    console.error(`[brick] 설정 파일을 읽을 수 없습니다: ${path}`);
    return null;
  }
}

export function writeConfigFile(input: { databaseUrl: string; siteUrl?: string }): BrickConfigFile {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });

  // 시크릿은 사용자가 만들지 않는다 — 설치 시 자동 생성한다.
  // (사용자에게 "랜덤 문자열을 만들어 넣으세요"를 요구하면 대부분 약한 값을 쓴다)
  const existing = readConfigFile();
  const config: BrickConfigFile = {
    databaseUrl: input.databaseUrl,
    secret: existing?.secret ?? randomBytes(32).toString("base64url"),
    ...(input.siteUrl ? { siteUrl: input.siteUrl } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  writeFileSync(path, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    // DB 비밀번호가 담긴 파일이므로 소유자만 읽게 한다 (공유 호스팅에서 특히 중요)
    chmodSync(path, 0o600);
  } catch {
    console.warn(`[brick] 설정 파일 권한을 0600으로 설정할 수 없습니다: ${path}`);
  }
  return config;
}

/** 설정 파일을 쓸 수 있는 위치인지 미리 확인 (설치 화면에서 안내하기 위해) */
export function canWriteConfig(): { writable: boolean; path: string; reason?: string } {
  const path = configPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const probe = `${path}.probe`;
    writeFileSync(probe, "x");
    unlinkSync(probe);
    return { writable: true, path };
  } catch (err) {
    return {
      writable: false,
      path,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
