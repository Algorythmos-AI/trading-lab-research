import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // The build's commit, inlined at build time so /api/health reports what is actually live (CI sets it from
  // GITHUB_SHA; `make dashboard-deploy` passes it with --build-env). Empty for local builds.
  env: { BUILD_SHA: process.env.BUILD_SHA ?? "" },
  // Security headers live in vercel.json so they apply to every response Vercel serves.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
