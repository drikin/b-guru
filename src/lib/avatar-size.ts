/**
 * Avatar pixel sizes — single source shared by the client (SafeAvatar) and the
 * Gravatar proxy (api/avatar/[hash]).
 *
 * The timeline shows avatars at 16-56 CSS px but used to always receive
 * Gravatar's 250px original: 39 avatars / 1.34MB on the measured timeline, 65%
 * of all bytes. Gravatar resizes server-side, so the proxy forwards an
 * allow-listed size (never an arbitrary number, which would multiply the disk
 * cache per requested value).
 */
export const AVATAR_SIZES = [80, 120, 180, 250] as const;
export const DEFAULT_AVATAR_SIZE = 250;

/** `?s=` → an allowed size; anything else falls back to the 250 default. */
export function pickAvatarSize(raw: string | null | undefined): number {
  const n = Number(raw);
  return (AVATAR_SIZES as readonly number[]).includes(n) ? n : DEFAULT_AVATAR_SIZE;
}

// Mantine Avatar xs 16 / sm 26 / md 38 / lg 56 CSS px → ~3x for high-DPR screens.
export const AVATAR_PX = { xs: 80, sm: 80, md: 120, lg: 180 } as const;
export type AvatarSize = keyof typeof AVATAR_PX;

/** Add `?s=` to same-origin Gravatar proxy URLs; anything else is untouched. */
export function sizedAvatarSrc(src: string, size: AvatarSize): string {
  if (!/^\/api\/avatar\/[a-f0-9]{32}$/.test(src)) return src;
  return `${src}?s=${AVATAR_PX[size]}`;
}
