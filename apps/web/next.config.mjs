import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // /api/*, /uploads/*, /themes/* 는 Route Handler가 런타임에 프록시한다
  // (src/lib/proxy.ts 참고). rewrites를 쓰지 않는 이유:
  // standalone 빌드에서 rewrites의 destination은 빌드 시점에 고정되므로,
  // 배포본을 다른 포트로 띄우면 깨진다 — FTP 배포 환경에서 치명적이다.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Brick 은 next/image 를 쓰지 않는다 — 이미지 처리는 API(sharp)가 업로드 시점에 한다.
  // 그런데 sharp 가 모노레포에 있으면 Next 가 standalone 에 그것을 통째로 추적해 넣는다:
  // libvips 바이너리가 glibc·musl 두 벌(36MB) 씩, 배포본과 Docker 이미지 양쪽에 중복으로.
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    "*": [
      "node_modules/.pnpm/sharp*/**",
      "node_modules/.pnpm/@img+*/**",
      // 빌드 도구 — 런타임에 필요 없는데 추적에 딸려 온다 (typescript 9MB · esbuild 11MB · webpack 7MB)
      "node_modules/.pnpm/typescript@*/**",
      "node_modules/.pnpm/@esbuild+*/**",
      "node_modules/.pnpm/esbuild@*/**",
      "node_modules/.pnpm/webpack@*/**",
      "node_modules/.pnpm/terser@*/**",
    ],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  // Next 가 직접 그리는 화면(로그인·가입·마이페이지·관리·설치)에도 API 와 같은 보안 헤더를 붙인다.
  // API 응답의 헤더는 프록시를 통과하지만, 이 화면들은 API 를 거치지 않는다.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
        ],
      },
    ];
  },
};

export default nextConfig;
