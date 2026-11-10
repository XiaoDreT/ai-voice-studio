import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "mammoth", "xlsx", "ffmpeg-static"],
  outputFileTracingIncludes: {
    "/api/**/*": [
      "node_modules/pdf-parse/**/*",
      "node_modules/pdfjs-dist/**/*",
      "node_modules/ffmpeg-static/**/*",
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
