import { useEffect, useRef, type RefObject } from "react";
import { getPerfMode } from "./perfMode";

// useBrowseRowAnimator drives a Browse row's horizontal scroll via a
// long-lived rAF easing loop, decoupled from React render. The
// selection state (focus.col) only writes a target column; the
// animator reads its own currentX each frame and eases toward
// targetX. New targets mid-flight just update targetXRef - the
// animator picks them up on the next frame, preserving velocity
// from the current visual position.
//
// Why not CSS transitions: when transitions are retargeted faster
// than they can complete (rapid D-pad presses, ~165ms apart vs
// 220ms transition), the WebView's interpolation handling produces
// visible velocity discontinuities. A JS animator that observes the
// current visual position and eases from there avoids the issue
// entirely - same target updates produce continuous motion, no
// restart-from-zero per press.
//
// Lifecycle:
//   - First paint: snap to target with no animation (skip the
//     "fly in from 0" effect on row mount).
//   - Subsequent target changes while animator is sleeping: wake the
//     rAF loop. It runs until currentX === targetX, then sleeps.
//     Zero CPU when idle.
//   - Already-running animator + new target: just update the ref;
//     the loop reads it next frame.
//   - Unmount: cancelAnimationFrame.
//
// Computes the per-tile advance distance from the first child's
// offsetWidth + the track's computed `gap`. We can't read it from the
// `--browse-tile-advance` CSS custom property because per spec
// getComputedStyle().getPropertyValue('--foo') returns the *specified*
// value (the literal `calc(...)` string), not the resolved px. The
// element-measurement path also handles future changes to the tile
// width without us touching this file.

// Default ease constant (% of remaining distance closed per frame).
// Slow devices use a higher value so the animation completes in
// fewer frames; fewer frames means less time for hitches to land
// during the motion. The trade-off is a slightly less buttery
// feel, but on a stuttering device snappy beats smooth-but-choppy.
const EASE_FAST = 0.22;
const EASE_SLOW = 0.36;
const SETTLE_PX = 0.5;

export function useBrowseRowAnimator(
    trackRef: RefObject<HTMLDivElement | null>,
    targetCol: number,
): void {
    const currentXRef = useRef<number | null>(null);
    const targetXRef = useRef(0);
    const rafRef = useRef<number | null>(null);
    // Tile advance (poster width + row gap, in px) is layout-stable -
    // it only changes on viewport resize. Measuring it forces a
    // synchronous layout pass via offsetWidth + getComputedStyle, and
    // on a page with ~140 mounted tiles that pass takes 200-300ms on
    // a cheap Android TV WebView. Measuring once per row + caching
    // means each arrow press is a transform write only, not a layout
    // recompute. Re-measured below on window resize.
    const tileAdvanceRef = useRef<number | null>(null);

    function measureTileAdvance(el: HTMLDivElement): number {
        // Walk the children looking for a "normal" (unfocused, non-
        // metadata-card) tile. The focused tile is wider in t32 (it
        // grows a metadata wing), and the metadata card is itself a
        // sibling flex item; either would blow the measurement. Any
        // tile in the row works for the advance because every
        // unfocused tile is the same width. If the row is empty or
        // every child is currently widened, fall back to whatever the
        // first child measures - the next focus change will re-
        // measure once a normal tile is laid out.
        // t34/t36: the focused tile + meta card are nested inside a
        // single .focused-row-combo wrapper that is itself the track's
        // flex child; the wrapper has no .focused class. Skip it
        // explicitly so the measurement only picks up plain unfocused
        // tile widths.
        const children = Array.from(el.children) as HTMLElement[];
        let sample: HTMLElement | null = null;
        for (const child of children) {
            if (child.classList.contains("focused-meta-card-fade")) continue;
            if (child.classList.contains("focused")) continue;
            if (child.classList.contains("focused-row-combo")) continue;
            sample = child;
            break;
        }
        if (!sample) sample = children[0] ?? null;
        const tileWidth = sample?.offsetWidth ?? 0;
        // t39 fix: if the sample has zero width (track inside a
        // display:none .browse-row-items - which is the steady state
        // for hint-prev / hint-next / far rows post-t38), reading the
        // computed `gap` still returns its resolved pixel value. The
        // old code returned 0 + gap (~30px) and cached that as the
        // per-tile advance, so every subsequent ArrowRight on the row
        // shifted the track by ~30px (one gap-width) instead of the
        // full ~310px (tile + gap). Bailing out with 0 here means the
        // caller skips caching and retries measurement next time the
        // row's targetCol changes - by which point the row has flipped
        // to data-pos="active", .browse-row-items is display:block,
        // and offsetWidth returns the real tile width.
        if (tileWidth <= 0) return 0;
        const gapPx = parseFloat(getComputedStyle(el).gap) || 0;
        return tileWidth + gapPx;
    }

    // Resize listener: invalidate the cached advance so the next
    // targetCol change re-measures. Cheap; only fires on rotation /
    // window resize on real devices.
    useEffect(() => {
        const onResize = () => {
            tileAdvanceRef.current = null;
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    useEffect(() => {
        const el = trackRef.current;
        if (!el) return;
        let tileAdvance = tileAdvanceRef.current;
        if (tileAdvance === null || tileAdvance <= 0) {
            tileAdvance = measureTileAdvance(el);
            if (tileAdvance > 0) {
                tileAdvanceRef.current = tileAdvance;
            }
        }
        if (tileAdvance <= 0) {
            // No tile laid out yet (empty row, or pre-paint). Fall
            // back to setting --track-col so the static CSS rule
            // positions the track. Next render hits the animator path.
            el.style.setProperty("--track-col", String(targetCol));
            return;
        }
        const newTarget = -targetCol * tileAdvance;
        targetXRef.current = newTarget;

        // First paint: snap to target. We don't want a fly-in from
        // translateX(0) when the kid lands on a row that remembers
        // col 5.
        if (currentXRef.current === null) {
            currentXRef.current = newTarget;
            el.style.transform = `translateX(${newTarget}px)`;
            return;
        }

        // Animator already running - it'll pick up the new target on
        // the next frame from targetXRef. No restart needed; the ease
        // is observed-velocity-preserving.
        if (rafRef.current !== null) return;

        // At rest at the new target already - nothing to do.
        if (Math.abs(currentXRef.current - newTarget) < SETTLE_PX) {
            currentXRef.current = newTarget;
            el.style.transform = `translateX(${newTarget}px)`;
            return;
        }

        // Wake the loop.
        const step = () => {
            const node = trackRef.current;
            if (!node) {
                rafRef.current = null;
                return;
            }
            const t = targetXRef.current;
            const c = currentXRef.current ?? t;
            const dist = t - c;
            if (Math.abs(dist) < SETTLE_PX) {
                currentXRef.current = t;
                node.style.transform = `translateX(${t}px)`;
                rafRef.current = null;
                return;
            }
            const ease = getPerfMode() === "slow" ? EASE_SLOW : EASE_FAST;
            const next = c + dist * ease;
            currentXRef.current = next;
            node.style.transform = `translateX(${next}px)`;
            rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
    }, [targetCol, trackRef]);

    // Cancel the loop on unmount so we don't leak rAF callbacks.
    useEffect(() => {
        return () => {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
        };
    }, []);
}
