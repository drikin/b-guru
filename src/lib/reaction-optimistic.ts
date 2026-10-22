/* リアクションを押した直後の楽観表示（Web の投稿とチャットで共通）。サーバの返事で置き換わる。
 *
 * 押した絵文字を自分が付けているか（mine）で「足す／外す」を分ける。以前は同じ絵文字が
 * あるだけで「外す」扱いにしていたため、他人が付けた絵文字に自分も押すと数が減り、
 * 他人の名前が消えていた（チームレビュー 2026-10-22）。
 * 自分の名前は表示名（メールは画面に出さない）。名前は REACTOR_LIMIT 人まで。 */
import { REACTOR_LIMIT } from "./timeline-display";

export type OptimisticReaction = { emoji: string; count: number; mine: boolean; reactors: string[] };

export function toggleReactionOptimistic<T extends OptimisticReaction>(
  current: readonly T[],
  emoji: string,
  myName: string
): T[] {
  const existing = current.find((r) => r.emoji === emoji);
  if (!existing) {
    return [...current, { emoji, count: 1, mine: true, reactors: [myName] } as T];
  }
  if (existing.mine) {
    if (existing.count <= 1) return current.filter((r) => r.emoji !== emoji);
    return current.map((r) => {
      if (r.emoji !== emoji) return r;
      const at = r.reactors.lastIndexOf(myName);
      const reactors = at >= 0 ? [...r.reactors.slice(0, at), ...r.reactors.slice(at + 1)] : r.reactors;
      return { ...r, count: r.count - 1, mine: false, reactors };
    });
  }
  return current.map((r) =>
    r.emoji === emoji
      ? {
          ...r,
          count: r.count + 1,
          mine: true,
          reactors: r.reactors.length < REACTOR_LIMIT ? [...r.reactors, myName] : r.reactors,
        }
      : r
  );
}
