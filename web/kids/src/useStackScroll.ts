import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

// useStackScroll provides transform-based vertical scroll for kid
// pages whose content is too tall for the viewport. Mirrors the
// pattern Browse pioneered: a fixed-viewport wrapper with a child
// "stack" element whose `transform: translate3d(0, Y, 0)` is
// driven by an rAF animator. This bypasses the kid TV WebView's
// "every window.scrollTo() write triggers a 200-1000ms full-
// viewport repaint" behavior - transforming a child only repaints
// the stack's box, which the GPU compositor handles cheaply.
//
// The hook writes `--kids-scroll-y` (used by KidsHome's
// .kids-tabpill-slot to scroll the TabPill in lockstep with the
// content). It deliberately does NOT write `--kids-bg-pos-y`:
// Library/Tags/TagDetail scroll in pixels, sometimes thousands of
// them, and tying bg-position to that raw pixel scroll produced
// huge bg shifts on those surfaces (t40). The bg now stays at the
// per-tab random offset (`--kids-bg-offset-y`) on
// Library/Tags/TagDetail and is only animated per-row by
// Browse.tsx, which writes `--kids-bg-pos-y` directly.
//
// Usage:
//
//   const stack = useStackScroll();
//
//   <div ref={stack.stackRef} className="kids-stack">
//       {pageContent}
//   </div>
//
//   stack.scrollToCenter(focusedTile);
//   stack.scrollToTop();
//   stack.setStackY(0, /* snap */ true); // for back-press resets
//
// The hook adds `body.kids-scroll-active` on mount and removes on
// unmount; the matching CSS locks body scroll and gives
// .kids-home-content / .kids-tabpill-slot the absolute layout the
// transform expects. Pages that don't use this hook keep natural
// document flow.

const SETTLE_PX = 0.5;

export type StackScroll = {
    stackRef: React.RefObject<HTMLDivElement>;
    setStackY: (y: number, snap?: boolean) => void;
    scrollToTop: (snap?: boolean) => void;
    scrollToCenter: (el: HTMLElement, snap?: boolean) => void;
    // stackYRef exposes the live animator position so callers can
    // save/restore it (e.g. across a /watch round-trip). Read-only;
    // mutate via setStackY.
    stackYRef: React.RefObject<number>;
};

