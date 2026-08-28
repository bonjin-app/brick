import type { CacheProvider } from "../providers/cache.js";
import type { QueueProvider } from "../providers/queue.js";
import type { StorageProvider } from "../providers/storage.js";
import type { MailProvider } from "../providers/mail.js";
import type { CaptchaProvider } from "../providers/captcha.js";
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
  /**
   * 캡차. 비회원 글쓰기·댓글 같은 스팸 표적 경로에서 검증한다.
   * `enabled` 가 false면 검사가 비활성이므로 UI도 숨겨야 한다.
   */
  readonly captcha: CaptchaProvider;
  /** 플러그인 전용 네임스페이스가 적용된 설정 저장소 */
  readonly settings: {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
  };
  /** DB 핸들 (플러그인 마이그레이션은 로더가 활성화 시점에 실행) */
  readonly db: PluginDb;

  /**
   * 사이트 정보 — 메일에 넣을 링크와 이름.
   *
   * 플러그인이 `process.env` 를 직접 읽으면 코어의 검증(형식·후행 슬래시
   * 정리)을 우회하고, 플러그인마다 다르게 처리하게 된다. 메일에 링크를 넣는
   * 플러그인이 여럿이므로 계약으로 준다.
   */
  /**
   * 로그.
   *
   * 플러그인이 로그를 남길 방법이 없었다. 요청 처리 중 오류는 코어가 잡아
   * 응답으로 만들지만, **백그라운드 작업(큐 워커·스윕)의 실패는 아무도 모른다.**
   * 조용히 실패하는 배경 작업은 없는 기능과 같다.
   *
   * 메시지에 플러그인 이름이 자동으로 붙는다 — 어느 플러그인이 낸 로그인지
   * 모르면 여러 플러그인이 도는 사이트에서 추적할 수 없다.
   */
  readonly logger: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };

  readonly site: {
    /** 후행 슬래시 없는 사이트 주소 */
    readonly url: string;
    /** 설정된 사이트 이름 (메일 본문·제목에 쓴다) */
    name(): Promise<string>;
  };
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
  /**
   * 다른 플러그인이 쓸 수 있는 서비스를 공개한다.
   *
   * 훅(action/filter)으로는 표현할 수 없는 협력이 있다:
   *  - 호출자의 **트랜잭션에 참여**해야 하는 경우 (주문과 포인트 차감의 원자성)
   *  - 여러 메서드를 가진 인터페이스를 노출해야 하는 경우
   *
   * 이름은 전역이므로 기능을 나타내는 짧은 이름을 쓴다(예: "points").
   * 플러그인이 비활성화되면 자동으로 등록이 해제된다.
   */
  provideService<T>(name: string, impl: T): void;
  /**
   * 다른 플러그인이 공개한 서비스를 가져온다. 없으면 null.
   *
   * **반드시 null을 처리해야 한다.** 해당 플러그인이 설치·활성화되지 않았을 수 있다.
   * (포인트 플러그인이 없어도 쇼핑몰은 동작해야 한다)
   *
   * 활성화 순서에 의존하지 않으려면 활성화 시점이 아니라 **사용 시점**에 호출한다.
   */
  useService<T>(name: string): T | null;
  /**
   * 이 플러그인이 보관하는 **개인정보를 지우는 방법**을 등록한다.
   *
   * 회원 탈퇴는 코어 기능이지만, 코어는 플러그인의 테이블 이름을 알 수 없다.
   * 알려고 하면 두 가지가 깨진다 — 코어가 플러그인에 의존하게 되고,
   * 플러그인이 스키마를 바꾸면 탈퇴가 조용히 실패한다
   * (실제로 shop_cart_items 에 user_id 가 없어서 탈퇴가 500이 났다).
   *
   * 그래서 각 플러그인이 자기 데이터를 책임진다. 코어는 등록된 eraser 를
   * **탈퇴 트랜잭션 안에서** 순서대로 부르고, 하나라도 실패하면 탈퇴 전체를
   * 되돌린다 — 지우지 못한 것을 지웠다고 말하지 않기 위해서다.
   *
   * `describe` 는 탈퇴 전 안내에 쓴다. 무엇이 사라지는지 알려주지 않으면
   * 나중에 항의가 들어온다(특히 포인트와 주문 내역).
   */
  registerDataEraser(eraser: PersonalDataEraser): void;
  /**
   * 이 플러그인이 만드는 **공개 URL 목록**을 사이트맵에 제공한다.
   *
   * 코어는 페이지만 안다. 게시글·상품 주소는 플러그인이 만들었으므로
   * 플러그인만 알 수 있다 — 등록하지 않으면 검색엔진이 그 주소를 찾지 못한다.
   *
   * 큰 사이트를 전제로 **페이지 단위**로 요구한다. 그누보드 사이트는 게시글이
   * 십만 건인 경우가 흔하고, 한 번에 다 읽으면 메모리가 터진다.
   */
  registerSitemapSource(source: SitemapSource): void;

  /**
   * 통합검색 공급자를 등록한다.
   *
   * 없으면 그 플러그인의 내용은 **검색되지 않는다.** 코어는 페이지만 알므로
   * 게시글과 상품은 각 플러그인이 등록해야 찾을 수 있다.
   */
  registerSearchSource(source: SearchSource): void;
}

