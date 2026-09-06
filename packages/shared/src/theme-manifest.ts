/**
 * Theme ZIP 루트에 위치하는 brick.theme.json 스키마.
 *
 * 설계 원칙 (가장 중요):
 *  - Theme은 빌드가 필요 없는 런타임 템플릿이다. ZIP 업로드 = 즉시 적용.
 *  - Theme은 레이아웃/토큰/템플릿만 담당한다. React 컴포넌트(Block)는
 *    Core와 Plugin이 공급하며 빌드 파이프라인을 타는 것은 그쪽뿐이다.
 */
export interface ThemeManifest {
  name: string;
  version: string;
  displayName: string;
  description?: string;
  author?: string;
  brickVersion: string;
  /** templates/ 안의 템플릿 파일 목록. 키는 슬롯 이름 */
  templates: {
    layout: string; // 예: "templates/layout.html"
    home?: string;
    page?: string;
    post?: string;
    board?: string;
    [slot: string]: string | undefined;
  };
  /** 디자인 토큰: CSS 변수로 주입된다 */
  tokens?: Record<string, string>;
  /** 정적 자산 디렉터리. 예: "assets" → /themes/<name>/assets/* 로 서빙 */
  assets?: string;
  /**
   * 이 테마가 필요로 하는 **외부 출처**. 코어의 기본 CSP 는 자기 도메인만 허용하므로,
   * 웹폰트 CDN 처럼 바깥에서 가져오는 것이 있으면 여기에 적어야 브라우저가 막지 않는다.
   *
   *   "csp": { "style-src": ["https://fonts.googleapis.com"], "font-src": ["https://fonts.gstatic.com"] }
   *
   * `script-src` 는 받지 않는다 — 테마가 외부 스크립트를 불러오는 것은 저장형 XSS 와 구분할 수 없고,
   * 테마는 레이아웃과 토큰을 담당한다는 계약을 넘어선다(그런 기능은 플러그인이 한다).
   */
  csp?: Partial<Record<"style-src" | "font-src" | "img-src" | "media-src" | "frame-src" | "connect-src", string[]>>;  /** 업데이트 매니페스트 주소 (https). 플러그인과 같은 서명 규칙을 쓴다 */
  updates?: string;
  /** 배포자 Ed25519 공개키 (base64) — 처음 설치할 때 고정된다 */
  publisherKey?: string;
}
