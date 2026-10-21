/* 全員で共有する短命のメモリキャッシュ（単一プロセス: pm2 fork・instances 1）。
 *
 * サイドバーの /api/clubs/counts と hot は閲覧者によらず同じ集計なのに、post イベントの
 * たびに全クライアントが取り直し、毎回同じ重い SQL を流していた（各 1 日 1.5 万回）。
 *   - ttlMs の間は同じ結果を全員に返す。
 *   - 同時に来た取り直しは 1 本の SQL にまとめる（single-flight）。
 *   - 投稿・削除・部活の付け替え（liveBus の post create/delete・club）で捨てる。
 *     捨てた時に走っていた読み込みの結果は保存しない（古い値を掴まない）。 */
import { liveBus, type LiveEvent } from "./live";

export type SharedCache<T> = {
  get: () => Promise<T>;
  invalidate: () => void;
};

export function sharedCache<T>(ttlMs: number, load: () => Promise<T>, now: () => number = Date.now): SharedCache<T> {
  let value: { v: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  let gen = 0;
  return {
    get() {
      if (value && now() - value.at < ttlMs) return Promise.resolve(value.v);
      if (inflight) return inflight;
      const g = gen;
      const p: Promise<T> = load()
        .then((v) => {
          if (g === gen) value = { v, at: now() };
          return v;
        })
        .finally(() => {
          if (inflight === p) inflight = null;
        });
      inflight = p;
      return p;
    },
    invalidate() {
      gen++;
      value = null;
      inflight = null;
    },
  };
}

/** 投稿の作成・削除と部活の付け替えで捨てるキャッシュ。 */
const onPostChange = new Set<SharedCache<unknown>>();
let subscribed = false;

export function invalidateOnPostChange<T>(c: SharedCache<T>): SharedCache<T> {
  onPostChange.add(c as SharedCache<unknown>);
  // Subscribe on first use, not at import: importing a module that holds a cache
  // must not touch the bus (tests mock lib/live without it).
  return {
    get: () => {
      subscribe();
      return c.get();
    },
    invalidate: c.invalidate,
  };
}

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  liveBus.on("change", (ev: LiveEvent) => {
    if ((ev.type === "post" && (ev.action === "create" || ev.action === "delete")) || ev.type === "club") {
      for (const x of onPostChange) x.invalidate();
    }
  });
}
