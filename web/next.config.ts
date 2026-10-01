import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@signal-lab/shared"],
  reactStrictMode: true,
};

export default nextConfig;
