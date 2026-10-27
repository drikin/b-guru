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
      // 🎮 散財ダッシュ: 月曜 9 時の週の王者の投稿・期限切れの発行の片付け（1 分ごと）。
      const { ensureMinigameSweeper } = await import("@/lib/minigame");
      ensureMinigameSweeper();
      // ✉️ 簡易 DM: 24 時間を過ぎた DM を DB からも消す（DM_ENABLED に関係なく。誰も DM を開かない間も
      // 動くように起動時に。security-reviewer 2026-10-24）。
      const { ensureDmSweeper } = await import("@/lib/dm");
      ensureDmSweeper();
      // 🐶 ビーグルのリマインド: 止まっていた間に過ぎた予定も含めて鳴らす（20 秒ごと）。
      const { ensureReminderSweeper } = await import("@/lib/beagle-reminders");
      ensureReminderSweeper();
    } catch (e) {
      console.error("[bsm] initSchema failed:", e);
    }
  }
}
