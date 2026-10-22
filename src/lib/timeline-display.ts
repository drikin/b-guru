/* タイムラインの「表示の判断」— Web とアプリ（Mac/iOS・Android）で同じ答えを出すための正本。
 *
 * 純粋な関数だけを置く（DB・ネットワーク・React に依存しない）ので、Web の画面
 * （src/app/page.tsx・src/components/ReactionBar.tsx）からも、アプリ用 API
 * （GET /api/agent/posts?include=display）からも同じものを import する。
 * アプリは API が返す `display` を描くだけにして、Swift と Kotlin に同じ決まりを
 * 二重に書かない（docs/timeline-spec.md・案 C）。
 *
 * 位置（fold_at・mention_ranges[].start/end など）はすべて JavaScript の String の
 * length（UTF-16 のコード単位）で数える。Swift は `String.utf16`、Kotlin/Java は
 * String の index がそのまま UTF-16 なので、同じ数字で切れる。
 *
 * ⚠️ この決まりを変えるときは docs/timeline-spec.md と
 * src/lib/__tests__/fixtures/timeline/（例題と期待値）も一緒に直すこと。 */

/** 本文がこの長さ（JS の length）を超えたら畳んで「続きを読む」を出す。 */
export const TIMELINE_FOLD_AT = 500;

/** リアクションを付けた人の名前を何人まで返すか（残りは「他N人」）。 */
export const REACTOR_LIMIT = 12;

/** 一覧に挟む返信が何件以上なら畳むか／畳んだとき最新何件を出すか。 */
export const REPLY_FOLD_THRESHOLD = 4;
export const REPLY_VISIBLE_TAIL = 3;

/** 画像 1 枚のときの最大幅（px）。2 枚以上は列に並べる（最大 3 列）。切り抜かない。 */
export const IMAGE_SINGLE_MAX_WIDTH = 360;
/** 画像 1 枚のときの最大の高さ（px）。縦長（スマホのスクリーンショットなど）は高さ 480 で止め、
 *  形を保ったまま細くする（切り抜かない）。アプリに合わせて 2026-10-22 に Web にも入れた。 */
export const IMAGE_SINGLE_MAX_HEIGHT = 480;
export const IMAGE_MAX_COLUMNS = 3;
/** リンクのカードの画像（YouTube 以外）: 幅はカードいっぱい、高さは画像の形から決めて最大 240px。
 *  それを超える縦長は 240 の枠の中に収める（切り抜かない）。 */
export const LINK_CARD_IMAGE_MAX_HEIGHT = 240;

/** `display` の形の版。形を変えたら上げる（アプリは知らない版でも読める範囲で読む）。 */
export const DISPLAY_VERSION = 1;

/**
 * 畳む位置。畳まないときは null。
 * Web は `text.length > 500` で `text.slice(0, 500)` を出す。500 番目の手前で
 * 絵文字などのサロゲートペアが割れるときだけ 1 つ手前（499）で切る
 * （割れた半分は「�」に化けるため。Web もこの関数を使うので同じになる）。
 */
export function foldPoint(text: string | null | undefined, limit = TIMELINE_FOLD_AT): number | null {
  const t = text ?? "";
  if (t.length <= limit) return null;
  const c = t.charCodeAt(limit - 1);
  return c >= 0xd800 && c <= 0xdbff ? limit - 1 : limit;
}

/** 畳んだときに見せる本文（Web の「続きを読む」の前の部分）。 */
export function foldedText(text: string, foldAt: number | null): string {
  return foldAt == null ? text : text.slice(0, foldAt);
}

/** リアクションの並び: 件数の多い順、同じ件数は絵文字の文字列の UTF-16 コード単位順
 *  （JS の `<`・Kotlin の String.compareTo と同じ。Swift は Array(s.utf16) で比べる）。 */
export function compareReactions(
  a: { emoji: string; count: number },
  b: { emoji: string; count: number }
): number {
  if (a.count !== b.count) return b.count - a.count;
  return a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0;
}

/** 並べ替えた新しい配列を返す（元の配列は変えない）。 */
export function sortReactions<T extends { emoji: string; count: number }>(list: readonly T[]): T[] {
  return [...list].sort(compareReactions);
}

/** 付けた人の「他N人」の N（名前は REACTOR_LIMIT 人までしか返らないため）。 */
export function reactorsMore(r: { count: number; reactors?: readonly string[] | null }): number {
  return Math.max(0, r.count - (r.reactors?.length ?? 0));
}

