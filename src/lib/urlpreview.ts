/* URL / OpenGraph metadata fetching for feed link previews */
export interface UrlPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** YouTube video id, when the link is a watch/shorts/youtu.be URL */
  videoId?: string;
}

/**
 * Extract a YouTube video id from common link shapes:
 *   https://www.youtube.com/watch?v=ID, shorts/ID, youtu.be/ID,
 *   youtube.com/embed/ID, live/ID
 */
export function extractYoutubeId(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    if (/(^|\.)youtube\.com$|(^|\.)youtube\.com\//.test(u.hostname) || u.hostname === "youtu.be") {
      // youtu.be/ID
      if (u.hostname === "youtu.be") {
        const id = u.pathname.split("/").filter(Boolean)[0];
        return id || null;
      }
      // watch?v=ID
      const v = u.searchParams.get("v");
      if (v) return v;
      // /shorts/ID, /embed/ID, /live/ID
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/* ── Charset handling ────────────────────────────────────────────────────
 * 日本語サイト（itmedia 等）は Content-Type ヘッダに charset を付けず、
 * HTML の <meta http-equiv="content-type" content="text/html;charset=shift_jis">
 * で宣言していることがある。fetch の res.text() は常に UTF-8 でデコードするため、
 * Shift-JIS ページは文字化け（U+FFFD 菱形）になる。ここでは生のバイト列を
 * 取得し、ヘッダ→HTML内metaの順に宣言された charset でデコードする。 */

/** Content-Type ヘッダ内の charset 宣言を取り出す（例: "text/html; charset=Shift_JIS"）。無いなら undefined。 */
export function charsetFromContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const m = contentType.match(/charset\s*=\s*["']?\s*([\w-]+)/i);
  return m ? m[1] : undefined;
}

/**
 * 生の HTML バイトから <head> 領域の charset 宣言を探す。
 * 対象: <meta http-equiv="content-type" content="...;charset=X">
 *       <meta charset="X">
 * 宣言が見つからない（または UTF-8）なら "utf-8" を返す。
 * バイト列の先頭を ASCII/Shift-JIS 両方で解読できる（meta タグ自体は ASCII なので
 * どのcharsetでも meta 探査は安全）。
 */
export function charsetFromHead(headBytes: Uint8Array): string {
  const ascii = new TextDecoder("ascii", { fatal: false }).decode(
    headBytes.slice(0, Math.min(4096, headBytes.length))
  );
  const m1 = ascii.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)["']/i)
    || ascii.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)["'][^>]+http-equiv\s*=\s*["']?content-type["']?/i);
  const m2 = m1 || ascii.match(/<meta[^>]+charset\s*=\s*["']([\w-]+)["']/i);
  if (m2 && m2[1]) {
    const label = m2[1].toLowerCase();
    if (label === "utf-8" || label === "us-ascii") return "utf-8";
    return label;
  }
  return "utf-8";
}

/** TextDecoder が実際にそのラベルを支持するか（cp932 等は環境により不可）。 */
export function canDecode(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * HTML のバイト列を宣言された charset でデコードする（純関数・テスト対象）。
 * 解決順序: contentType 指定 → HTML 内 meta 指定 → utf-8。
 * 指定されたラベルが TextDecoder で使えない場合（cp932 等）は utf-8 にフォールバック。
 */
export function decodeHtmlBytes(bytes: Uint8Array, contentType?: string | null): string {
  const candidates: string[] = [];
  const ct = charsetFromContentType(contentType);
  if (ct) candidates.push(ct.toLowerCase());
  candidates.push(charsetFromHead(bytes));
  for (const label of candidates) {
    if (label === "utf-8" || label === "us-ascii") {
      return new TextDecoder("utf-8").decode(bytes);
    }
    if (canDecode(label)) {
      try {
        return new TextDecoder(label).decode(bytes);
      } catch {
        /* fallthrough to next candidate */
      }
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Fetch a URL's <head> and extract OG / basic meta.
 * Returns minimal info; never throws (returns the url alone on failure).
 */
export async function fetchUrlPreview(rawUrl: string): Promise<UrlPreview> {
  const url = rawUrl.trim();

  // YouTube: build a richer preview from the video id (thumbnail + title)
  // without needing the full og: fetch, and prefer the high-res thumbnail.
  const ytId = extractYoutubeId(url);
  if (ytId) {
    const parsed = new URL(url);
    const res = {
      url,
      videoId: ytId,
      image: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
    };
    // Try to enrich with og:title/description by fetching the watch page,
    // but never block on it.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const r = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept-Language": "ja,en;q=0.8",
        },
      });
      clearTimeout(timer);
      if (r.ok && (r.headers.get("content-type") || "").includes("text/html")) {
        const html = decodeHtmlBytes(Buffer.from(await r.arrayBuffer()), r.headers.get("content-type"));
        const m = parseMeta(url, html);
        return {
          url,
          videoId: ytId,
          title: m.title || parsed.hostname,
          description: m.description,
          image: res.image,
          siteName: "YouTube",
        };
      }
    } catch {
      /* fallback to thumbnail-only */
    }
    return { ...res, siteName: "YouTube" };
  }

  try {
    const parsed = new URL(url);
    // Only HTTP(S)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { url };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html",
      },
    });
    clearTimeout(timer);

    if (!res.ok) return { url };
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return { url };

    const html = decodeHtmlBytes(Buffer.from(await res.arrayBuffer()), ct);
    return parseMeta(url, html);
  } catch {
    return { url };
  }
}

function parseMeta(url: string, html: string): UrlPreview {
  const get = (attr: string, name: string): string | undefined => {
    // content from <meta name/attr="name" content="...">
    const re = new RegExp(
      `<meta[^>]+${attr}=["']?${name}["']?[^>]*content=["']([^"']+)["']`,
      "i"
    );
    const m = html.match(re);
    return m ? decodeEntities(m[1]).trim() : undefined;
  };
  const getProp = (prop: string) => get("property", prop);

  const title =
    getProp("og:title") || get("name", "twitter:title") || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  const description =
    getProp("og:description") || get("name", "description");
  const image =
    getProp("og:image") || get("name", "twitter:image");
  const siteName = getProp("og:site_name");

  function resolve(u?: string): string | undefined {
    if (!u) return undefined;
    try {
      return new URL(u, url).toString();
    } catch {
      return u;
    }
  }

  return {
    url,
    title,
    description,
    image: resolve(image),
    siteName,
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
