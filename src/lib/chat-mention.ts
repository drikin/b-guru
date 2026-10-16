/* Chat @mention matching — the single source shared by the web client (bark on
 * mention) and the server (personal stream `mentions_me` for native clients).
 * Pure functions only: this module is imported from the client bundle. */

/** Normalize a member/mention name for matching: lower-case and strip all
 *  whitespace (half + full-width) so `@柳家`, `@柳家三之助` and `@[柳家 三之助]`
 *  all resolve to the same member. */
export const normWs = (s: string) => String(s || "").toLowerCase().replace(/[\s　]/g, "");

/** True when the chat body contains an @mention token matching any of the
 *  caller's own names (already normalized with `normWs`). */
export function isMentionedIn(body: string, myNames: Set<string>): boolean {
  if (!myNames || myNames.size === 0) return false;
  let hit = false;
  body.replace(/@\[([^\]]+)\]/g, (m, name) => {
    if (myNames.has(normWs(name))) hit = true;
    return m;
  });
  body.replace(/@([^\s@\[\]]+)/g, (m, name) => {
    if (myNames.has(normWs(name))) hit = true;
    return m;
  });
  return hit;
}

/** The set of names a member answers to, built the same way as the web client:
 *  display name(s) plus the email local part. Empty/blank names are dropped. */
export function mentionNamesFor(names: (string | null | undefined)[], email: string | null): Set<string> {
  const s = new Set<string>();
  for (const n of names) {
    const v = normWs(n ?? "");
    if (v) s.add(v);
  }
  const local = email ? normWs(email.split("@")[0]) : "";
  if (local) s.add(local);
  return s;
}

/** The @mention token for a member name, as the web composer writes it:
 *  `@name ` or, when the name has a space, `@[First Last] `. */
export function mentionToken(name: string): string {
  return /\s/.test(name) ? `@[${name}] ` : `@${name} `;
}