/** 画像の列数。0 枚=0、1 枚=1（最大幅 360px）、2 枚=2、3 枚以上=3。 */
export function imageColumns(n: number): number {
  if (!(n > 0)) return 0;
  return Math.min(n, IMAGE_MAX_COLUMNS);
}

/** 一覧に挟む返信の畳み方。hidden 件を「N件のコメントを表示」の裏に隠し、最新 visible 件を出す。 */
export function replyFold(n: number): { hidden: number; visible: number } {
  if (n < REPLY_FOLD_THRESHOLD) return { hidden: 0, visible: Math.max(0, n) };
  return { hidden: n - REPLY_VISIBLE_TAIL, visible: REPLY_VISIBLE_TAIL };
}

/** リンクのカード（posts.url_preview）。サーバは本文の最初の URL 1 件だけを取りに行く（posts.ts の firstUrl）。 */
export type UrlPreviewLike = {
  url?: string | null;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
  videoId?: string | null;
  spotify?: { embedUrl: string; height: number; kind?: string } | null;
} | null | undefined;

export type LinkCard =
  | { kind: "spotify"; url: string; embed_url: string; embed_height: number }
  | { kind: "youtube"; url: string; video_id: string; image_aspect: "16:9"; image_max_width: 480 }
  | { kind: "link"; url: string };

/**
 * カードの種類。Spotify は埋め込みのプレーヤーだけを出す（カードは出さない）。
 * YouTube は 16:9・最大幅 480px のサムネに ▶。それ以外は普通のカード
 * （題名が無ければ URL、サイト名が無ければ URL を出す）。
 */
export function linkCardOf(p: UrlPreviewLike): LinkCard | null {
  if (!p || typeof p.url !== "string" || !p.url) return null;
  if (p.spotify && p.spotify.embedUrl) {
    return { kind: "spotify", url: p.url, embed_url: p.spotify.embedUrl, embed_height: Number(p.spotify.height) || 152 };
  }
  if (p.videoId) {
    return { kind: "youtube", url: p.url, video_id: p.videoId, image_aspect: "16:9", image_max_width: 480 };
  }
  return { kind: "link", url: p.url };
}

/* ---------------------------------------------------------------- メンション */

export type MentionMemberLike = { name: string };

/**
 * 本文の @メンションを Markdown のリンクに包む（Web の表示用。page.tsx から移した正本）。
 * 会員名に一致するものだけ。`@[名前 空白あり]` と `@名前`（空白・@・<・[ まで）の 2 通り。
 * 大文字小文字は区別しない。
 */
export function highlightMentions(text: string, members: readonly MentionMemberLike[]): string {
  if (!members.length) return text;
  const nameSet = new Set(members.map((m) => m.name.toLowerCase()));
  return text
    .replace(/@\[([^\]]+)\]/g, (match, name: string) => {
      if (nameSet.has(name.toLowerCase())) {
        return `[@${name}](#mention-${name.toLowerCase().replace(/\s+/g, "-")})`;
      }
      return match;
    })
    .replace(/@([^\s@<\[]+)/g, (match, name: string) => {
      if (nameSet.has(name.toLowerCase())) {
        return `[@${name}](#mention-${name.toLowerCase()})`;
      }
      return match;
    });
}

export type MentionRange = { start: number; end: number; name: string };

/**
 * highlightMentions と同じ決まりで、元の本文のどこがメンションかを返す（アプリ用）。
 * [start, end) を「@name」の見た目（緑の太字）にする。`@[A B]` の括弧は表示しない。
 * テストで「範囲を当てはめた結果 == highlightMentions の結果」を確かめている。
 */
