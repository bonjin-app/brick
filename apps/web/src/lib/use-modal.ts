"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * 모달의 키보드 동작 — 포커스를 안으로 가두고, 닫으면 원래 자리로 돌려준다.
 *
 * 모달을 띄우는 것만으로는 절반이다. 포커스가 여는 버튼에 남아 있으면 키보드만 쓰는
 * 사람에게 그 모달은 **열렸지만 닿을 수 없는** 것이고(실제로 관리 화면 모달 셋이 그랬다),
 * Tab 을 누르면 뒤 화면의 마흔 개 요소를 돌아다닌다. 스크린리더도 뒤 화면을 읽는다.
 *
 * 네 가지를 한다.
 *   1. 열릴 때 모달 안 첫 요소로 포커스
 *   2. Tab·Shift+Tab 이 모달을 벗어나지 않게 (마지막에서 첫 번째로 감는다)
 *   3. Esc 로 닫기
 *   4. 배경 스크롤 잠금 — 뒤 화면이 움직이면 어디를 보고 있었는지 잃는다
 *
 * 반환한 ref 를 모달의 바깥 요소에 건다. 모달을 별도 컴포넌트로 뽑지 않고 조건부로
 * 그리는 화면도 있으므로, 그때는 `active` 로 열림 여부를 넘긴다.
 */
export function useModalFocus<T extends HTMLElement = HTMLDivElement>(onClose: () => void, active = true) {
  const ref = useRef<T>(null);
  /*
   * onClose 는 렌더마다 새 함수인 경우가 많다. 그것을 의존성에 넣으면 effect 가 다시 돌아
   * **입력 도중 포커스가 첫 요소로 튄다** — 최신 값만 ref 로 들고 effect 는 한 번만 돈다.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null;
    const listOf = (): HTMLElement[] =>
      ref.current ? [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.offsetParent !== null) : [];

    listOf()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const list = listOf();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (!ref.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      // 닫으면 열었던 자리로 — 그러지 않으면 키보드 사용자는 목록 맨 처음부터 다시 온다
      opener?.focus?.();
    };
  }, [active]);

  return ref;
}
