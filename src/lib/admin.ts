/* Admin authorization: the set of portal admins who may manage shared
 * resources (e.g. external-link menu bookmarks) from the site UI. */
export const ADMIN_EMAILS: ReadonlySet<string> = new Set([
  "drikin@gmail.com",       // drikin
  "matsuo@gmail.com",       // 松尾公也
  "zenjinishikawa@gmail.com", // Zenji Nishikawa
]);

export function isAdmin(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.has(email.trim().toLowerCase());
}
