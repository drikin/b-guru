/* 「ネタ帳に送る」のクライアント側の小物（docs/neta-client-spec.md）。サーバは lib/neta.ts。 */

/** 投稿から送れる URL の候補（リンクのカードの URL を先頭、本文中の http(s) URL を続けて）。
 *  末尾の 。、)」』】,.!? は外す。bsm.backspace.fm（B-guru 自身）と userinfo 付きは除く。重複は 1 つに。 */
export function netaCandidates(post: { text?: string | null; urlPreview?: { url?: string | null } | null }): string[] {
  const raw: string[] = [];
  if (post.urlPreview?.url) raw.push(post.urlPreview.url);
  for (const m of (post.text ?? "").matchAll(/https?:\/\/[^\s<>"'　「」『』【】（）、。]+/gi)) {
    raw.push(m[0].replace(/[。、)）」』】,.!?！？]+$/u, ""));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    let u: URL;
    try { u = new URL(r.trim()); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (u.username || u.password) continue;
    if (/^bsm\.backspace\.fm$/i.test(u.hostname)) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push(u.href);
  }
  return out;
}

/** 選んだ URL がリンクのカードの URL ならカードの題名、違えば空。 */
export function netaDefaultTitle(url: string, preview?: { url?: string | null; title?: string | null } | null): string {
  if (!preview?.url || !preview.title) return "";
  try { return new URL(preview.url).href === url ? preview.title : ""; } catch { return ""; }
}