export function useStackScroll(): StackScroll {
    const stackRef = useRef<HTMLDivElement | null>(null);
    const yRef = useRef(0);
    const targetRef = useRef(0);
    const rafRef = useRef<number | null>(null);

    // Add body class on mount, drop on unmount. Matched CSS locks
    // body scroll + repositions .kids-home-content + .kids-tabpill-
    // slot for the transform-based scroll.
    useLayoutEffect(() => {
        document.body.classList.add("kids-scroll-active");
        return () => {
            document.body.classList.remove("kids-scroll-active");
            // Clear shared CSS variables so the next page (if it
            // doesn't use this hook) gets a clean slate.
            document.documentElement.style.removeProperty("--kids-scroll-y");
            // bg-pos-y isn't written here anymore (t40), but Browse
            // writes it and unmounts can interleave, so wipe it on
            // teardown too as a belt-and-suspenders cleanup.
            document.documentElement.style.removeProperty("--kids-bg-pos-y");
        };
    }, []);

    const applyY = useCallback((y: number) => {
        const el = stackRef.current;
        if (el) el.style.transform = `translate3d(0, ${y}px, 0)`;
        document.documentElement.style.setProperty(
            "--kids-scroll-y",
            `${y}px`,
        );
        // t40: do NOT write --kids-bg-pos-y here. Library/Tags/
        // TagDetail scroll in pixels (sometimes thousands), and
        // tying the bg to that raw pixel scroll produced wild bg
        // shifts on those surfaces. The bg now stays at the per-
        // tab random offset on these pages; Browse owns the only
        // bg-pos-y motion path via its per-row writes.
    }, []);

    const setStackY = useCallback(
        (y: number, snap = false) => {
            targetRef.current = y;
            if (snap) {
                if (rafRef.current !== null) {
                    cancelAnimationFrame(rafRef.current);
                    rafRef.current = null;
                }
                yRef.current = y;
                applyY(y);
                return;
            }
            if (Math.abs(yRef.current - y) < SETTLE_PX) {
                yRef.current = y;
                applyY(y);
                return;
            }
            if (rafRef.current !== null) return;
            const step = () => {
                const target = targetRef.current;
                const current = yRef.current;
                const dist = target - current;
                if (Math.abs(dist) < SETTLE_PX) {
                    yRef.current = target;
                    applyY(target);
                    rafRef.current = null;
                    return;
                }
                // Two-zone curve so a single Down step feels smooth
                // AND a held-Down catches up quickly:
                //
                //   Close (|dist| <= NEAR): one row or less remains.
                //     Slow: linear step capped at FLOOR_SLOW
                //       (the exp tail's sub-pixel adjustments cost
                //       more per paint than the move on this WebView,
                //       so we snap once the gap is small enough).
                //     Fast: exponential ease, original feel.
                //
                //   Far (|dist| > NEAR): kid is holding Down or
                //     used the alpha/jump picker; we need to catch
                //     up before the animator falls visibly behind.
                //     Linear step scaled at 50% of remaining
                //     distance per frame, capped at FAR_CAP so a
                //     huge jump doesn't visually teleport in one
                //     frame. Both fast + slow share this branch -
                //     the kid feels acceleration toward the target
                //     until they're within a row, then the
                //     close-range curve takes over.
                const NEAR = 300; // ~1 tile row including padding
                const FLOOR_SLOW = 120;
                const FAR_CAP = 600;
                const FAR_SCALE = 0.5;
                const absDist = Math.abs(dist);
                const isSlow = document.body?.dataset.perf === "slow";
                let next: number;
                if (absDist > NEAR) {
                    const stepPx = Math.min(FAR_CAP, absDist * FAR_SCALE);
                    next = current + stepPx * Math.sign(dist);
                } else if (isSlow) {
                    const move =
                        Math.min(absDist, FLOOR_SLOW) * Math.sign(dist);
                    next = current + move;
                } else {
                    next = current + dist * 0.22;
                }
                yRef.current = next;
                applyY(next);
                rafRef.current = requestAnimationFrame(step);
            };
            rafRef.current = requestAnimationFrame(step);
        },
        [applyY],
    );

    // Cancel any in-flight rAF on unmount so the loop doesn't keep
    // writing to a detached stack element.
    useEffect(() => {
        return () => {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, []);

    const scrollToTop = useCallback(
        (snap = false) => {
            setStackY(0, snap);
        },
        [setStackY],
    );

    const scrollToCenter = useCallback(
        (el: HTMLElement, snap = false) => {
            // rect reflects the element's CURRENT visual position
            // (post-transform). delta is the offset from the
            // viewport's vertical center; adding it to the live
            // stack Y gives the absolute target that puts the
            // element back at center.
            //
            // Clamp the target to <= 0: the stack's natural top is
            // at Y=0, and "scrolled down" is negative Y (the stack
            // translates upward to reveal content below). When the
            // focused element is already in the upper half of the
            // viewport, naive centering produces a positive target
            // - translating the stack DOWN past natural top and
            // leaving a transparent gap above the first card. The
            // clamp pins those cases to top instead. Cards in the
            // lower half still get centered normally.
            const rect = el.getBoundingClientRect();
            const elCenter = rect.top + rect.height / 2;
            const delta = window.innerHeight / 2 - elCenter;
            const target = Math.min(0, yRef.current + delta);
            setStackY(target, snap);
        },
        [setStackY],
    );

    return {
        stackRef,
        setStackY,
        scrollToTop,
        scrollToCenter,
        stackYRef: yRef,
    };
}
