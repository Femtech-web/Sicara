import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingExcludes: {
    "/*": ["./.local/**/*", "./private-notes/**/*", "./marketing/**/*", "./experiments/**/*", "./contracts/**/*", "./.env*"],
  },
  experimental: { optimizePackageImports: ["@phosphor-icons/react"] },
};

export default config;
