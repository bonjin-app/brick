import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { BrickDb } from "@brick/database";
import { siteSettings } from "@brick/database";
import { DB } from "../../runtime.module.js";
import { MAINTENANCE_KEY, MAINTENANCE_MESSAGE_KEY } from "./maintenance-mode.js";

/**
 * 점검 모드 상태.
 *
 * **왜 따로 있나.** 이 값을 읽어야 하는 곳이 둘이다 — 공개 렌더(화면을 가린다)와
 * 플러그인 라우트 디스패처(쓰기를 막는다). 둘은 서로의 모듈을 이미 반대 방향으로
 * 쓰고 있어서, 한쪽이 다른 쪽을 읽으면 모듈이 순환한다. 그래서 아무에게도
 * 기대지 않는 작은 서비스로 두고 전역으로 내놓는다.
 */
@Injectable()
export class MaintenanceModeService {
  /** 공개 렌더 핫패스가 매번 읽는다 — 5초면 켜고 끄는 사이에 반영된다 */
  private cache = { at: 0, on: false };

  constructor(@Inject(DB) private readonly db: BrickDb) {}

  async isOn(): Promise<boolean> {
    if (Date.now() - this.cache.at < 5_000) return this.cache.on;
    const [row] = await this.db
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, MAINTENANCE_KEY))
      .limit(1);
    const on = row?.value === true || row?.value === "true";
    this.cache = { at: Date.now(), on };
    return on;
  }

  /** 운영자가 적어 둔 안내 문구 (비어 있으면 기본 문구를 쓴다) */
  async message(): Promise<string> {
    const [row] = await this.db
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, MAINTENANCE_MESSAGE_KEY))
      .limit(1);
    return String(row?.value ?? "").trim();
  }
}
