// smoothScroll runs a JS-driven scroll animation that retargets
// gracefully when called rapidly. Browser-native smooth scrolling
// (scrollIntoView({behavior:"smooth"}), scroll-behavior:smooth in
// CSS, scrollTo({behavior:"smooth"})) all share the same flaw on
// the kid TV's WebView: each new call cancels the in-flight smooth
// animation and restarts the ease-in from zero velocity. Rapid
// D-pad presses (5/sec) compound this into visible stutter.
//
// This animator writes scroll positions every frame via rAF,
// easing the actual position toward the latest target. When the
// target changes mid-flight, the easing continues from the current
// visual position - the velocity is preserved as long as the kid
// is moving in the same direction.
//
// One animator per (element, axis) pair. The active map tracks
// in-flight animations so rapid calls just update the target
// without spawning new rAF chains.

type Axis = "x" | "y";

type Active = {
    target: number;
    rafId: number | null;
};

const active: WeakMap<Element | Window, Map<Axis, Active>> = new WeakMap();

function getCurrent(el: Element | Window, axis: Axis): number {
    if (el === window) {
        return axis === "x" ? window.scrollX : window.scrollY;
    }
    const e = el as Element;
    return axis === "x" ? e.scrollLeft : e.scrollTop;
}

function setCurrent(el: Element | Window, axis: Axis, value: number): void {
    if (el === window) {
        if (axis === "x") window.scrollTo({ left: value, top: window.scrollY });
        else window.scrollTo({ left: window.scrollX, top: value });
        return;
    }
    const e = el as Element;
    if (axis === "x") e.scrollLeft = value;
    else e.scrollTop = value;
}

// Exponential ease toward the target. 0.22 per frame gives a snappy
// feel that completes a typical tile-width move in ~6-8 frames
// (~100-130ms at 60fps). Lower values feel laggy; higher values
// feel jumpy and amplify the cancellation problem we're avoiding.
// EASE constants. perfMode "slow" devices use a higher value so the
// animation finishes in fewer frames (less time for hitches to land
// during the motion). Read perfMode dynamically per animation start
// so a runtime FPS reclassification picks up immediately.
const EASE_FAST = 0.22;
const EASE_SLOW = 0.36;
function ease(): number {
    if (typeof document === "undefined") return EASE_FAST;
    return document.body?.dataset.perf === "slow" ? EASE_SLOW : EASE_FAST;
}
const SETTLE_PX = 0.5;

// cancelSmoothScroll stops any in-flight animator on (el, axis).
// Useful when a page unmounts mid-animation - otherwise the rAF
// loop keeps writing scrollY to its stale target after the next
// page mounts. axis omitted = cancel all axes for el.
export function cancelSmoothScroll(
    el: Element | Window,
    axis?: Axis,
): void {
    const perEl = active.get(el);
    if (!perEl) return;
    const stop = (state: Active) => {
        if (state.rafId !== null) cancelAnimationFrame(state.rafId);
    };
    if (axis) {
        const state = perEl.get(axis);
        if (state) {
            stop(state);
            perEl.delete(axis);
        }
    } else {
        for (const state of perEl.values()) stop(state);
        perEl.clear();
    }
}

export function smoothScrollTo(
    el: Element | Window,
    axis: Axis,
    target: number,
): void {
    // Slow-mode escape hatch for window-level scrolls. On the kid TV's
    // WebView, every per-frame window.scrollTo() write triggers a full-
    // viewport repaint that takes 200-1000ms - the scroll animation
    // ends up freezing for seconds at a time on a single Down press.
    // Element-level scrolls (used by Library's continue-watching strip)
    // are cheap because they only repaint the element's box, so we
    // keep the smooth path for those. Snapping window scroll loses the
    // polish but eliminates the multi-second hitch.
    if (
        el === window &&
        typeof document !== "undefined" &&
        document.body?.dataset.perf === "slow"
    ) {
        setCurrent(el, axis, target);
        // Stop any in-flight animator on this axis so a leftover
        // ease toward an OLD target doesn't keep firing after our
        // snap. (E.g., a previous fast-mode session that flipped to
        // slow, or an animator left behind by a now-unmounted page.)
        cancelSmoothScroll(el, axis);
        return;
    }
    let perEl = active.get(el);
    if (!perEl) {
        perEl = new Map();
        active.set(el, perEl);
    }
    const existing = perEl.get(axis);
    if (existing) {
        existing.target = target;
        return;
    }
    const state: Active = { target, rafId: null };
    perEl.set(axis, state);
    const step = () => {
        const current = getCurrent(el, axis);
        const dist = state.target - current;
        if (Math.abs(dist) < SETTLE_PX) {
            setCurrent(el, axis, state.target);
            perEl?.delete(axis);
            return;
        }
        setCurrent(el, axis, current + dist * ease());
        state.rafId = requestAnimationFrame(step);
    };
    step();
}

// scrollTileIntoRowStart scrolls a horizontal scroller (e.g. a
// .browse-row-items) so the given tile lands at `paddingLeft` of
// inset from the scroller's left edge.
//
// Uses tile.offsetLeft, which is the tile's static layout x-position
// relative to its offsetParent. The scroller MUST have
// `position: relative` so it IS the offsetParent; otherwise
// offsetLeft is reported against a higher ancestor and the math is
// off by however much sits between them. Layout-static math means
// the target doesn't shift mid-animation as scrollLeft changes,
// which getBoundingClientRect-based math suffered from when called
// from rapid keypresses.
export function scrollTileIntoRowStart(
    tile: HTMLElement,
    paddingLeft: number = 0,
): void {
    const scroller = tile.parentElement;
    if (!scroller) return;
    const target = tile.offsetLeft - paddingLeft;
    const max = scroller.scrollWidth - scroller.clientWidth;
    smoothScrollTo(
        scroller,
        "x",
        Math.max(0, Math.min(Math.max(0, max), target)),
    );
}

// scrollWindowToTop animates window scroll to top.
export function scrollWindowToTop(): void {
    smoothScrollTo(window, "y", 0);
}

// scrollWindowToCenter scrolls the window so the given element is
// vertically centered in the viewport.
export function scrollWindowToCenter(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const elCenter = rect.top + window.scrollY + rect.height / 2;
    const target = Math.max(0, elCenter - window.innerHeight / 2);
    smoothScrollTo(window, "y", target);
}
