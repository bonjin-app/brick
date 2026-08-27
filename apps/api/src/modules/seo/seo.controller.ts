import { Controller, Get, Param, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { SeoService } from "./seo.service.js";

/**
 * sitemap.xml · robots.txt.
 *
 * 응답을 reply 로 직접 보낸다. @Header 로 content-type 을 바꾸고 문자열을
 * 반환하면 Nest 가 요청마다 "Content-Type doesn't match Reply body" 경고를 낸다 —
 * 크롤러가 이 경로를 자주 치므로 로그가 그 경고로 가득 찬다.
 *
 * 캐시는 1시간. 게시글이 올라오면 곧 반영되어야 하지만, 크롤러가 분당 요청하는
 * 것을 DB로 그대로 받을 이유는 없다.
 */
const CACHE = "public, max-age=3600";

@Controller()
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  @Get("sitemap.xml")
  async index(@Res() reply: FastifyReply): Promise<void> {
    const xml = await this.seo.index();
    await reply.type("application/xml; charset=utf-8").header("cache-control", CACHE).send(xml);
  }

  /** /sitemap-3.xml 같은 조각 */
  @Get("sitemap-:n.xml")
  async chunk(@Param("n") n: string, @Res() reply: FastifyReply): Promise<void> {
    const index = Number(n);
    const xml = Number.isInteger(index) && index >= 1 ? await this.seo.chunk(index) : null;
    if (xml === null) {
      // 없는 조각에 XML 오류 문서를 주지 않는다 — 크롤러는 404 를 이해한다
      await reply.code(404).type("text/plain; charset=utf-8").send("not found\n");
      return;
    }
    await reply.type("application/xml; charset=utf-8").header("cache-control", CACHE).send(xml);
  }

  @Get("robots.txt")
  async robots(@Res() reply: FastifyReply): Promise<void> {
    const body = await this.seo.robots();
    await reply.type("text/plain; charset=utf-8").header("cache-control", CACHE).send(body);
  }
}
