import { Global, Module } from "@nestjs/common";
import { ImageService } from "./image.service.js";

/**
 * 이미지 처리 — 코어의 미디어·회원 아바타와 플러그인(게시판 인라인 이미지 등)이 모두 쓴다.
 * DB 를 건드리지 않으므로 RuntimeModule 에 의존하지 않는다(순환 없음).
 */
@Global()
@Module({
  providers: [ImageService],
  exports: [ImageService],
})
export class ImagesModule {}
