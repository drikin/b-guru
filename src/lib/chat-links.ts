/* チャット本文の http(s) URL を見つける（Web のチャットでリンクにする。page.tsx の renderChatBody）。 */

/** Split chat text into plain parts and http(s) URLs. Trailing punctuation (、。.,!?) and a closing
 *  bracket without its opening one stay outside the link. */
export function splitChatUrls(text: string): { text: string; url: boolean }[] {
  const out: { text: string; url: boolean }[] = [];
  const re = /https?:\/\/[^\s<>"'「」『』（）、。，．！？]+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let u = m[0];
    while (/[.,!?:;'"]$/.test(u) || (u.endsWith(")") && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length)) u = u.slice(0, -1);
    if (u.length <= "https://".length) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), url: false });
    out.push({ text: u, url: true });
    last = m.index + u.length;
    re.lastIndex = last;
  }
  if (last < text.length) out.push({ text: text.slice(last), url: false });
  return out;
}
