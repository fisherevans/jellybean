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
const EASE = 0.22;
const SETTLE_PX = 0.5;

export function smoothScrollTo(
    el: Element | Window,
    axis: Axis,
    target: number,
): void {
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
        setCurrent(el, axis, current + dist * EASE);
        state.rafId = requestAnimationFrame(step);
    };
    step();
}

// scrollTileIntoRowStart scrolls a horizontal scroller (e.g. a
// .browse-row-items) so the given tile lands at the start of the
// visible area, with `paddingLeft` of inset.
//
// Uses getBoundingClientRect math instead of offsetLeft because
// offsetLeft is relative to the nearest positioned ancestor, which
// often isn't the scroller (the scroller has display:flex, no
// position: relative). The bounding-rect approach gives an absolute
// "how far left/right from current scroll" that's robust to the
// scroller's positioning context.
export function scrollTileIntoRowStart(
    tile: HTMLElement,
    paddingLeft: number = 0,
): void {
    const scroller = tile.parentElement;
    if (!scroller) return;
    const tileRect = tile.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const delta = tileRect.left - scrollerRect.left - paddingLeft;
    const target = scroller.scrollLeft + delta;
    const max = scroller.scrollWidth - scroller.clientWidth;
    smoothScrollTo(
        scroller,
        "x",
        Math.max(0, Math.min(max, target)),
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
