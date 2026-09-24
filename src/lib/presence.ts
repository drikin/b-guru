import { liveBus } from "./live";
import { pool } from "./db";
import { resolveDisplayNames } from "./display-name";
import { gravatarUrl } from "./posts";

/**
 * Realtime presence: which logged-in paid members currently have the site open
 * in a browser tab. A single-process in-memory registry keyed by member email.
 *
 * Source of truth: the SSE stream (`/api/posts/stream`). Opening a connection
 * marks the member online; closing it marks them offline. Because some mobile
 * browsers kill idle SSE connections, the client also sends a lightweight
 * heartbeat (`POST /api/presence/ping`) that refreshes `lastSeenAt`, and a
 * periodic sweep evicts members whose last seen time is stale.
 *
 * Presence changes are broadcast to all connected clients via a `presence`
 * event on the shared `liveBus` (same channel as post/pin updates), so the
 * right-sidebar "オンライン" panel updates live.
 */
const OFFLINE_AFTER_MS = 90_000; // consider offline if no heartbeat for 90s
const SWEEP_MS = 30_000; // sweep interval

interface PresenceEntry {
  connCount: number; // number of live SSE connections (multi-tab)
  lastSeenAt: number; // last heartbeat / connect time
  /**
   * Whether the member's tab is currently in the foreground, per the Page
   * Visibility API. `false` means the tab is open but backgrounded (another
   * tab, minimised, or the phone is on another app) — the member is still
   * online, just not looking at the page.
   *
   * `null` = NOT YET REPORTED. This matters: opening the SSE stream says
   * nothing about whether the tab is in front, so `markOnline` must not assume
   * "active". Doing so made every member who never sends the flag (an older
   * cached client, or one whose heartbeat predates this feature) show as active
   * forever — measured 2026-09-23: 20 of 21 members "active", which drikin
   * correctly called out as implausible. A member with `null` is rendered as
   * active (we cannot prove otherwise) but is NOT treated as a confirmed
   * foreground tab.
   */
  visible: boolean | null;
}

const online = new Map<string, PresenceEntry>();

function currentList(): string[] {
  return [...online.keys()].sort((a, b) => a.localeCompare(b));
}

function broadcast(): void {
  const emails = currentList();
  try {
    liveBus.emit("change", { type: "presence", emails });
  } catch (e) {
    console.error("presence broadcast error:", (e as any)?.message);
  }
}

/** A client opened an SSE connection. Associate it with the member email. */
export function markOnline(email: string): void {
  const cur = online.get(email);
  if (cur) {
    cur.connCount += 1;
    cur.lastSeenAt = Date.now();
  } else {
    // `visible: null` — opening a stream says nothing about whether the tab is
    // in front. The heartbeat reports the real value within 30s (and
    // immediately on the first visibilitychange). Assuming `true` here made
    // every member who never reports the flag look permanently active.
    online.set(email, { connCount: 1, lastSeenAt: Date.now(), visible: null });
    broadcast();
  }
}

/** A client's SSE connection closed. */
export function markOffline(email: string): void {
  const cur = online.get(email);
  if (!cur) return;
  cur.connCount = Math.max(0, cur.connCount - 1);
  // Do NOT evict here. Eviction is left to the lastSeenAt sweep so a client
  // that briefly loses its SSE stream (mobile tab suspension, network blip)
  // but keeps heartbeating stays "online" — fixes the "タブ開いてるのに
  // オフライン" symptom. A fully-closed client stops pinging and is evicted
  // by the sweep (~OFFLINE_AFTER_MS later).
}

/** Emails of all members currently online (sorted). */
export function getOnlineEmails(): string[] {
  return currentList();
}

/**
 * Heartbeat from the client — refresh this member's last seen time and record
 * whether their tab is in the foreground.
 *
 * `visible` is optional so an older client (or a caller that does not know)
 * does not accidentally dim a member: omitting it leaves the previous value
 * untouched.
 */
export function touch(email: string, visible?: boolean): void {
  const cur = online.get(email);
  if (cur) {
    cur.lastSeenAt = Date.now();
    if (typeof visible === "boolean" && cur.visible !== visible) {
      cur.visible = visible;
      // Visibility is part of the presence payload, so a change must be pushed
      // to every connected client — otherwise the sidebar only updates on the
      // next unrelated presence event.
      broadcast();
    }
  } else {
    // A pinging client is by definition a live tab with the site open, even if
    // its SSE stream isn't currently connected. Re-register as online so the
    // presence panel isn't wrongly blank after the stream drops.
    online.set(email, {
      connCount: 0,
      lastSeenAt: Date.now(),
      // `null` when the client did not report — never assume "active".
      visible: typeof visible === "boolean" ? visible : null,
    });
    broadcast();
  }
}

export interface PresenceMember {
  email: string;
  name: string | null;
  avatar: string | null;
  /**
   * Tab is in the foreground. `false` = online but backgrounded (dimmed).
   * `null` = the client has not reported yet; render as active.
   */
  visible: boolean | null;
}

/** Enrich the online email list with display name + Gravatar avatar. */
export async function getOnlineMembers(): Promise<PresenceMember[]> {
  const emails = currentList();
  if (emails.length === 0) return [];
  const nameByEmail = await resolveDisplayNames(emails);
  return emails.map((em) => ({
    email: em,
    name: nameByEmail.get(em) ?? em.split("@")[0],
    avatar: gravatarUrl(em),
    // `null` (never reported) is passed through as-is; the client renders it as
    // active. Do NOT coerce it to `true` here — that would erase the distinction
    // between "confirmed in front" and "unknown".
    visible: online.get(em)?.visible ?? null,
  }));
}

let sweeperStarted = false;
/** Start the stale-connection eviction sweep (idempotent). */
export function ensurePresenceSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [email, entry] of online) {
      if (now - entry.lastSeenAt > OFFLINE_AFTER_MS) {
        online.delete(email);
        changed = true;
      }
    }
    if (changed) broadcast();
  }, SWEEP_MS);
}