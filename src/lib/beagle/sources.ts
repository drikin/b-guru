/* ビーグルエージェント: ニュースソースアダプタ
 *   neta  : ネタ帳公開API（/api/weeks + /api/topics）
 *   podcast: backspace.fm ポッドキャスト RSS（rss.art19.com/backspace）
 * 各ソースを正規化し、前回tick以降の新着のみ・既投稿除外して返す。
 */
import { getState } from "./store";
import type { BeagleNewsItem } from "./types";

const DEFAULT_PODCAST_RSS =
  process.env.BEAGLE_PODCAST_RSS || "https://rss.art19.com/backspace";
const NETSPACE_BASE = "https://neta.backspace.fm";

const FETCH_TIMEOUT_MS = 20000;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.text();
}

/** ネタ帳: アクティブ週のトピックを取得。 */
export async function fetchNeta(base: string = NETSPACE_BASE): Promise<BeagleNewsItem[]> {
  const weeks = (await getJson(`${base}/api/weeks`)) as any[];
  if (!Array.isArray(weeks) || weeks.length === 0) return [];
  const week = weeks.find((w) => w.isActive) ?? weeks[0];
  if (!week?.id) return [];
  const topics = (await getJson(`${base}/api/topics?weekId=${week.id}`)) as any[];
  if (!Array.isArray(topics)) return [];
  return topics
    .filter((t) => t && t.title && (t.url || "").startsWith("http"))
    .map((t) => ({
      source: "neta" as const,
      title: String(t.title).slice(0, 300),
      url: String(t.url),
      summary: String(t.description || "").slice(0, 500),
      publishedAt: t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString(),
      score: Number(t.starsCount) || 0,
    }));
}

/** ポッドキャスト RSS（item を軽量パース。最新20件）。 */
export async function fetchPodcast(url: string = DEFAULT_PODCAST_RSS): Promise<BeagleNewsItem[]> {
  const xml = await getText(url);
  return parseRssItems(xml, "podcast").slice(0, 20);
}

function stripTags(s: string): string {
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseRssItems(xml: string, source: string): BeagleNewsItem[] {
  const items: BeagleNewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const pick = (tag: string): string => {
      const mm = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i").exec(block);
      return mm ? mm[1].trim() : "";
    };
    const title = stripTags(pick("title"));
    const link = pick("link").trim();
    const pub = pick("pubDate").trim();
    const desc = stripTags(pick("description"));
    if (!title && !link) continue;
    let publishedAt = new Date().toISOString();
    if (pub) {
      const d = new Date(pub);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }
    items.push({
      source,
      title: title.slice(0, 300),
      url: link,
      summary: desc.slice(0, 400),
      publishedAt,
    });
  }
  return items;
}

/** 全ソースから前回tick（sinceIso）以降の新着・未投稿を抽出（最大30件）。 */
export async function collectNewNews(sinceIso: string | null): Promise<BeagleNewsItem[]> {
  const since = sinceIso
    ? new Date(sinceIso).getTime()
    : Date.now() - 24 * 60 * 60 * 1000;

  const settled = await Promise.allSettled([fetchNeta(), fetchPodcast()]);
  const all: BeagleNewsItem[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") all.push(...r.value);
    else console.warn(`[beagle source] ${(r.reason as Error)?.message}`);
  }

  const state = await getState();
  const postedSet = new Set(state.postedNews);

  return all
    .filter((it) => {
      try {
        return new Date(it.publishedAt).getTime() >= since - 60 * 1000;
      } catch {
        return false;
      }
    })
    .filter((it) => !postedSet.has(it.url))
    .slice(0, 30);
}
