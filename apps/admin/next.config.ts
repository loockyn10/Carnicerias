import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@carnicerias/business-logic",
    "@carnicerias/database",
    "@carnicerias/types",
    "@carnicerias/ui"
  ]
};

export default nextConfig;

