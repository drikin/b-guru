// Next.js instrumentation: runs once on server startup (Node.js runtime).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initSchema } = await import("@/lib/db");
      await initSchema();
      // 部活カタログ（DB管理化）: 空なら現行カタログを seed（冪等）。
      const { ensureClubsSeeded } = await import("@/lib/club-store");
      await ensureClubsSeeded();
      console.log("[bsm] DB schema initialized + clubs seeded");
      const { ensureHousekeeping } = await import("@/lib/housekeeping");
      ensureHousekeeping();
      const { ensureJukebox } = await import("@/lib/jukebox");
      ensureJukebox();
      // ☗ 将棋: 止まっていた間の時間切れを延ばし、進行中の対局のタイマーを張り直す。
      const { ensureShogiSweeper } = await import("@/lib/shogi");
      ensureShogiSweeper();
    } catch (e) {
      console.error("[bsm] initSchema failed:", e);
    }
  }
}
