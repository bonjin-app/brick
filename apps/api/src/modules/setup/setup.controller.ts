import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import pg from "pg";
import { canWriteConfig, readConfigFile, writeConfigFile } from "../../config/config-file.js";

interface DbConnectDto {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  siteUrl?: string;
}

/**
 * setup 모드 컨트롤러 — DB 설정이 없을 때만 마운트된다.
 *
 * 목적: FTP로 파일만 올린 상태에서 브라우저로 설치를 시작할 수 있게 한다
 * (그누보드/워드프레스식 설치). DB 정보를 받아 설정 파일에 쓰고, 재시작을 안내한다.
 *
 * DB에 접근할 수 없는 상태이므로 이 컨트롤러는 DB를 주입받지 않는다.
 */
@Controller("api/setup")
export class SetupController {
  @Get("status")
  status() {
    const writable = canWriteConfig();
    return {
      state: "needs_database",
      configPath: writable.path,
      configWritable: writable.writable,
      ...(writable.reason ? { configWriteError: writable.reason } : {}),
      configExists: readConfigFile() !== null,
    };
  }

  /** 입력한 정보로 실제 접속을 시도한다 — 저장 전에 검증해야 사용자가 오류를 즉시 안다 */
  @Post("test")
  async test(@Body() dto: DbConnectDto) {
    const url = this.buildUrl(dto);
    const result = await this.probe(url);
    return result;
  }

  @Post("save")
  async save(@Body() dto: DbConnectDto) {
    const writable = canWriteConfig();
    if (!writable.writable) {
      throw new BadRequestException(
        `설정 파일을 쓸 수 없습니다: ${writable.path}\n` +
          `디렉터리 쓰기 권한을 확인하세요. (${writable.reason ?? "권한 없음"})`,
      );
    }

    const url = this.buildUrl(dto);
    const probe = await this.probe(url);
    if (!probe.ok) throw new BadRequestException(probe.message);

    writeConfigFile({ databaseUrl: url, siteUrl: dto.siteUrl });
    return {
      ok: true,
      configPath: writable.path,
      // 설정 파일을 반영하려면 프로세스를 다시 띄워야 한다.
      // (연결 풀과 마이그레이션이 부팅 시점에 만들어지기 때문)
      restartRequired: true,
      message:
        "데이터베이스 설정을 저장했습니다. 서버를 재시작하면 설치를 계속할 수 있습니다.",
    };
  }

  private buildUrl(dto: DbConnectDto): string {
    const host = String(dto?.host ?? "").trim();
    const database = String(dto?.database ?? "").trim();
    const user = String(dto?.user ?? "").trim();
    const password = String(dto?.password ?? "");
    const port = Number(dto?.port ?? 5432);

    if (!host) throw new BadRequestException("데이터베이스 주소를 입력해주세요.");
    if (!database) throw new BadRequestException("데이터베이스 이름을 입력해주세요.");
    if (!user) throw new BadRequestException("사용자 이름을 입력해주세요.");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestException("포트 번호가 올바르지 않습니다.");
    }
    // 값에 특수문자가 있어도 안전하게 URL을 만든다
    const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
    const q = dto.ssl ? "?sslmode=require" : "";
    return `postgresql://${auth}@${host}:${port}/${encodeURIComponent(database)}${q}`;
  }

  /** 접속 + 권한 확인. 테이블을 만들 권한이 없으면 마이그레이션이 실패하므로 미리 본다 */
  private async probe(url: string): Promise<{ ok: boolean; message: string; version?: string }> {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
    try {
      await client.connect();
      const { rows } = await client.query("SELECT version() AS v");
      const version = String(rows[0]?.v ?? "").split(" ").slice(0, 2).join(" ");

      // PostgreSQL 버전 확인 (JSONB/GIN 등을 쓰므로 최소 요구사항이 있다)
      const major = Number(/PostgreSQL (\d+)/.exec(version)?.[1] ?? 0);
      if (major && major < 14) {
        return { ok: false, message: `PostgreSQL 14 이상이 필요합니다. (현재 ${version})` };
      }

      // 테이블 생성 권한 확인 — 여기서 걸러야 설치 중간에 실패하지 않는다
      await client.query("CREATE TABLE IF NOT EXISTS brick_permission_probe (x int)");
      await client.query("DROP TABLE IF EXISTS brick_permission_probe");

      return { ok: true, message: `연결 성공 (${version})`, version };
    } catch (err) {
      return { ok: false, message: this.explain(err) };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** pg 에러를 사람이 조치할 수 있는 문장으로 바꾼다 */
  private explain(err: unknown): string {
    const e = err as { code?: string; message?: string };
    switch (e.code) {
      case "ECONNREFUSED":
        return "데이터베이스 서버에 연결할 수 없습니다. 주소와 포트를 확인하세요.";
      case "ENOTFOUND":
        return "데이터베이스 주소를 찾을 수 없습니다. 호스트명을 확인하세요.";
      case "ETIMEDOUT":
        return "연결 시간이 초과되었습니다. 방화벽이나 접근 허용 IP를 확인하세요.";
      case "28P01":
        return "사용자 이름 또는 비밀번호가 올바르지 않습니다.";
      case "3D000":
        return "해당 이름의 데이터베이스가 없습니다. 먼저 데이터베이스를 만들어주세요.";
      case "42501":
        return "이 사용자에게 테이블 생성 권한이 없습니다. 권한을 부여해주세요.";
      default:
        return e.message ?? "연결에 실패했습니다.";
    }
  }
}
