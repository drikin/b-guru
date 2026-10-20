/* BS ネタ帳（neta.backspace.fm）へ、タイムラインの投稿が参照している記事の URL を送る
 * （drikin 2026-10-20）。B-guru の投稿の URL ではなく、投稿に貼られた記事の URL。
 * ネタ帳は同じ VPS で動いていて、Chrome 拡張と同じ POST /api/topics にサーバから送る。
 * ネタ帳は公開サイトなので、会員の投稿の文は勝手に載せない（説明は会員が書いたものだけ）。 */

export const NETA_API = process.env.NETA_API_URL?.trim() || "http://127.0.0.1:5000";
export const NETA_SITE = "https://neta.backspace.fm";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 1000;

export type NetaInput = { url: string; title: string; description?: string | null };

export type NetaResult =
  | { status: 201; body: { ok: true; topicId: number | null; site: string } }
  | { status: 409; body: { ok: false; code: "duplicate"; error: string; existing: { title: string; submitter: string } } }
  | { status: 400 | 401 | 502; body: { ok: false; code: string; error: string } };

/** Only real outside articles: http(s), not a B-guru link, no credentials in it. */
export function netaUrlOk(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (/(^|\.)backspace\.fm$/i.test(u.hostname) && /^bsm\./i.test(u.hostname)) return null; // a B-guru post is not a topic
  return u.toString();
}

/** Checks and trims what the member sends. */
export function normalizeNetaInput(body: unknown): { ok: true; value: NetaInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const url = netaUrlOk(b.url);
  if (!url) return { ok: false, error: "URL が正しくありません" };
  const title = typeof b.title === "string" ? b.title.trim().replace(/\s+/g, " ") : "";
  if (!title) return { ok: false, error: "題名を入れてください" };
  if (Array.from(title).length > TITLE_MAX) return { ok: false, error: `題名は ${TITLE_MAX} 文字までです` };
  const description = typeof b.description === "string" ? b.description.trim() : "";
  if (Array.from(description).length > DESCRIPTION_MAX) return { ok: false, error: `説明は ${DESCRIPTION_MAX} 文字までです` };
  return { ok: true, value: { url, title, description: description || null } };
}

/** Sends one topic to ネタ帳 as `submitter` (the member's B-guru display name). */
export async function submitToNeta(input: NetaInput, submitter: string, fetchImpl: typeof fetch = fetch): Promise<NetaResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${NETA_API}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "B-guru (+https://bsm.backspace.fm)" },
      body: JSON.stringify({
        title: input.title,
        url: input.url,
        description: input.description || undefined,
        submitter,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: 502, body: { ok: false, code: "neta_unreachable", error: "ネタ帳につながりませんでした" } };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (res.status === 201) {
    return { status: 201, body: { ok: true, topicId: typeof data.id === "number" ? data.id : null, site: NETA_SITE } };
  }
  if (res.status === 409 && data.code === "DUPLICATE_URL") {
    const ex = data.existingTopic ?? {};
    return {
      status: 409,
      body: {
        ok: false,
        code: "duplicate",
        error: "今週のネタ帳にはもう投稿されています",
        existing: { title: String(ex.title ?? ""), submitter: String(ex.submitter ?? "") },
      },
    };
  }
  if (res.status === 400) {
    return { status: 400, body: { ok: false, code: "neta_rejected", error: String(data.message || "ネタ帳が受け付けませんでした") } };
  }
  return { status: 502, body: { ok: false, code: "neta_error", error: "ネタ帳でエラーが起きました" } };
}

/** Web: at most 20 topics an hour per member (the apps' tokens have their own limit). */
const sent = new Map<string, number[]>();
export function netaRateOk(email: string, now = Date.now()): boolean {
  const hour = now - 3600_000;
  const recent = (sent.get(email) ?? []).filter((t) => t > hour);
  if (recent.length >= 20) {
    sent.set(email, recent);
    return false;
  }
  recent.push(now);
  sent.set(email, recent);
  return true;
}
