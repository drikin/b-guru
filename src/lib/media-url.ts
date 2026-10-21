/* 投稿画像（/api/media/…）のサイズ別 URL。サーバ側は lib/media-variants.ts。
 * チャット写真（chat-…）・GIF・動画などは手を付けずにそのまま返す。 */

const SIZED_RE = /^\/api\/media\/(?!chat-)[^/?#]+\.(jpe?g|png|webp)$/i;

/** 縮小版を頼める投稿画像の URL か。 */
export function isSizableMedia(src: string | null | undefined): src is string {
  return !!src && SIZED_RE.test(src);
}

/** 長辺 w の縮小版の URL（対象外ならそのまま）。 */
export function mediaSized(src: string, w: number): string {
  return isSizableMedia(src) ? `${src}?w=${w}` : src;
}

/** タイムライン用の srcset（640w / 1280w）。対象外なら undefined。 */
export function mediaSrcSet(src: string): string | undefined {
  if (!isSizableMedia(src)) return undefined;
  return `${src}?w=640 640w, ${src}?w=1280 1280w`;
}
