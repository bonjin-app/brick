import type { ReactNode } from "react";
import { ThemeFrame } from "../../components/ThemeFrame";

// 사이트의 머리 · 푸터를 입힌다 — 테마와 로그인 상태에 따라 달라지므로 요청마다 그린다
export const dynamic = "force-dynamic";

export default function Layout({ children }: { children: ReactNode }) {
  return <ThemeFrame>{children}</ThemeFrame>;
}