/** 통합검색 결과 한 건 */
export interface SearchHit {
  /** 사이트 루트 기준 경로 */
  path: string;
  title: string;
  /** 검색어 주변 발췌. 없으면 화면이 제목만 보여준다 */
  excerpt?: string | null;
  /** 작성·등록 시각 — 최신순 정렬과 화면 표시에 쓴다 */
  date?: Date | string | null;
  /** 목록에 함께 보여줄 부가 정보 (게시판 이름, 가격 등) */
  meta?: string | null;
}

/**
 * 통합검색 공급자.
 *
 * ── 반드시 지켜야 하는 것 ────────────────────────────
 *
 * **볼 수 없는 것을 내보내지 않는다.** 비밀글, 비공개 게시판, 임시 상품,
 * 남의 문의는 제외해야 한다. 검색은 권한 검사를 우회하는 가장 흔한 경로다 —
 * 목록에 제목만 나와도 내용이 새어 나가는 경우가 있다.
 *
 * `count` 와 `search` 는 **같은 조건**을 써야 한다. 다르면 "37건" 이라고
 * 표시하고 20건만 보여주거나, 마지막 페이지가 비어 나온다.
 */
export interface SearchSource {
  /** 화면의 분류 탭에 쓰는 이름 (예: "게시글") */
  label: string;
  /** 분류 코드 — 특정 분류만 검색할 때 쓴다 (예: "posts") */
  code: string;
  /** 목록에서의 순서. 작을수록 먼저 */
  order?: number;
  /** 조건에 맞는 전체 개수. `search` 와 같은 조건이어야 한다 */
  count(params: SearchParams): Promise<number>;
  search(params: SearchParams & { offset: number; limit: number }): Promise<SearchHit[]>;
}

export interface SearchParams {
  /** 다듬어진 검색어 */
  query: string;
  /**
   * 검색하는 사람.
   *
   * 권한에 따라 결과가 달라져야 한다 — 로그인한 회원만 읽는 게시판, 자기
   * 문의 등. null 이면 비회원이다.
   */
  viewer: { id: string; role: string } | null;
}

/** 사이트맵 항목 */
export interface SitemapUrl {
  /** 사이트 루트 기준 경로 (예: "/board/free/123"). 절대 URL도 허용 */
  path: string;
  /** 마지막 수정 시각 */
  lastmod?: Date | string | null;
  /** 변경 빈도 힌트 */
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  /** 0.0~1.0 */
  priority?: number;
}

/**
 * 사이트맵 URL 공급자.
 *
 * 정렬은 **안정적이어야 한다.** 페이지를 나눠 읽는 동안 순서가 바뀌면
 * 어떤 URL은 두 번 나오고 어떤 URL은 빠진다. created_at 처럼 변하지 않는
 * 컬럼으로 정렬하고, 동률은 id 로 깬다.
 */
export interface SitemapSource {
  /** 로그와 진단에 쓰는 이름 (예: "게시글") */
  label: string;
  /** 전체 개수 — 사이트맵 인덱스를 몇 조각으로 나눌지 계산한다 */
  count(): Promise<number>;
  /** offset 부터 limit 개 */
  page(params: { offset: number; limit: number }): Promise<SitemapUrl[]>;
}

/**
 * 플러그인이 보관한 개인정보의 처리 방법.
 *
 * 지우기만 하는 것이 아니다. 전자상거래법은 거래 기록을 5년간 보존하라고 하고
 * 개인정보보호법은 지체 없이 파기하라고 한다 — 둘 다 지키려면
 * **개인을 지우고 거래를 남긴다**(익명화). 그 판단은 도메인을 아는 플러그인이 한다.
 */
export interface PersonalDataEraser {
  /** 로그와 응답에 쓰는 이름 (예: "게시판") */
  label: string;
  /**
   * 실행 순서. 작을수록 먼저.
   * 참조 관계가 있으면 조정한다 (기본 100).
   */
  order?: number;
  /**
   * 지운다/익명화한다. **탈퇴 트랜잭션 안에서** 호출되므로
   * 넘어온 `tx` 를 써야 한다 — ctx.db 를 쓰면 트랜잭션 밖으로 나간다.
   *
   * @returns 사용자에게 보여줄 처리 내역 (예: ["쪽지 12건 삭제"])
   */
  erase(params: {
    tx: PluginDb;
    userId: string;
    /** 작성한 글까지 지울지 — 회원이 선택한다 */
    deletePosts: boolean;
  }): Promise<string[]>;
  /**
   * 탈퇴 전 안내. 없으면 안내를 만들지 않는다.
   * 되돌릴 수 없는 손실(포인트 소멸 등)은 반드시 여기서 알려야 한다.
   */
  describe?(params: { userId: string }): Promise<Array<{ label: string; detail: string }>>;
}

