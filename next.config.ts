import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * NOTE: `crossOrigin: "anonymous"` was considered here to stop the browser
   * masking our own chunk errors as "Script error." — but it is NOT safe on
   * this deployment. The attribute makes the browser fetch every script in CORS
   * mode, and nginx does not return `Access-Control-Allow-Origin` for
   * /_next/static/ (verified: `curl -I -H 'Origin: ...'` returns no CORS
   * header). Enabling it would fail every script load and take the whole app
   * down. To use it, nginx must first add the header for /_next/static/.
   *
   * The error badge instead recovers what it can from `e.error` in page.tsx.
   */
};

export default nextConfig;
