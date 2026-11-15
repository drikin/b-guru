/* 📝 ネタ帳: URL からタイトルと一言（説明）を補完する（オリジナルのネタ帳の /api/fetch-url-info を移したもの。
 * ドリキン 2026-11-16「すべてのプラットフォームで復活」）。
 *
 * - X（x.com / twitter.com）: FxTwitter の API → だめなら publish.twitter.com の oEmbed。
 *   X の記事（Article）は記事の題名、外部リンクつきのポストはリンク先の記事の題名（一言はポストの文）、
 *   それ以外は「名前: ポストの文」。
 * - t.co: 転送先をたどってから、上と同じ。
 * - YouTube: 公式 oEmbed で題名（確実）、一言は動画ページの og:description（取れなければチャンネル名）。
 * - Google ニュース: 元の記事の URL を入れてもらう（取らない）。
 * - それ以外: ページの og:title / <title>、og:description / description。取れなければ Microlink。
 *
 * 安全: http(s) と 80/443 だけ。接続の瞬間に宛先の IP を確かめる（内部・ループバック・リンクローカルは断る。
 * DNS を差し替える手口〔rebinding〕も効かない）。転送は 5 回まで毎回確かめる。読むのは 3MB まで（YouTube のページは 1.5MB ほどあり、meta が後ろにある）、8 秒まで。 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import zlib from "node:zlib";
import { decodeHtmlBytes, extractYoutubeId } from "./urlpreview";

export type NetaUrlInfo = {
  url: string;
  /** 転送の後の URL（t.co など。元と同じなら入れない）。 */
  finalUrl?: string;
  title: string;
  description: string;
  /** 取れなかった・使わないほうがよいときの案内（Google ニュースなど）。 */
  note?: string;
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 1000;
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

/* ---------- 宛先の確かめ ---------- */

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / クラウドのメタデータ
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT・Tailscale
    if (a === 198 && (b === 18 || b === 19)) return true; // ベンチマーク用
    if (a >= 224) return true; // マルチキャスト・予約
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true;
    if (v.startsWith("ff")) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (v.startsWith("::ffff:") || v.startsWith("64:ff9b:")) return true;
    return false;
  }
  return true;
}

/** 外に出してよい URL か（形だけ。IP は接続のときに見る）。 */
export function publicHttpUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  if (net.isIP(h) && isPrivateIp(h)) return null;
  if (!net.isIP(h) && !h.includes(".")) return null;
  return u;
}

/** 接続のときに使う名前解決: 内部の宛先が 1 つでも混じれば断る。 */
function guardedLookup(hostname: string, options: dns.LookupOptions, cb: (...a: any[]) => void) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = (addrs as dns.LookupAddress[]) ?? [];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) {
      return cb(Object.assign(new Error("blocked address"), { code: "EBLOCKED" }));
    }
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

type Got = { status: number; url: string; headers: http.IncomingHttpHeaders; body: Buffer };

/** 1 回の GET（転送はたどらない）。 */
function getOnce(u: URL, headers: Record<string, string>): Promise<Got> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: { "User-Agent": UA, "Accept-Encoding": "gzip, deflate, br", ...headers },
        lookup: guardedLookup as unknown as net.LookupFunction,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, url: u.toString(), headers: res.headers, body: Buffer.alloc(0) });
        }
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        const stream =
          enc === "gzip" || enc === "x-gzip"
            ? res.pipe(zlib.createGunzip())
            : enc === "deflate"
              ? res.pipe(zlib.createInflate())
              : enc === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status, url: u.toString(), headers: res.headers, body: Buffer.concat(chunks) });
        };
        stream.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            chunks.push(c.subarray(0, Math.max(0, c.length - (size - MAX_BYTES))));
            finish();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        stream.on("end", finish);
        stream.on("error", (e) => (done ? undefined : chunks.length ? finish() : reject(e)));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** 転送を確かめながらたどる GET。 */
export async function safeGet(raw: string, headers: Record<string, string> = {}): Promise<Got> {
  let u = publicHttpUrl(raw);
  if (!u) throw new Error("bad url");
  const deadline = Date.now() + TIMEOUT_MS * 2;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (Date.now() > deadline) throw new Error("timeout");
    const r = await getOnce(u, headers);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.location;
      if (!loc) return r;
      const next = publicHttpUrl(new URL(String(loc), u).toString());
      if (!next) throw new Error("bad redirect");
      u = next;
      continue;
    }
    return r;
  }
  throw new Error("too many redirects");
}

