import { ArgumentsHost, Catch, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { DEFAULT_LOCALE, translateCoreError, type Locale } from "@brick/core";
import { loadEnv } from "../config/env.js";

/*
 * 업로드가 한도에 걸렸을 때 **한국어로, 한도를 숫자로** 말한다.
 *
 * 그 전에는 @fastify/multipart 의 원문이 그대로 손님과 운영자에게 갔다:
 *
 *   {"statusCode":413,"message":"request file too large"}
 *
 * 화면은 이 message 를 그대로 보여주므로 한국어 관리 화면에 "실패: request file
 * too large" 가 떴다. 무엇이 문제인지도, **한도가 얼마인지도** 알 수 없다.
 * 휴대폰 사진 한 장이 12MB 인 시대에 상품 사진을 올리는 사람이 가장 자주 만나는
 * 오류가 이것이다.
 *
 * 한도는 env 에서 읽는다 — 운영자가 BRICK_MAX_UPLOAD_MB 를 올려 두었으면 안내도
 * 그 숫자를 말해야 한다. 안내가 실제 설정과 다르면 없느니만 못하다.
 *
 * 그 외 오류는 손대지 않고 기본 처리에 넘긴다.
 */
const MESSAGES: Record<string, (env: ReturnType<typeof loadEnv>) => string> = {
  FST_REQ_FILE_TOO_LARGE: (env) =>
    `파일이 너무 큽니다. 한 개당 최대 ${env.maxUploadMb}MB까지 올릴 수 있습니다.`,
  FST_FILES_LIMIT: (env) =>
    `파일을 너무 많이 올렸습니다. 한 번에 최대 ${env.maxUploadFiles}개까지 올릴 수 있습니다.`,
  FST_PARTS_LIMIT: () => "한 번에 보낼 수 있는 항목 수를 넘었습니다. 파일을 나눠서 올려주세요.",
  FST_INVALID_MULTIPART_CONTENT_TYPE: () => "파일 업로드 형식이 아닙니다.",
  FST_ERR_CTP_BODY_TOO_LARGE: () => "보낸 내용이 너무 큽니다. 글을 나누거나 이미지를 파일로 첨부해주세요.",
};

/*
 * 오류 문장이 사이트 언어를 따른다.
 *
 * 화면·메일·관리 라벨은 전부 번역되는데 **서버가 던지는 문장만** 한국어였다.
 * 영어 사이트에서 비밀번호를 틀리면 "비밀번호가 올바르지 않습니다." 가 떴다 —
 * 무엇이 잘못됐는지가 적힌 그 문장만 못 읽는 셈이다.
 *
 * 화면은 서버가 준 message 를 그대로 보여주는 것이 이 저장소의 계약이므로,
 * 번역할 자리는 **응답 경계**다. 플러그인 오류는 디스패처가 각자의 카탈로그로
 * 이미 치환했고(원문=키), 여기서는 코어 문장을 같은 규칙으로 치환한다.
 *
 * `field`·`statusCode` 같은 나머지 칸은 손대지 않는다 — 화면이 `field` 로
 * 입력 칸을 찾아 손님을 데려가므로 번역되면 못 찾는다.
 */
@Catch()
export class ErrorMessageFilter extends BaseExceptionFilter {
  constructor(adapter: unknown, private readonly localeOf: () => Locale) {
    super(adapter as never);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const code = (exception as { code?: string })?.code ?? "";
    const build = MESSAGES[code];
    if (!build) {
      this.translated(exception, host);
      return;
    }
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const status = code === "FST_INVALID_MULTIPART_CONTENT_TYPE" ? 400 : 413;
    void reply.status(status).send({ statusCode: status, message: build(loadEnv()) });
  }

  /**
   * HttpException 의 message 만 갈아 끼워 기본 처리에 넘긴다.
   *
   * 새 예외를 만들어 넘기는 이유: 응답 본문의 모양(칸 이름·순서)을 여기서
   * 다시 만들면 Nest 의 기본 직렬화와 갈라진다 — 갈라진 뒤에는 한쪽만 고쳐진다.
   */
  private translated(exception: unknown, host: ArgumentsHost): void {
    const locale = safeLocale(this.localeOf);
    if (locale === DEFAULT_LOCALE || !(exception instanceof HttpException)) {
      super.catch(exception, host);
      return;
    }
    const body = exception.getResponse();
    const status = exception.getStatus();
    if (typeof body === "string") {
      super.catch(new HttpException(translateCoreError(locale, body), status), host);
      return;
    }
    const message = (body as { message?: unknown })?.message;
    if (typeof message === "string") {
      super.catch(
        new HttpException({ ...(body as object), message: translateCoreError(locale, message) }, status),
        host,
      );
      return;
    }
    // 검증 파이프는 message 를 배열로 준다 — 줄마다 같은 규칙으로 바꾼다
    if (Array.isArray(message)) {
      super.catch(
        new HttpException(
          { ...(body as object), message: message.map((m) => (typeof m === "string" ? translateCoreError(locale, m) : m)) },
          status,
        ),
        host,
      );
      return;
    }
    super.catch(exception, host);
  }
}

/** 언어를 읽다 실패해도 오류 응답 자체는 나가야 한다 — 그때는 원문(ko)이다 */
function safeLocale(read: () => Locale): Locale {
  try {
    return read();
  } catch {
    return DEFAULT_LOCALE;
  }
}