/** 관리자 화면에서 편집 가능한 필드 */
export interface AdminField {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "money" | "boolean" | "select" | "date" | "image" | "richtext";
  /** select 타입의 선택지 */
  options?: Array<{ value: string; label: string }>;
  /**
   * 선택지를 **라우트에서 가져온다** (select 타입).
   *
   * 플러그인 기준 경로(예: `/admin/options/categories`)이고, 응답은
   * `[{ value, label }]` 이어야 한다. `options` 와 함께 주면 라우트 결과가
   * 뒤에 붙는다.
   *
   * 필요한 이유: 분류처럼 **선택지가 테이블 행인 경우** 정적 목록으로는
   * 표현할 수 없다. 상품에 분류를 지정하는 화면이 없어서 분류를 만들어도
   * 쓸 수 없던 것이 실제 문제였다.
   *
   * 값이 비어 있을 수 있는 필드(required 아님)에는 화면이 "선택 없음"을
   * 맨 앞에 넣는다.
   */
  optionsFrom?: string;
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

/** 플러그인 라우트가 받는 업로드 파일 */
export interface PluginUploadedFile {
  fileName: string;
  contentType: string;
  buffer: Buffer;
}

export type PluginRouteHandler = (req: {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  user: { id: string; role: string; displayName?: string; email?: string } | null;
  /**
   * 클라이언트 IP. 요청 제한·도배 방지에 쓴다.
   * 프록시 뒤에서는 코어가 X-Forwarded-For를 해석한 값을 넣는다
   * (BRICK_TRUST_PROXY 설정에 따름).
   */
  ip: string;
  /**
   * multipart 업로드 파일을 읽는다. 파일이 없으면 빈 배열.
   * 호출하지 않으면 본문을 읽지 않으므로, 업로드를 받지 않는 라우트는 부담이 없다.
   */
  files: () => Promise<PluginUploadedFile[]>;
}) => Promise<unknown>;

/**
 * JSON이 아닌 응답(RSS, XML, 사이트맵 등)을 돌려줄 때 쓴다.
 *
 * instanceof 대신 구조적 표시를 쓴다 — 모듈 사본이 다를 수 있는 환경에서
 * instanceof는 신뢰할 수 없다.
 */
export interface PluginRawResponse {
  readonly __brickRaw: true;
  body: string | Buffer;
  contentType: string;
  status?: number;
  headers?: Record<string, string>;
}

/** 원본 응답 생성 헬퍼 */
export function rawResponse(
  body: string | Buffer,
  contentType: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): PluginRawResponse {
  return { __brickRaw: true, body, contentType, ...init };
}

export function isRawResponse(value: unknown): value is PluginRawResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brickRaw?: unknown }).__brickRaw === true
  );
}

/**
 * 블록 렌더 컨텍스트.
 *
 * 왜 필요한가: 게시판 상세(/board/free/<글id>)나 페이지네이션처럼 URL에 따라
 * 내용이 달라지는 블록은 요청 정보를 알아야 한다. props만으로는 불가능하다.
 */
export interface BlockRenderContext {
  /** 컨테이너 블록의 자식 렌더 결과 */
  children: string[];
  /** 전체 요청 경로 (앞뒤 슬래시 없음). 예: "board/free/01a0..." */
  path: string;
  /**
   * 페이지 slug 이후의 나머지 경로.
   * 페이지 slug가 "board/free"이고 요청이 "/board/free/01a0..." 이면 "01a0...".
   * 게시판 블록은 이 값으로 목록/상세/글쓰기를 구분한다.
   */
  pathTail: string;
  /** 쿼리스트링 */
  query: Record<string, string>;
  /** 요청한 사용자 (비로그인이면 null). 수정 버튼 표시 등에 쓴다 */
  user: { id: string; role: string; displayName: string } | null;
}

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
   *
   * ctx로 요청 정보를 받는다. 게시판 상세처럼 URL에 따라 내용이 달라지는 블록은
   * ctx.pathTail / ctx.query 를 읽고, 컨테이너 블록은 ctx.children 을 쓴다.
   */
  render: (props: Record<string, unknown>, ctx: BlockRenderContext) => Promise<string>;
}

export interface PluginInstance {
  /** 비활성화 시 호출. 타이머/구독 정리 */
  deactivate?: () => Promise<void>;
}
