/**
 * Plugin ZIP 루트에 위치하는 brick.plugin.json 스키마.
 *
 * 설계 원칙:
 *  - Plugin은 사전 빌드된 JS(dist/)를 포함해 배포한다. 서버에서 빌드하지 않는다.
 *  - Plugin은 Brick Runtime과 같은 Node 프로세스 안에서 실행된다. (프로세스 분리 금지)
 *  - Plugin이 자기 테이블을 소유한다: Drizzle 마이그레이션 파일을 함께 배포한다.
 */
export interface PluginManifest {
  /** 전역 고유 식별자. 예: "brick-board" */
  name: string;
  version: string;
  displayName: string;
  description?: string;
  author?: string;
  /** 호환되는 Brick Core 버전 범위 (semver range) */
  brickVersion: string;
  /** 런타임 진입점. ZIP 루트 기준 상대 경로. 예: "dist/index.js" */
  entry: string;
  /** 이 플러그인이 소유한 마이그레이션 디렉터리. 예: "migrations" */
  migrations?: string;
  /** 관리자 화면에 노출할 설정 스키마 (JSON Schema) */
  settingsSchema?: Record<string, unknown>;
  /** 의존하는 다른 플러그인 */
  dependencies?: Record<string, string>;
}

export type PluginStatus = "installed" | "active" | "inactive" | "error";
