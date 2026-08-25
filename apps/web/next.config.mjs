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
  output: "standalone", // Docker 이미지 최소화
};

export default nextConfig;
