import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirror tsconfig's `paths` ("@/*" -> "./src/*") so tests can import route
// handlers (which use "@/lib/...") and exercise the real API boundary.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
