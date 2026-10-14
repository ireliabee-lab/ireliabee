import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function whose identity never changes but which always runs the latest `fn`.
 * Pass it to memoized children so they don't re-render just because the parent
 * made a new closure.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => { ref.current = fn; });
  return useCallback((...args: A) => ref.current(...args), []);
}
