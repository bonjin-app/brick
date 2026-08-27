import { Injectable } from "@nestjs/common";
import type { PersonalDataEraser } from "@brick/core";
import { PluginLoaderService } from "../plugins/plugin-loader.service.js";

/**
 * 개인정보 삭제 처리기 모음.
 *
 * 왜 얇은 래퍼가 필요한가:
 *   WithdrawalService 가 PluginLoaderService 를 직접 주입하면 순환이 생긴다 —
 *   플러그인 모듈은 코어 서비스를 쓰고, 코어는 플러그인 목록을 알아야 한다.
 *   필요한 것(정렬된 eraser 목록) 하나만 노출해 방향을 한쪽으로 만든다.
 */
@Injectable()
export class DataErasers {
  constructor(private readonly plugins: PluginLoaderService) {}

  /** 실행 순서대로. order 가 같으면 등록 순서를 유지한다 */
  list(): Array<PersonalDataEraser & { plugin: string }> {
    return [...this.plugins.dataErasers].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }
}
