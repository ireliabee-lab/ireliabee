import { useCallback, useRef, useState } from "react";

/**
 * Keeps a scroll container pinned to its newest content while text streams in.
 *
 * Following stops only when the user scrolls *up* away from the bottom, and
 * resumes when they scroll back near it. Content growth never counts as the
 * user scrolling — including growth that isn't a DOM change (images loading,
 * a card filling in, text reflowing), which is caught by watching children's
 * sizes as well as the container's.
 *
 * User intent is detected by position, not timing: we remember where we last
 * put the scroll, so anything above that was the user. A wheel scroll up stops
 * following at once, so a fast token stream can't drag them back down.
 *
 * Returns the ref to put on the scroll container, whether it is currently
 * following (`stuck`, for a "jump to latest" button) and `scrollToBottom()`
 * to jump down and resume following (e.g. when a new message starts).
 */
export function useStickToBottom<T extends HTMLElement>(threshold = 80) {
  const cleanup = useRef<(() => void) | null>(null);
  const jump = useRef<() => void>(() => {});
  const [stuck, setStuck] = useState(true);

  const ref = useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;

    let following = true;
    let lastTop = el.scrollTop;   // where we (or the user, last we saw) left the scroll

    const nearBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    const setFollowing = (v: boolean) => {
      if (v !== following) { following = v; setStuck(v); }
    };
    const toBottom = () => {
      el.scrollTop = el.scrollHeight;
      lastTop = el.scrollTop;
    };
    /** The user moved the scroll up since we last placed it (and isn't near the bottom). */
    const userScrolledUp = () => el.scrollTop < lastTop - 1 && !nearBottom();

    const follow = () => {
      if (!following) return;
      if (userScrolledUp()) { setFollowing(false); return; }
      toBottom();
    };

    const onScroll = () => {
      const top = el.scrollTop;
      if (top < lastTop - 1) setFollowing(nearBottom());   // scrolled up (scrollbar, keys…)
      else if (nearBottom()) setFollowing(true);            // came back down
      lastTop = top;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && el.scrollHeight > el.clientHeight) setFollowing(false);
    };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      if ((e.touches[0]?.clientY ?? 0) > touchY + 4) setFollowing(false);   // finger down = scroll up
    };

    // Size changes of the container and of every child (not only DOM edits).
    const resize = new ResizeObserver(follow);
    const observeChildren = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of Array.from(el.children)) resize.observe(child);
    };
    const mutations = new MutationObserver(records => {
      if (records.some(r => r.type === "childList" && r.target === el)) observeChildren();
      follow();
    });
    mutations.observe(el, { childList: true, subtree: true, characterData: true });
    observeChildren();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });

    jump.current = () => { setFollowing(true); toBottom(); };
    follow();

    cleanup.current = () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      mutations.disconnect();
      resize.disconnect();
      jump.current = () => {};
    };
  }, [threshold]);

  const scrollToBottom = useCallback(() => jump.current(), []);

  return { ref, stuck, scrollToBottom };
}
