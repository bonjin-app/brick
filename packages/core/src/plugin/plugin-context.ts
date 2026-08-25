import type { CacheProvider } from "../providers/cache.js";
import type { QueueProvider } from "../providers/queue.js";
import type { StorageProvider } from "../providers/storage.js";
import type { MailProvider } from "../providers/mail.js";
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
  /** 메일 발송 (SMTP 미설정 시 콘솔 출력으로 폴백) */
  readonly mail: MailProvider;
  /** 플러그인 전용 네임스페이스가 적용된 설정 저장소 */
  readonly settings: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
  };
  /** DB 핸들 (플러그인 마이그레이션은 로더가 활성화 시점에 실행) */
  readonly db: PluginDb;
  /** REST 라우트 등록: /api/plugins/<pluginName>/ 아래에 마운트된다 */
  registerRoute(method: "GET" | "POST" | "PUT" | "DELETE", path: string, handler: PluginRouteHandler): void;
  /** 페이지 빌더에서 쓸 수 있는 Block 등록 */
  registerBlock(block: BlockDefinition): void;
  /** 관리자 메뉴 항목 등록 */
  registerAdminMenu(item: { label: string; path: string; icon?: string }): void;
  /**
   * 선언적 관리자 리소스 등록.
   *
   * 플러그인이 자기 관리 화면을 가지려면 React 코드를 넣어야 하는데, Next.js는
   * 빌드 타임에 라우트가 결정되므로 ZIP으로 배포되는 플러그인은 그럴 수 없다.
   * 그래서 "무엇을 편집할 수 있는가"만 선언하면 코어 관리자가 목록/폼 화면을
   * 런타임에 생성한다 — 빌드 없이 완전한 CRUD 화면을 얻는다.
   */
  registerAdminResource(resource: AdminResource): void;
}

/** 관리자 화면에서 편집 가능한 필드 */
export interface AdminField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "boolean" | "select" | "date" | "image" | "richtext";
  /** select 타입의 선택지 */
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  help?: string;
  /** 목록 화면에 표시할지 (미지정 시 표시하지 않음) */
  inList?: boolean;
  /** 폼에서 숨김 (읽기 전용 계산 필드 등) */
  readOnly?: boolean;
  placeholder?: string;
}

/**
 * 관리자 리소스 — 플러그인이 관리 화면을 선언하는 단위.
 *
 * 코어 관리자는 다음 규약으로 이 리소스의 REST 엔드포인트를 호출한다
 * (모두 /api/plugins/<plugin>/ 아래, registerRoute로 등록해야 한다):
 *   GET    <basePath>            → { items, total, page, pageSize }
 *   GET    <basePath>/:id        → 단일 레코드
 *   POST   <basePath>            → 생성
 *   PUT    <basePath>/:id        → 수정
 *   DELETE <basePath>/:id        → 삭제
 */
export interface AdminResource {
  /** URL 슬러그. 관리자에서 /admin/x/<plugin>/<name> 으로 접근 */
  name: string;
  /** 목록 화면 제목 */
  title: string;
  /** 단일 항목을 부르는 이름. 예: "상품" */
  itemLabel: string;
  /** REST 경로. registerRoute로 등록한 경로와 일치해야 한다. 예: "/products" */
  basePath: string;
  fields: AdminField[];
  /** 목록에서 각 행을 식별하는 필드 (기본 "id") */
  idField?: string;
  /** 허용 동작 (기본: 전부 허용) */
  can?: { create?: boolean; update?: boolean; delete?: boolean };
  /** 목록 상단에 표시할 설명 */
  description?: string;
  /** 관리자 메뉴에 표시할 순서 (작을수록 위) */
  order?: number;
}

/**
 * 플러그인에게 노출되는 DB 표면.
 *
 * `transaction()` 없이 `execute("BEGIN")` 을 호출하면 안 된다 — 커넥션 풀에서
 * 매 호출이 다른 커넥션을 받을 수 있어 트랜잭션이 성립하지 않는다.
 * 재고 차감·결제처럼 원자성이 필요한 로직은 반드시 transaction()을 써야 한다.
 */
export interface PluginDb {
  execute(query: unknown): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** 콜백 전체가 하나의 커넥션·하나의 트랜잭션에서 실행된다. 예외를 던지면 롤백된다. */
  transaction<T>(fn: (tx: PluginDb) => Promise<T>): Promise<T>;
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
  /** 컨테이너 블록 여부 (자식 블록을 가질 수 있는가) — 빌더 UI 힌트 */
  acceptsChildren?: boolean;
  /**
   * 서버 렌더 함수 — SEO를 위해 항상 HTML을 반환할 수 있어야 한다.
   * children: 자식 블록들의 렌더 결과 (컨테이너 블록용)
   */
  render: (props: Record<string, unknown>, children?: string[]) => Promise<string>;
}

export interface PluginInstance {
  /** 비활성화 시 호출. 타이머/구독 정리 */
  deactivate?: () => Promise<void>;
}
