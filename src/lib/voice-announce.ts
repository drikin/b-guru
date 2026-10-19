/* 部室（ボイス）への出入りをチャットに小さく流す（kind "notice" の 1 行。未読に数えない）。
 *
 *   🎧 〇〇 さん・△△ さんが部室に入り、□□ さんが出ました
 *
 * 騒がしくしないための決まり（drikin 2026-10-19「入退室の情報が乱雑」）:
 *   - 入室は 1 分いてから流す。それより早く出た人（ちょっと覗いただけ）は何も流さない。
 *   - 退室は 30 秒待ってから流す（電波の切り替え・アプリの再起動での「退出→入室」は無かったことに）。
 *     入室を流していない人の退室は流さない。
 *   - 間に普通の発言がなければ、出入りは 1 本の行を書き換えていく。同じ行の中で入って出た人は
 *     差し引きで消し、何も残らなければ行ごと消す。
 * プッシュ通知は送らない。待ち合わせはメモリ上（単一プロセス）。再起動で消えても、流れないだけで害はない。 */
import { deleteChatMessage, getLatestChatId, postChatNotice } from "./chat";
import { emitLive } from "./live";
import { describeParticipants } from "./voice";

export const ANNOUNCE_GRACE_MS = 30_000;
/** Stay this long before your coming in is announced. */
export const ANNOUNCE_STAY_MS = 60_000;

export type VoiceAnnouncement = { kind: "join" | "leave"; userId: string };

/** The timing rules, with the actual posting injected (tests drive it with fake timers). */
export function createVoiceAnnouncer(
  post: (a: VoiceAnnouncement) => void,
  graceMs = ANNOUNCE_GRACE_MS,
  stayMs = ANNOUNCE_STAY_MS
) {
  const pendingJoin = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();
  /** People whose coming in was announced (and whose leaving therefore will be). */
  const announced = new Set<string>();
  return {
    /** A new participation started. */
    joined(userId: string) {
      const t = pendingLeave.get(userId);
      if (t) {
        // Back within the grace period (a reconnect): nothing happened, as far as the chat is concerned.
        clearTimeout(t);
        pendingLeave.delete(userId);
        return;
      }
      if (announced.has(userId) || pendingJoin.has(userId)) return;
      pendingJoin.set(
        userId,
        setTimeout(() => {
          pendingJoin.delete(userId);
          announced.add(userId);
          post({ kind: "join", userId });
        }, stayMs)
      );
    },
    left(userId: string) {
      const j = pendingJoin.get(userId);
      if (j) {
        // Only peeked in: nothing to say.
        clearTimeout(j);
        pendingJoin.delete(userId);
        return;
      }
      if (!announced.has(userId) || pendingLeave.has(userId)) return;
      pendingLeave.set(
        userId,
        setTimeout(() => {
          pendingLeave.delete(userId);
          announced.delete(userId);
          post({ kind: "leave", userId });
        }, graceMs)
      );
    },
    /** For tests. */
    pending: () => pendingJoin.size + pendingLeave.size,
  };
}

/** Comings and goings within this long, with nothing said in between, share a line. */
export const GATHER_MS = 10 * 60_000;

const list = (names: string[]) => names.map((n) => `${n} さん`).join("・");

/** The line for what happened: who came in, who left. Null when nothing is left to say. */
export function announcementText(joins: string[], leaves: string[]): string | null {
  if (joins.length && leaves.length) return `🎧 ${list(joins)}が部室に入り、${list(leaves)}が出ました`;
  if (joins.length) return `🎧 ${list(joins)}が部室に入りました`;
  if (leaves.length) return `${list(leaves)}が部室を出ました`;
  return null;
}

/** The line being written into (in memory: a restart just starts a new line). */
let line: { id: number; joins: string[]; leaves: string[]; at: number } | null = null;

async function postAnnouncement(a: VoiceAnnouncement): Promise<void> {
  const [p] = await describeParticipants([a.userId]);
  if (!p) return; // not a B-guru user (should not happen: tokens are ours)
  const name = p.name || "だれか";
  const now = Date.now();
  const current = line && now - line.at < GATHER_MS && (await getLatestChatId()) === line.id ? line : null;
  const joins = current ? [...current.joins] : [];
  const leaves = current ? [...current.leaves] : [];
  if (a.kind === "join") {
    if (leaves.includes(name)) leaves.splice(leaves.indexOf(name), 1); // left earlier in this line, back again
    else if (!joins.includes(name)) joins.push(name);
  } else if (joins.includes(name)) {
    joins.splice(joins.indexOf(name), 1); // came and went within this line
  } else if (!leaves.includes(name)) {
    leaves.push(name);
  }
  const text = announcementText(joins, leaves);
  if (current) {
    if (text) {
      await postChatNotice(text, current.id);
      line = { id: current.id, joins, leaves, at: now };
    } else {
      // Nothing left to say: the line goes.
      await deleteChatMessage(current.id);
      emitLive({ type: "chat", action: "delete", message: { id: current.id } });
      line = null;
    }
    return;
  }
  if (!text) return;
  const m = await postChatNotice(text);
  line = m ? { id: m.id, joins, leaves, at: now } : null;
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
