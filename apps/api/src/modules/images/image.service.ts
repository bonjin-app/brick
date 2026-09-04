import { Injectable, Logger } from "@nestjs/common";

/** sharp 팩토리 함수 타입. 모듈 네임스페이스(`typeof import`)는 호출할 수 없으므로 default 를 가리킨다 */
type SharpFactory = (typeof import("sharp"))["default"];

export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  /** 저장 키에 쓸 확장자 (".webp" 등). 변환하지 않았으면 원본 확장자를 그대로 쓰라는 뜻으로 null */
  ext: string | null;
  width: number | null;
  height: number | null;
}

export interface OptimizeOptions {
  /** 이 크기를 넘으면 비율을 유지하며 줄인다 (기본 2400) */
  maxWidth?: number;
  maxHeight?: number;
  /** JPEG·WebP 품질 (기본 82) */
  quality?: number;
}

export interface ThumbnailOptions {
  /** 정사각으로 자를 한 변 (기본 400). height 를 주면 그 비율로 자른다 */
  width?: number;
  height?: number;
  quality?: number;
}

/** 손대지 않는 형식 — 애니메이션(GIF)과 벡터(SVG)는 변환하면 잃는 것이 더 크다 */
const SKIP_MIME = new Set(["image/gif", "image/svg+xml", "image/avif"]);

/**
 * 업로드 이미지 처리 — 원본 축소와 썸네일.
 *
 * **왜 필요한가.** 손님이 휴대폰으로 찍은 사진은 4000×3000·4MB 다. 그것을 그대로 저장해
 * 목록에 뿌리면 게시판 한 화면이 수십 MB 가 된다(CSS 로 줄여도 내려받는 양은 같다).
 * 그누보드가 GD 로 썸네일을 만드는 이유이고, 여기서도 같은 일을 한다.
 *
 * **sharp 는 있으면 쓰고 없으면 넘어간다.** 네이티브 모듈이라 FTP 배포본을 예상과 다른
 * 아키텍처(arm64 서버에 x64 배포본 등)에 올리면 로드에 실패할 수 있다. 그때 업로드 자체가
 * 막히면 사이트를 못 쓰게 되므로 **원본을 그대로 저장하고 경고만 남긴다** — 기능이 하나
 * 줄어드는 것과 사이트가 멈추는 것은 다른 문제다.
 *
 * 부수 효과로 EXIF 를 지운다: 휴대폰 사진에는 촬영 위치(GPS)가 들어 있어, 그대로 공개하면
 * 글쓴이의 집 주소가 노출된다. 회전 정보만 픽셀에 반영하고 나머지 메타데이터는 버린다.
 */
@Injectable()
export class ImageService {
  private readonly log = new Logger(ImageService.name);
  private sharp: SharpFactory | null | undefined;

  /** sharp 를 쓸 수 있는가 — 첫 호출에서 한 번만 판정한다 */
  async isAvailable(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  /** 처리 가능한 이미지인가 (GIF·SVG 는 원본 유지) */
  canProcess(contentType: string): boolean {
    return contentType.startsWith("image/") && !SKIP_MIME.has(contentType);
  }

  /**
   * 원본을 적당한 크기로 줄이고 메타데이터를 지운다.
   * 처리하지 못하면 입력을 그대로 돌려준다(ext: null).
   */
  async optimize(buffer: Buffer, contentType: string, opts: OptimizeOptions = {}): Promise<ProcessedImage> {
    const untouched: ProcessedImage = { buffer, contentType, ext: null, width: null, height: null };
    if (!this.canProcess(contentType)) return untouched;
    const sharp = await this.load();
    if (!sharp) return untouched;

    const maxWidth = opts.maxWidth ?? 2400;
    const maxHeight = opts.maxHeight ?? 2400;
    const quality = opts.quality ?? 82;
    try {
      // rotate() 를 인자 없이 부르면 EXIF Orientation 을 픽셀에 적용한 뒤 태그를 지운다
      const pipeline = sharp(buffer, { failOn: "none" }).rotate();
      const meta = await pipeline.metadata();
      const needsResize = (meta.width ?? 0) > maxWidth || (meta.height ?? 0) > maxHeight;
      let work = pipeline;
      if (needsResize) work = work.resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true });

      // 형식은 유지한다 — 운영자가 PNG 로 올린 로고가 JPEG 이 되어 배경이 검게 되면 놀란다
      const isPng = contentType === "image/png";
      const out = isPng
        ? await work.png({ compressionLevel: 9, palette: true }).toBuffer({ resolveWithObject: true })
        : contentType === "image/webp"
          ? await work.webp({ quality }).toBuffer({ resolveWithObject: true })
          : await work.jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });

      // 처리 결과가 원본보다 크면 원본을 쓴다 (이미 최적화된 파일에 손대지 않는다).
      // 단 크기를 줄였다면 픽셀 수가 달라졌으니 결과를 쓴다.
      if (!needsResize && out.data.length >= buffer.length) {
        return { ...untouched, width: meta.width ?? null, height: meta.height ?? null };
      }
      return {
        buffer: out.data,
        contentType,
        ext: null, // 형식을 유지했으므로 확장자도 그대로
        width: out.info.width,
        height: out.info.height,
      };
    } catch (err) {
      this.log.warn(`이미지 최적화 실패 — 원본을 저장합니다: ${err instanceof Error ? err.message : String(err)}`);
      return untouched;
    }
  }

  /**
   * 목록용 썸네일. 정사각으로 잘라 WebP 로 만든다 — 목록의 격자가 들쭉날쭉하지 않게.
   * 처리하지 못하면 null (호출자는 원본 URL 을 쓰면 된다).
   */
  async thumbnail(buffer: Buffer, contentType: string, opts: ThumbnailOptions = {}): Promise<ProcessedImage | null> {
    if (!this.canProcess(contentType)) return null;
    const sharp = await this.load();
    if (!sharp) return null;
    const width = opts.width ?? 400;
    const height = opts.height ?? width;
    try {
      const out = await sharp(buffer, { failOn: "none" })
        .rotate()
        .resize({ width, height, fit: "cover", position: "attention", withoutEnlargement: true })
        .webp({ quality: opts.quality ?? 78 })
        .toBuffer({ resolveWithObject: true });
      return { buffer: out.data, contentType: "image/webp", ext: ".webp", width: out.info.width, height: out.info.height };
    } catch (err) {
      this.log.warn(`썸네일 생성 실패: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async load(): Promise<SharpFactory | null> {
    if (this.sharp !== undefined) return this.sharp;
    try {
      const mod = await import("sharp");
      // CJS 상호운용: 번들러/런타임에 따라 default 가 한 겹 더 감싸일 수 있다
      const factory = (mod as unknown as { default?: SharpFactory & { default?: SharpFactory } }).default;
      this.sharp = (factory?.default ?? factory ?? (mod as unknown as SharpFactory)) as SharpFactory;
      this.log.log("이미지 처리 활성 (sharp) — 업로드 이미지를 줄이고 썸네일을 만듭니다");
    } catch (err) {
      this.sharp = null;
      this.log.warn(
        "sharp 를 불러올 수 없어 이미지 최적화를 건너뜁니다 (원본 그대로 저장). " +
          `이 서버 아키텍처의 바이너리를 설치하면 켜집니다: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return this.sharp;
  }
}
