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
