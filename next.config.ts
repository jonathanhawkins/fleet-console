import type { NextConfig } from "next";

/**
 * STATIC_EXPORT=1 flips to `output: "export"` (`pnpm build:static`). Do not set
 * distDir: under export it becomes the export destination. Build isolation is
 * scripts/build-isolated.mjs (BUILD_ISOLATED_ROOT widens the Turbopack root).
 */
const nextConfig: NextConfig = {
  output: process.env.STATIC_EXPORT === "1" ? "export" : undefined,
  ...(process.env.BUILD_ISOLATED_ROOT
    ? { turbopack: { root: process.env.BUILD_ISOLATED_ROOT } }
    : {}),
};

export default nextConfig;