export function findMentions(text: string, names: readonly string[]): MentionRange[] {
  if (!names.length || !text) return [];
  const nameSet = new Set(names.map((n) => n.toLowerCase()));
  const out: MentionRange[] = [];
  for (const m of text.matchAll(/@\[([^\]]+)\]/g)) {
    if (nameSet.has(m[1].toLowerCase())) {
      out.push({ start: m.index!, end: m.index! + m[0].length, name: m[1] });
    }
  }
  const inBracket = (i: number) => out.some((r) => i >= r.start && i < r.end);
  const second: MentionRange[] = [];
  for (const m of text.matchAll(/@([^\s@<\[]+)/g)) {
    if (inBracket(m.index!)) continue;
    if (nameSet.has(m[1].toLowerCase())) {
      second.push({ start: m.index!, end: m.index! + m[0].length, name: m[1] });
    }
  }
  return [...out, ...second].sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------- ユーザーへのリンク */

const USER_LINK_RE = /(?:https?:\/\/bsm\.backspace\.fm)?\/?#\/user\/([^\s<)\]，。、]+)/g;

/** `#/user/<userId>`（サイトの URL 付きも）をプロフィールへのリンクにする（Web 用・page.tsx から移した正本）。 */
export function linkifyUserLinks(text: string): string {
  return String(text || "").replace(USER_LINK_RE, (_m, token: string) => "[#/user/" + token + "](#/user/" + token + ")");
}

export type UserLinkRange = { start: number; end: number; user_id: string };

/** linkifyUserLinks と同じ決まりで、元の本文のどこがプロフィールへのリンクかを返す（アプリ用）。
 *  表示は「#/user/<user_id>」、押すとその人のプロフィール。 */
export function findUserLinks(text: string): UserLinkRange[] {
  const out: UserLinkRange[] = [];
  for (const m of String(text || "").matchAll(USER_LINK_RE)) {
    out.push({ start: m.index!, end: m.index! + m[0].length, user_id: m[1] });
  }
  return out;
}

/* -------------------------------------------------------------- まとめ */

/** GET /api/agent/posts?include=display が各投稿に付ける `display`。 */
export type PostDisplay = {
  version: number;
  /** 本文が長いので畳むか。 */
  fold: boolean;
  /** 畳むときの切る位置（JS の length）。畳まないときは null。 */
  fold_at: number | null;
  /** リアクションを出す順（件数の多い順・同数は絵文字順）。 */
  reactions_order: string[];
  /** 絵文字ごとの「他N人」の N（付けた人の名前は 12 人まで）。 */
  reactors_more: Record<string, number>;
  /** 画像の列数（0〜3）。1 のときは最大幅 360px。どれも切り抜かない。 */
  image_columns: number;
  /** リンクのカードにする URL（本文の最初の URL）。無ければ null。 */
  link_card_url: string | null;
  link_card: LinkCard | null;
  /** 本文の中のメンション（会員名に一致したものだけ）の位置。 */
  mention_ranges: MentionRange[];
  /** 本文の中のプロフィールへのリンク。 */
  user_links: UserLinkRange[];
  /** 部活ラベルの表示名（「未設定」を含む）。出さないときは null。 */
  club_label: string | null;
  /** 部活が「未設定」（AI が分類できなかった）か。灰色で出す。 */
  club_unset: boolean;
};

/** 入力はアプリ用 API の投稿の形（snake_case）。例題 JSON もこの形。 */
export type DisplayInput = {
  text: string;
  images?: readonly string[] | null;
  url_preview?: UrlPreviewLike;
  club?: string | null;
  reactions?: readonly { emoji: string; count: number; reactors?: readonly string[] | null }[] | null;
};

export const CLUB_UNSET_KEY = "__unset__";

export function computePostDisplay(
  post: DisplayInput,
  ctx: { memberNames: readonly string[]; clubName: (key: string) => string | null }
): PostDisplay {
  const text = post.text ?? "";
  const foldAt = foldPoint(text);
  const reactions = sortReactions(post.reactions ?? []);
  const card = linkCardOf(post.url_preview);
  const club = post.club ?? null;
  const unset = club === CLUB_UNSET_KEY;
  const userLinks = findUserLinks(text);
  // Web はユーザーリンクを先にリンクにするので、その中の「@」はメンションにならない。
  const mentions = findMentions(text, ctx.memberNames).filter(
    (m) => !userLinks.some((u) => m.start < u.end && m.end > u.start)
  );
  return {
    version: DISPLAY_VERSION,
    fold: foldAt != null,
    fold_at: foldAt,
    reactions_order: reactions.map((r) => r.emoji),
    reactors_more: Object.fromEntries(reactions.map((r) => [r.emoji, reactorsMore(r)])),
    image_columns: imageColumns(post.images?.length ?? 0),
    link_card_url: card?.url ?? null,
    link_card: card,
    mention_ranges: mentions,
    // 古い形の `#/user/<メールアドレス>` は API に出さない（メールを返さない決まり）。アプリでは普通の文字。
    user_links: userLinks.filter((u) => !u.user_id.includes("@")),
    club_label: !club ? null : unset ? "未設定" : ctx.clubName(club),
    club_unset: unset,
  };
}
