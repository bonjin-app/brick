import type { CacheProvider } from "../providers/cache.js";
import type { QueueProvider } from "../providers/queue.js";
import type { StorageProvider } from "../providers/storage.js";
import type { HookBus } from "../hooks/hook-bus.js";

/**
 * PluginContext — 플러그인 entry(dist/index.js)의 default export가 받는 단일 인자.
 *
 * 플러그인 진입점 계약:
 *   export default function activate(ctx: PluginContext): PluginInstance
 *
 * 플러그인은 이 컨텍스트를 통해서만 Brick과 상호작용한다.
 * (직접 DB 커넥션을 만들거나 포트를 여는 것은 금지)
 */
export interface PluginContext {
  readonly pluginName: string;
  readonly hooks: HookBus;
  readonly cache: CacheProvider;
  readonly queue: QueueProvider;
  readonly storage: StorageProvider;
  /** 플러그인 전용 네임스페이스가 적용된 설정 저장소 */
  readonly settings: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
  };
  /** Drizzle DB 핸들 (플러그인 마이그레이션은 로더가 활성화 시점에 실행) */
  readonly db: unknown;
  /** REST 라우트 등록: /api/plugins/<pluginName>/ 아래에 마운트된다 */
  registerRoute(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: PluginRouteHandler): void;
  /** 페이지 빌더에서 쓸 수 있는 Block 등록 */
  registerBlock(block: BlockDefinition): void;
  /** 관리자 메뉴 항목 등록 */
  registerAdminMenu(item: { label: string; path: string; icon?: string }): void;
}

export type PluginRouteHandler = (req: {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  user: { id: string; role: string } | null;
}) => Promise<unknown>;

/**
 * Block — 페이지 빌더의 최소 단위.
 * render는 서버에서 HTML 문자열을 만들거나(SSR/SEO),
 * clientComponent로 사전 빌드된 React 컴포넌트 이름을 지정한다.
 */
export interface BlockDefinition {
  name: string; // 예: "board/latest-posts"
  displayName: string;
  /** 속성 편집 UI 생성용 JSON Schema */
  propsSchema?: Record<string, unknown>;
  /** 서버 렌더 함수 — SEO를 위해 항상 HTML을 반환할 수 있어야 한다 */
  render: (props: Record<string, unknown>) => Promise<string>;
}

export interface PluginInstance {
  /** 비활성화 시 호출. 타이머/구독 정리 */
  deactivate?: () => Promise<void>;
}
