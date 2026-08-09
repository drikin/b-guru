// Next.js instrumentation: runs once on server startup (Node.js runtime).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initSchema } = await import("@/lib/db");
      await initSchema();
      console.log("[bsm] DB schema initialized");
    } catch (e) {
      console.error("[bsm] initSchema failed:", e);
    }
  }
}
