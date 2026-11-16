import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (local offline mode) loads its own wasm files at runtime: keep it out of the server bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
