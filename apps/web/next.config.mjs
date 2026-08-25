import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const API = process.env.BRICK_API_URL ?? "http://localhost:3001";

const nextConfig = {
  // 사용자에게는 Next.js(3000)만 노출된다.
  // /api/*, /uploads/*, /themes/* 는 내부 Brick API로 프록시.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
      { source: "/uploads/:path*", destination: `${API}/uploads/:path*` },
      { source: "/themes/:path*", destination: `${API}/themes/:path*` },
    ];
  },
  // Docker 이미지 최소화. 모노레포에서는 tracing root를 워크스페이스 루트로 지정해야
  // .next/standalone 안에 필요한 패키지가 모두 포함된다.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
