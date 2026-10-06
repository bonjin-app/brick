"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * 이 화면이 사이트의 머리 · 푸터 안에 들어 있는가.
 *
 * 로그인 · 가입 · 마이페이지는 단독 화면(전체 높이 · 회색 바탕 · 가운데 정렬)으로 설계되었다. 테마의 `<main>` 안에서는
 * 그 값들이 이중 여백과 바탕 띠가 되므로, 틀 안에서는 껍데기가 자기 높이 · 바탕 · 여백을 거두고 사이트 이름 머리글도
 * 감춘다(테마 머리에 이미 있다).
 */
const FramedContext = createContext(false);

export function FramedProvider({ children }: { children: ReactNode }) {
  return <FramedContext.Provider value={true}>{children}</FramedContext.Provider>;
}

export function useFramed(): boolean {
  return useContext(FramedContext);
}
