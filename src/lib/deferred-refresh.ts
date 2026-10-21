/* SSE で来た「取り直して」を数秒まとめ、タブが裏にある間は表に戻るまで待たせる。
 *
 * post イベントのたびに全クライアントが /api/clubs/counts と hot を取り直していた
 * （各 1 日 1.5 万回）。投稿が続くと同じ取り直しが連発し、裏のタブも無駄に取っていた。
 *   - schedule(key, fn): key ごとに最後の fn だけを覚え、delayMs 後に一度だけ走らせる。
 *   - 走らせる時にタブが非表示なら、表示に戻った時（flushIfVisible）まで持ち越す。 */

export type DeferredRefresh = {
  schedule: (key: string, fn: () => void) => void;
  /** visibilitychange（表示に戻った）で呼ぶ。持ち越していたものをすぐ走らせる。 */
  flushIfVisible: () => void;
  /** アンマウント時。 */
  dispose: () => void;
};

export function createDeferredRefresh(delayMs: number, isHidden: () => boolean): DeferredRefresh {
  const pending = new Map<string, () => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    timer = null;
    if (isHidden()) return; // 表示に戻るまで pending に残す
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) {
      try {
        fn();
      } catch {
        /* one failing loader must not stop the rest */
      }
    }
  };

  return {
    schedule(key, fn) {
      pending.set(key, fn);
      if (!timer) timer = setTimeout(run, delayMs);
    },
    flushIfVisible() {
      if (isHidden() || pending.size === 0) return;
      if (timer) clearTimeout(timer);
      run();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
