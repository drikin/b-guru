/* 部室（ボイス）への出入りをチャットに小さく流す（kind "notice" の 1 行。未読に数えない）。
 *
 *   🎧 〇〇 さんが部室に入りました        … 数分以内の入室はまとめて「〇〇 さん・△△ さんが…」
 *   〇〇 さんが部室を出ました
 *
 * 再接続（電波の切り替え・アプリの再起動）では LiveKit が「退出 → 入室」を数秒で
 * 送ってくるので、退出は GRACE_MS だけ待ってから流し、その間に戻ってきたら
 * 退出も入室も流さない。プッシュ通知は送らない（チャットに出るだけ）。
 * 待ち合わせはメモリ上（単一プロセス）。再起動で消えても、流れないだけで害はない。 */
import { getLatestChatId, postChatNotice } from "./chat";
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

/** Comings within this long of the last one, with nothing said in between, share a line. */
export const GATHER_MS = 3 * 60_000;

export function announcementText(kind: VoiceAnnouncement["kind"], names: string[]): string {
  const who = names.map((n) => `${n} さん`).join("・");
  return kind === "leave" ? `${who}が部室を出ました` : `🎧 ${who}が部室に入りました`;
}

/** The line being gathered into (in memory: a restart just starts a new line). */
let last: { id: number; leave: boolean; names: string[]; at: number } | null = null;

async function postAnnouncement(a: VoiceAnnouncement): Promise<void> {
  const [p] = await describeParticipants([a.userId]);
  if (!p) return; // not a B-guru user (should not happen: tokens are ours)
  const name = p.name || "だれか";
  const leave = a.kind === "leave";
  const now = Date.now();
  if (last && last.leave === leave && now - last.at < GATHER_MS && (await getLatestChatId()) === last.id) {
    if (!last.names.includes(name)) last.names.push(name);
    last.at = now;
    await postChatNotice(announcementText(a.kind, last.names), last.id);
    return;
  }
  const m = await postChatNotice(announcementText(a.kind, [name]));
  last = m ? { id: m.id, leave, names: [name], at: now } : null;
}

// One at a time, so two people coming in together end up on the same line.
let queue: Promise<void> = Promise.resolve();

export const voiceAnnouncer = createVoiceAnnouncer((a) => {
  queue = queue
    .then(() => postAnnouncement(a))
    .catch((e) => console.error("[voice] announce:", (e as Error)?.message));
});

/** Tests only: wait for queued announcements. */
export const __announceSettled = () => queue;
