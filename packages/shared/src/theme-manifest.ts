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
  assets?: string;  /** 업데이트 매니페스트 주소 (https). 플러그인과 같은 서명 규칙을 쓴다 */
  updates?: string;
  /** 배포자 Ed25519 공개키 (base64) — 처음 설치할 때 고정된다 */
  publisherKey?: string;
}
