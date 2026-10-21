/* A callback whose identity never changes but which always calls the latest
 * version of `fn` (the "useEvent" pattern). Used for the event handlers Home
 * passes to the memoised TimelineFeed / PostCard: those handlers were plain
 * functions recreated on every Home render, which made memo useless.
 *
 * Only for event handlers (called after commit). Never for render props:
 * something that decides what is RENDERED must change identity when its data
 * changes (e.g. renderReactionBar), or the memoised child would show stale data. */
import { useCallback, useInsertionEffect, useRef } from "react";

export function useStableHandler<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  // Insertion effects run before layout effects and before any event can fire,
  // and (unlike useLayoutEffect) do not warn during server rendering.
  useInsertionEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
