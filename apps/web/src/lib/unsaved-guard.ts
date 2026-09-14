"use client";

import { useEffect } from "react";

/*
 * 저장하지 않은 편집을 들고 창을 닫으려 하면 브라우저가 한 번 묻게 한다.
 *
 * 게시판은 손님이 쓰던 글을 초안으로 지켜 준다(자동 저장 + 복구 안내).
 * 그런데 **운영자가 만든 페이지는 새로고침 한 번에 전부 사라졌다** — 블록을
 * 열몇 개 쌓아 만든 랜딩 페이지가 뒤로가기 한 번에 없어진다. 같은 원칙이
 * 한쪽에만 적용돼 있었다.
 *
 * 초안 저장까지 가지 않고 **묻기만** 한다. 브라우저가 보여 주는 문구는
 * 우리가 정할 수 없다(스팸 방지로 고정돼 있다) — 사용자가 실제로 무언가를
 * 입력한 뒤에만 이 경고가 뜨는 것도 브라우저 규칙이다. 그래서 "실수로 닫기"
 * 만 막고, 아무것도 안 한 채 나가는 사람은 방해하지 않는다.
 */
export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 오래된 브라우저는 returnValue 를 봐야 경고를 띄운다
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