/* ---------- 読み取り ---------- */

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
function safeChar(n: number): string {
  try {
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/** 一行にまとめて長さをそろえる。 */
export function clean(s: string | undefined | null, max: number): string {
  const one = decodeEntities(String(s ?? ""))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(one);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : one;
}

/** <meta> を属性の順番によらず読む。 */
export function parseHtmlMeta(html: string): { title: string; description: string } {
  const head = html.slice(0, 3_000_000);
  const metas = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
    const key = attr("property") ?? attr("name");
    const content = attr("content");
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? "").toLowerCase();
    const v = content[2] ?? content[3] ?? content[4] ?? "";
    if (k && v && !metas.has(k)) metas.set(k, v);
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return {
    title: metas.get("og:title") || metas.get("twitter:title") || titleTag,
    description: metas.get("og:description") || metas.get("twitter:description") || metas.get("description") || "",
  };
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}
export function isXUrl(u: string): boolean {
  return /^(www\.|mobile\.)?(x|twitter)\.com$/.test(hostOf(u));
}
function isTco(u: string): boolean {
  return hostOf(u) === "t.co";
}
function isGoogleNews(u: string): boolean {
  return hostOf(u) === "news.google.com";
}
export function parseXStatus(u: string): { user: string; id: string } | null {
  if (!isXUrl(u)) return null;
  const m = new URL(u).pathname.match(/^\/([A-Za-z0-9_]{1,30})\/status(?:es)?\/(\d{1,25})/);
  return m ? { user: m[1], id: m[2] } : null;
}

/** 題名として使えないもの（YouTube の汎用の題名など）。 */
function poorTitle(t: string): boolean {
  const s = t.trim();
  return !s || s === "- YouTube" || s === "YouTube" || s.includes("YouTube でお気に入りの動画") || /^(X|Twitter)$/.test(s);
}

async function getJson(url: string): Promise<any> {
  const r = await safeGet(url, { Accept: "application/json" });
  if (r.status !== 200) return null;
  try {
    return JSON.parse(r.body.toString("utf8"));
  } catch {
    return null;
  }
}

async function fromPage(url: string): Promise<{ title: string; description: string; finalUrl: string } | null> {
  const r = await safeGet(url, {
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
  });
  if (r.status !== 200) return null;
  const ct = String(r.headers["content-type"] || "");
  if (ct && !/html|xml/i.test(ct)) return null;
  const html = decodeHtmlBytes(new Uint8Array(r.body), ct);
  const m = parseHtmlMeta(html);
  return { title: m.title, description: m.description, finalUrl: r.url };
}

async function fromMicrolink(url: string): Promise<{ title: string; description: string } | null> {
  const d = await getJson(`https://api.microlink.io/?url=${encodeURIComponent(url)}`).catch(() => null);
  if (d?.status !== "success" || !d.data) return null;
  return { title: String(d.data.title || ""), description: String(d.data.description || "") };
}

async function fromX(url: string): Promise<{ title: string; description: string; finalUrl?: string } | null> {
  const st = parseXStatus(url);
  if (st) {
    const d = await getJson(`https://api.fxtwitter.com/${st.user}/status/${st.id}`).catch(() => null);
    const tw = d?.tweet;
    if (tw) {
      if (tw.article?.title) return { title: String(tw.article.title), description: String(tw.article.preview_text || "") };
      const raw = String(tw.raw_text?.text || tw.text || "");
      const text = raw.replace(/https?:\/\/t\.co\/\S+/g, "").trim();
      const name = String(tw.author?.name || tw.author?.screen_name || st.user);
      // ポストに外部の記事のリンクがあれば、その記事の題名（一言はポストの文）。
      for (const t of (raw.match(/https?:\/\/t\.co\/\S+/g) ?? []).slice(0, 3)) {
        try {
          const hop = await safeGet(t);
          const dest = hop.url;
          if (!dest || isXUrl(dest) || isTco(dest)) continue;
          const page = await fromPage(dest).catch(() => null);
          if (page && !poorTitle(page.title)) return { title: page.title, description: text, finalUrl: undefined };
        } catch {
          /* 次のリンクへ */
        }
      }
      return { title: text ? `${name}: ${text}` : `${name}のポスト`, description: text };
    }
  }
  const o = await getJson(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`).catch(() => null);
  if (o?.author_name) {
    const p = String(o.html || "").match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    const text = decodeEntities(p.replace(/<[^>]+>/g, "")).replace(/https?:\/\/t\.co\/\S+/g, "").trim();
    return { title: text ? `${o.author_name}: ${text}` : `${o.author_name}のポスト`, description: text };
  }
  return null;
}

async function fromYoutube(url: string, id: string): Promise<{ title: string; description: string } | null> {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const o = await getJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`).catch(() => null);
  let description = "";
  try {
    // 同意画面を避けるクッキー（EU 向け）。題名は oEmbed のほうが確実なので、ここは一言だけ。
    const r = await safeGet(watch, { Accept: "text/html", "Accept-Language": "ja,en;q=0.8", Cookie: "SOCS=CAI; CONSENT=YES+" });
    if (r.status === 200) {
      const m = parseHtmlMeta(decodeHtmlBytes(new Uint8Array(r.body), String(r.headers["content-type"] || "")));
      if (!poorTitle(m.title) && !m.description.includes("YouTube でお気に入りの動画") && !/^Enjoy the videos and music you love/.test(m.description)) {
        description = m.description;
      }
      if (!o?.title && !poorTitle(m.title)) return { title: m.title.replace(/ - YouTube$/, ""), description };
    }
  } catch {
    /* 題名だけで返す */
  }
  if (o?.title) return { title: String(o.title), description: description || (o.author_name ? `${o.author_name}（YouTube）` : "") };
  return null;
}

/* ---------- まとめ ---------- */

const cache = new Map<string, { at: number; v: NetaUrlInfo }>();
const CACHE_MS = 24 * 3600_000;

export async function fetchNetaUrlInfo(raw: string, depth = 0): Promise<NetaUrlInfo> {
  const u = publicHttpUrl(raw);
  if (!u) return { url: String(raw ?? ""), title: "", description: "", note: "URL が正しくありません" };
  const url = u.toString();
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;

  const done = (title: string, description: string, finalUrl?: string, note?: string): NetaUrlInfo => {
    const v: NetaUrlInfo = { url, title: clean(title, TITLE_MAX), description: clean(description, DESCRIPTION_MAX) };
    if (finalUrl && finalUrl !== url) v.finalUrl = finalUrl;
    if (note) v.note = note;
    if (v.title) {
      if (cache.size > 500) cache.delete(cache.keys().next().value as string);
      cache.set(url, { at: Date.now(), v });
    }
    return v;
  };

  try {
    if (isGoogleNews(url)) {
      return done("", "", undefined, "Google ニュースのリンクからは元の記事が分かりません。元の記事の URL を入れてください");
    }
    if (isTco(url) && depth < 2) {
      const hop = await safeGet(url).catch(() => null);
      if (hop?.url && hop.url !== url) {
        const r = await fetchNetaUrlInfo(hop.url, depth + 1);
        return done(r.title, r.description, r.finalUrl ?? hop.url, r.note);
      }
    }
    if (isXUrl(url)) {
      const x = await fromX(url).catch(() => null);
      if (x && !poorTitle(x.title)) return done(x.title, x.description, x.finalUrl);
    }
    const yt = extractYoutubeId(url);
    if (yt) {
      const y = await fromYoutube(url, yt).catch(() => null);
      if (y) return done(y.title, y.description);
    }
    const page = await fromPage(url).catch(() => null);
    if (page && !poorTitle(page.title)) return done(page.title, page.description, page.finalUrl);
    const ml = await fromMicrolink(url);
    if (ml && !poorTitle(ml.title)) return done(ml.title, ml.description);
    return done(page?.title && !poorTitle(page.title) ? page.title : "", page?.description ?? "", page?.finalUrl, "題名を取れませんでした。手で入れてください");
  } catch {
    return done("", "", undefined, "題名を取れませんでした。手で入れてください");
  }
}

/** 取り過ぎを防ぐ（人・IP ごとに 1 分 20 回）。 */
const hits = new Map<string, number[]>();
export function urlInfoRateOk(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => t > now - 60_000);
  if (recent.length >= 20) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value as string);
  return true;
}
