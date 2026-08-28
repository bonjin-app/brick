/**
 * 사업자정보 표시.
 *
 * **법적 표시 의무다.** 전자상거래법 제13조는 통신판매업자가 상호 · 대표자 성명 ·
 * 주소 · 전화번호 · 사업자등록번호 · 통신판매업 신고번호를 소비자가 쉽게 알 수
 * 있도록 표시하라고 정한다. 표시하지 않으면 과태료 대상이고, 무엇보다
 * **쇼핑몰을 합법적으로 열 수 없다.**
 *
 * 왜 코어에 있는가:
 *   쇼핑몰 플러그인에 두면 플러그인을 끄는 순간 법적 표시가 사라진다.
 *   그리고 개인정보처리방침 표시는 쇼핑몰이 아닌 사이트에도 적용된다.
 *
 * 왜 테마가 아니라 설정인가:
 *   테마를 바꿀 때마다 다시 입력하게 만들면 빠뜨린다. 값은 사이트가 갖고,
 *   테마는 렌더만 한다.
 */

export interface BusinessInfo {
  /** 상호 (법인명 또는 개인 사업자명) */
  companyName: string;
  /** 대표자 성명 */
  representative: string;
  /** 사업자등록번호 (000-00-00000) */
  businessNo: string;
  /** 통신판매업 신고번호 (제2024-서울강남-0000호) */
  mailOrderNo: string;
  /** 사업장 주소 */
  address: string;
  phone: string;
  email: string;
  /** 개인정보 보호책임자 — 개인정보보호법 제31조상 지정·공개 의무 */
  privacyOfficer: string;
  /** 호스팅 서비스 제공자 — 전자상거래법 시행령상 표시 항목 */
  hostingProvider: string;
  /**
   * 결제대금예치(에스크로) 또는 소비자피해보상보험 안내.
   *
   * 전자상거래법 제24조: 선불식 통신판매업자는 결제대금예치나 소비자피해보상보험
   * 계약을 체결하고 **그 사실을 표시**해야 한다(일정 거래는 면제).
   *
   * 자유 입력으로 둔다 — 가입한 기관과 형태가 사업자마다 다르고, 우리가
   * 목록을 고정하면 없는 항목을 쓰는 사업자가 표시를 못 한다.
   */
  escrow: string;
}

// 체크섬은 코어에 있다 — 쇼핑몰 세금계산서 발급도 같은 규칙을 써야 한다
import { formatBusinessNo, isValidBusinessNo } from "@brick/core";
export { formatBusinessNo, isValidBusinessNo };

export const BUSINESS_INFO_KEYS = [
  "companyName",
  "representative",
  "businessNo",
  "mailOrderNo",
  "address",
  "phone",
  "email",
  "privacyOfficer",
  "hostingProvider",
  "escrow",
] as const;

export const EMPTY_BUSINESS_INFO: BusinessInfo = {
  companyName: "",
  representative: "",
  businessNo: "",
  mailOrderNo: "",
  address: "",
  phone: "",
  email: "",
  privacyOfficer: "",
  hostingProvider: "",
  escrow: "",
};

/** 화면에 보여줄 이름 — 관리 화면과 검증 메시지가 같은 문구를 쓴다 */
export const FIELD_LABEL: Record<keyof BusinessInfo, string> = {
  companyName: "상호",
  representative: "대표자",
  businessNo: "사업자등록번호",
  mailOrderNo: "통신판매업 신고번호",
  address: "사업장 주소",
  phone: "전화번호",
  email: "이메일",
  privacyOfficer: "개인정보 보호책임자",
  hostingProvider: "호스팅 제공자",
  escrow: "결제대금예치·피해보상보험",
};

/**
 * 쇼핑몰을 열려면 반드시 있어야 하는 항목.
 *
 * 나머지(개인정보 보호책임자·호스팅 제공자)도 의무지만, 사이트를 막지는 않고
 * 경고로 안내한다 — 설치 직후 아무것도 못 하게 만들면 쓸 수 없다.
 */
export const REQUIRED_FOR_COMMERCE: Array<keyof BusinessInfo> = [
  "companyName",
  "representative",
  "businessNo",
  "mailOrderNo",
  "address",
  "phone",
];

export interface ValidationResult {
  info: BusinessInfo;
  /** 저장을 막는 오류 */
  errors: string[];
  /** 저장은 되지만 알려야 하는 것 */
  warnings: string[];
}

/**
 * 입력 검증.
 *
 * 비어 있는 것은 허용한다 — 쇼핑몰이 아닌 사이트도 있고, 설치 직후에는
 * 아무 값도 없다. 대신 **값이 있으면 올바른지** 확인하고,
 * 빠진 필수 항목은 경고로 알린다.
 */
export function validateBusinessInfo(input: Partial<Record<string, unknown>>): ValidationResult {
  const info: BusinessInfo = { ...EMPTY_BUSINESS_INFO };
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of BUSINESS_INFO_KEYS) {
    const value = String(input?.[key] ?? "").trim();
    if (value.length > 300) {
      errors.push(`${FIELD_LABEL[key]}이(가) 너무 깁니다. (300자 이내)`);
      continue;
    }
    info[key] = value;
  }

  if (info.businessNo) {
    if (!isValidBusinessNo(info.businessNo)) {
      // 형식만 맞고 체크섬이 틀린 번호를 통과시키지 않는다.
      // 잘못된 번호를 표시하는 것은 표시하지 않는 것과 같은 문제가 된다.
      errors.push(
        "사업자등록번호가 올바르지 않습니다. 10자리 숫자와 검증번호를 확인해주세요.",
      );
    } else {
      info.businessNo = formatBusinessNo(info.businessNo);
    }
  }

  if (info.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.email)) {
    errors.push("이메일 주소 형식이 올바르지 않습니다.");
  }

  const missing = REQUIRED_FOR_COMMERCE.filter((k) => !info[k]);
  if (missing.length && missing.length < REQUIRED_FOR_COMMERCE.length) {
    // 일부만 채운 상태 — 표시 의무를 절반만 지킨 것이므로 알린다
    warnings.push(
      `쇼핑몰을 운영하려면 ${missing.map((k) => FIELD_LABEL[k]).join(" · ")}도 ` +
        `입력해야 합니다 (전자상거래법 제13조).`,
    );
  }
  if (info.companyName && !info.privacyOfficer) {
    warnings.push(
      "개인정보 보호책임자를 지정하고 공개해야 합니다 (개인정보보호법 제31조).",
    );
  }

  return { info, errors, warnings };
}

/** 쇼핑몰을 열 수 있는 상태인가 — 관리 화면이 경고를 띄우는 데 쓴다 */
export function isCommerceReady(info: BusinessInfo): { ready: boolean; missing: string[] } {
  const missing = REQUIRED_FOR_COMMERCE.filter((k) => !info[k]).map((k) => FIELD_LABEL[k]);
  return { ready: missing.length === 0, missing };
}

/**
 * 테마가 렌더할 값.
 *
 * 값이 없는 항목은 아예 내려보내지 않는다 — 테마가 `{{#if}}` 로 감싸지 않아도
 * "대표자: " 처럼 빈 라벨이 남지 않는다.
 */
export function toTemplateVars(info: BusinessInfo): Record<string, string> | null {
  const filled = BUSINESS_INFO_KEYS.filter((k) => info[k]);
  if (!filled.length) return null;

  const out: Record<string, string> = {};
  for (const key of filled) out[key] = info[key];
  return out;
}
