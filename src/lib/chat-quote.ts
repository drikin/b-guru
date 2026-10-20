/* 「チャットに引用」— タイムラインの投稿をチャットの入力欄に引用する文面と、
 * チャット本文中の B-guru 投稿リンクの検出。ドリキン 2026-10-20
 * 「タイムラインの記事のURLを簡単にチャットに引用できるようにしたい」。
 * Pure functions only: imported from the client bundle. Web / iOS / Android で
 * 同じ文面になるよう、ルールはここに集約する（アプリ側も同じ規則で実装）。 */

/** 投稿パーマリンクの正規のオリジン（プッシュ通知・アプリと同じ）。 */
export const POST_PERMALINK_ORIGIN = "https://bsm.backspace.fm";

/** 抜粋の最大文字数（コードポイント単位）。 */
export const QUOTE_EXCERPT_MAX = 40;

/** 投稿のパーマリンク。返信はスレッドのルートを指すので、呼び出し側で
 *  `post.parentId ?? post.id` を渡す。 */
export function postPermalink(rootId: number, origin: string = POST_PERMALINK_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}/#/post/${rootId}`;
}

/** 1 行を抜粋用に整える: 空白を 1 つに詰める → 行頭の Markdown 記号
 *  （`#`〜`######`・`>`・`-`・`*`・`+`・`1.` の後に空白）を外す →
 *  `**` `__` `~~` `` ` `` をすべて外す → trim。 */
function cleanLine(l: string): string {
  return l
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:#{1,6}|>|[-*+]|\d+\.) /, "")
    .replace(/\*\*|__|~~|`/g, "")
    .trim();
}

/** 引用の抜粋: 最初の空でない行・空白を 1 つに詰める・40 コードポイントで切って …。
 *  行頭の Markdown 記号と ** __ ~~ ` は外す（cleanLine）。
 *  「@」は全角「＠」に置き換える（引用した行のメンションで本人に再通知しない）。
 *  本文が空なら写真付きは「写真」、何もなければ空文字。 */
export function quoteExcerpt(text: string | null | undefined, hasImages: boolean): string {
  const line =
    String(text ?? "")
      .split(/\r\n|\r|\n/)
      .map(cleanLine)
      .find((l) => l.length > 0) ?? "";
  if (!line) return hasImages ? "写真" : "";
  const safe = line.replace(/@/g, "＠");
  const chars = Array.from(safe); // コードポイント単位 — 絵文字・サロゲートペアを割らない
  return chars.length > QUOTE_EXCERPT_MAX ? chars.slice(0, QUOTE_EXCERPT_MAX).join("") + "…" : safe;
}

/** チャット入力欄に入れる引用ブロック（末尾は改行）。@メンションは付けない。
 *    📝 {name} さんの投稿「{excerpt}」\n{permalink}\n
 *  抜粋が空なら「…」の部分を省く。 */
export function quoteText({
  authorName,
  text,
  hasImages,
  permalink,
}: {
  authorName: string | null | undefined;
  text: string | null | undefined;
  hasImages: boolean;
  permalink: string;
}): string {
  const name = String(authorName ?? "").trim() || "だれか";
  const excerpt = quoteExcerpt(text, hasImages);
  const head = excerpt ? `📝 ${name} さんの投稿「${excerpt}」` : `📝 ${name} さんの投稿`;
  return `${head}\n${permalink}\n`;
}

/** 既存の下書きを残して引用を足す（空でなければ改行してから）。 */
export function appendQuote(draft: string, quote: string): string {
  if (!draft.trim()) return quote;
  return draft.endsWith("\n") ? draft + quote : `${draft}\n${quote}`;
}

export type ChatLinkPart = { kind: "text"; text: string } | { kind: "post"; text: string; postId: number };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** チャット本文を、B-guru 投稿リンク（`<origin>/#/post/<id>`）とそれ以外に分ける。
 *  `origins` は自サイトとみなすオリジン（既定は bsm.backspace.fm。開発中は
 *  location.origin も渡す）。他サイトの #/post/ はリンクにしない。 */
export function splitPostLinks(body: string, origins: string[] = [POST_PERMALINK_ORIGIN]): ChatLinkPart[] {
  const list = Array.from(new Set(origins.map((o) => o.replace(/\/+$/, "")).filter(Boolean)));
  if (!body || list.length === 0) return body ? [{ kind: "text", text: body }] : [];
  const re = new RegExp(`(?:${list.map(escapeRe).join("|")})/?#/post/(\\d+)(?![\\w/])`, "g");
  const out: ChatLinkPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const postId = Number(m[1]);
    if (!Number.isSafeInteger(postId) || postId <= 0) continue;
    if (m.index > last) out.push({ kind: "text", text: body.slice(last, m.index) });
    out.push({ kind: "post", text: m[0], postId });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
  return out;
}
