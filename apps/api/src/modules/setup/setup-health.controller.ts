import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";

/**
 * setup 모드 헬스체크.
 * liveness는 통과시키되 readiness는 실패시킨다 — 아직 트래픽을 받을 상태가 아니다.
 * (오케스트레이터가 설치 완료 전 컨테이너를 정상으로 오인하지 않게 한다)
 */
@Controller()
export class SetupHealthController {
  @Get("healthz")
  live() {
    return { status: "ok", mode: "setup" };
  }

  @Get("readyz")
  ready() {
    throw new ServiceUnavailableException({ status: "setup_required", database: "not_configured" });
  }

  /** 공개 사이트(Next.js)가 설치 상태를 판별하는 데 쓰는 경로 */
  @Get("api/install/status")
  installStatus() {
    return { state: "needs_database" };
  }
}
