/* ボイスルームの入退室をチャットに流す（ビーグルの発言として）。
 *
 *   🎙️ 〇〇 さんがボイスルームを開きました   … 空の部屋に最初に入った
 *   🎙️ 〇〇 さんがボイスルームに入りました
 *   〇〇 さんがボイスルームを出ました
 *
 * 再接続（電波の切り替え・アプリの再起動）では LiveKit が「退出 → 入室」を数秒で
 * 送ってくるので、退出は GRACE_MS だけ待ってから流し、その間に戻ってきたら
 * 退出も入室も流さない。プッシュ通知は送らない（チャットに出るだけ）。
 * 待ち合わせはメモリ上（単一プロセス）。再起動で消えても、流れないだけで害はない。 */
import { createChatMessage } from "./chat";
import { emitLive } from "./live";
import { SYSTEM_EMAIL } from "./posts";
import { describeParticipants } from "./voice";

export const ANNOUNCE_GRACE_MS = 30_000;

export type VoiceAnnouncement = { kind: "open" | "join" | "leave"; userId: string };

/** The timing rules, with the actual posting injected (tests drive it with fake timers). */
export function createVoiceAnnouncer(post: (a: VoiceAnnouncement) => void, graceMs = ANNOUNCE_GRACE_MS) {
  const pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    /** A new participation started. `opened` = this person opened the session. */
    joined(userId: string, opened: boolean) {
      const t = pendingLeave.get(userId);
      if (t) {
        // Back within the grace period (a reconnect): nothing happened, as far as the chat is concerned.
        clearTimeout(t);
        pendingLeave.delete(userId);
        return;
      }
      post({ kind: opened ? "open" : "join", userId });
    },
    left(userId: string) {
      if (pendingLeave.has(userId)) return;
      pendingLeave.set(
        userId,
        setTimeout(() => {
          pendingLeave.delete(userId);
          post({ kind: "leave", userId });
        }, graceMs)
      );
    },
    /** For tests. */
    pending: () => pendingLeave.size,
  };
}

export function announcementText(kind: VoiceAnnouncement["kind"], name: string): string {
  switch (kind) {
    case "open":
      return `🎙️ ${name} さんがボイスルームを開きました`;
    case "join":
      return `🎙️ ${name} さんがボイスルームに入りました`;
    case "leave":
      return `${name} さんがボイスルームを出ました`;
  }
}

async function postAnnouncement(a: VoiceAnnouncement): Promise<void> {
  const [p] = await describeParticipants([a.userId]);
  if (!p) return; // not a B-guru user (should not happen: tokens are ours)
  const message = await createChatMessage(SYSTEM_EMAIL, "ビーグル", announcementText(a.kind, p.name || "だれか"), null);
  const { isAuthor: _perReceiver, ...broadcast } = message;
  emitLive({ type: "chat", message: broadcast, action: "create" });
}

export const voiceAnnouncer = createVoiceAnnouncer((a) => {
  void postAnnouncement(a).catch((e) => console.error("[voice] announce:", (e as Error)?.message));
});
