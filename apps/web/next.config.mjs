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
};

export default nextConfig;
