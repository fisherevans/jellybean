import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Binoculars, MagnifyingGlass, Tag } from "@phosphor-icons/react";
import { type HomeTab } from "./kidNav";

// TabPill is the kid client's top-of-page navigation. Three tabs in
// a single rounded-rect frame:
//   - Browse  (binoculars)       -> /browse
//   - Library (magnifying-glass) -> /library
//   - Tags    (tag)              -> /tags  (placeholder)
//
// Mounted ONCE inside KidsHome layout - persists across page swaps.
// When `active` changes (path change), we just rewrite --hl-x /
// --hl-w on the frame; the CSS transition on transform + width
// animates from the previously-painted values to the new ones.
// Slow-mode body[data-perf="slow"] disables the transition (snap).
//
// Behavior:
//   * Left / Right: navigate to neighboring tab page. Edges clamp.
//   * Down: call onFocusContent so the page can focus its content.
//   * Hold Enter for 2s: call onOpenMenu (replaces the old menu pill).
//   * After 5s of no input on the tab nav, "Hold OK for settings"
//     hint appears top-right.

type Tab = HomeTab;

type Props = {
    active: Tab;
    // pass-through search params keep admin-preview links working
    search?: string;
    // True when the parent's focus model has D-pad focus on the
    // tab nav. Drives the outer border + the active tabIndex.
    focused: boolean;
    // Gates the window keydown listener. Same as `focused` by
    // default, but a modal opening above the tab pill (e.g.
    // MainMenuModal) sets this false so the listener stops
    // preventDefault'ing Enter while the modal's own listeners
    // are wired. The visual ring + tabIndex still follow
    // `focused` so Esc from the modal lands focus back on the
    // active button.
    listening?: boolean;
    // Parent gets the active button's element so it can imperatively
    // focus it when tabFocused becomes true.
    tabRef?: (el: HTMLButtonElement | null) => void;
    // Kid pressed Down while on the tab nav.
    onFocusContent?: () => void;
    // Kid held Enter for 2s.
    onOpenMenu?: () => void;
};

const TABS: { id: Tab; label: string; Icon: typeof Binoculars }[] = [
    { id: "browse", label: "Browse", Icon: Binoculars },
    { id: "library", label: "Library", Icon: MagnifyingGlass },
    { id: "tags", label: "Tags", Icon: Tag },
];

function tabIndex(id: Tab): number {
    return TABS.findIndex((t) => t.id === id);
}

export function tabHref(tab: Tab, search = ""): string {
    return `/${tab}${search}`;
}

const HOLD_ENTER_MS = 1000;
const HINT_IDLE_MS = 5000;

export default function TabPill({
    active,
    search = "",
    focused,
    listening,
    tabRef,
    onFocusContent,
    onOpenMenu,
}: Props) {
    // Default to the visual-focus value so existing callers that
    // don't pass `listening` keep the old behavior (listener
    // active whenever the pill is visually focused).
    const listenerActive = listening ?? focused;
    const nav = useNavigate();
    const frameRef = useRef<HTMLDivElement | null>(null);
    const buttonRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
        browse: null,
        library: null,
        tags: null,
    });
    const [showHint, setShowHint] = useState(false);
    // Tracks whether we've painted the highlight at least once on
    // this mount. KidsHome unmounts/remounts when the kid leaves
    // for a non-home page like /tags/:id and comes back, so the
    // first paint must SNAP to the active tab instead of animating
    // from --hl-x=0px (which made the highlight slide in from the
    // Browse position every time the kid backed out of TagDetail).
    const hasPaintedRef = useRef(false);
    // Last dimensions we wrote to the highlight CSS variables.
    // Used to dedupe ResizeObserver fires that report the same
    // dimensions we already set (the initial-observation callback
    // is one such fire). Without this, the observer would call
    // writeHighlight(snap=true) right after an active-change wrote
    // animated NEW values, and the data-snap attribute would
    // interrupt the in-progress slide animation.
    const lastWrittenRef = useRef<{ x: number; w: number } | null>(null);

    // Position the highlight pill at the active tab's button. On
    // subsequent active changes (kid navigates Browse <-> Library
    // <-> Tags via the pill itself) the CSS transition runs from
    // the previously-painted values to the new ones. The first
    // paint per mount is intentionally snapped via data-snap so
    // remounting on /tags doesn't read as an animated entrance.
    //
    // A ResizeObserver re-measures whenever the active button or
    // its frame container changes size. On first page load the
    // webfont may not be ready when useLayoutEffect first runs, so
    // offsetLeft/offsetWidth read stale values - measured most
    // visibly when /tags is the landing page (rightmost button +
    // wrong width = highlight overflows the frame). The observer
    // fires again once fonts settle the layout, snapping the
    // highlight to the correct dimensions without animating
    // (an animated re-fit would read as the pill drifting on its
    // own without any user input).
    //
    // The dedupe via lastWrittenRef is load-bearing: ResizeObserver
    // ALWAYS fires once on initial observation with the current
    // size. After an active-change writes new (animated) dimensions
    // in the layout-effect, the observer's initial fire on the new
    // target reports those same dimensions; without the dedupe we'd
    // re-write them with snap=true and kill the slide animation
    // mid-flight.
    useLayoutEffect(() => {
        const frame = frameRef.current;
        if (!frame) return;
        const target = buttonRefs.current[active];
        if (!target) return;
        const writeHighlight = (forceSnap: boolean) => {
            const x = target.offsetLeft;
            const w = target.offsetWidth;
            const last = lastWrittenRef.current;
            if (last && last.x === x && last.w === w) {
                return;
            }
            lastWrittenRef.current = { x, w };
            if (forceSnap) {
                frame.dataset.snap = "1";
            }
            frame.style.setProperty("--hl-x", `${x}px`);
            frame.style.setProperty("--hl-w", `${w}px`);
            if (forceSnap) {
                // Force a synchronous reflow so the snapped values
                // commit before we re-enable the transition.
                void frame.offsetWidth;
                requestAnimationFrame(() => {
                    if (frameRef.current) {
                        delete frameRef.current.dataset.snap;
                    }
                });
            }
        };
        writeHighlight(!hasPaintedRef.current);
        hasPaintedRef.current = true;
        const ro = new ResizeObserver(() => writeHighlight(true));
        ro.observe(target);
        ro.observe(frame);
        return () => ro.disconnect();
    }, [active]);

    // Tab-nav-focused keyboard handling. Left/Right navigate;
    // Down hands off to parent; Enter-hold opens menu; idle hint
    // appears after 5s of no input. Gated on `listenerActive` so a
    // modal opened above the pill can suppress this listener
    // without dropping the visual active-tab ring.
    useEffect(() => {
        if (!listenerActive) {
            setShowHint(false);
            return;
        }
        let holdTimer: number | null = null;
        let hintTimer: number | null = null;
        let enterArmed = false;
        const startHintTimer = () => {
            if (hintTimer !== null) clearTimeout(hintTimer);
            hintTimer = window.setTimeout(() => {
                setShowHint(true);
            }, HINT_IDLE_MS);
        };
        const cancelHold = () => {
            if (holdTimer !== null) {
                clearTimeout(holdTimer);
                holdTimer = null;
            }
            enterArmed = false;
        };
        const navigateTab = (delta: -1 | 1) => {
            const i = tabIndex(active);
            const next = i + delta;
            if (next < 0 || next >= TABS.length) return;
            // Persistent layout means we navigate without flagging
            // the destination - the layout's tabFocused stays true
            // through the route change, so the new active button
            // gets focused via the layout's effect.
            nav(tabHref(TABS[next].id, search));
        };
        const onKeyDown = (e: KeyboardEvent) => {
            // Any keypress hides the hint and resets the idle timer.
            setShowHint(false);
            startHintTimer();

            if (e.key === "ArrowLeft") {
                e.preventDefault();
                cancelHold();
                navigateTab(-1);
                return;
            }
            if (e.key === "ArrowRight") {
                e.preventDefault();
                cancelHold();
                navigateTab(1);
                return;
            }
            if (e.key === "ArrowDown") {
                e.preventDefault();
                cancelHold();
                onFocusContent?.();
                return;
            }
            if (e.key === "Enter" || e.key === " ") {
                // Enter (D-pad center / OK) starts the menu hold
                // timer on a fresh press. Preventing default
                // suppresses the natural <button> click so a brief
                // tap doesn't navigate or activate; we own this key
                // entirely. Keyup before 2s cancels the timer; if
                // 2s elapses, onOpenMenu fires.
                e.preventDefault();
                if (e.repeat) return;
                if (enterArmed) return;
                enterArmed = true;
                holdTimer = window.setTimeout(() => {
                    holdTimer = null;
                    enterArmed = false;
                    onOpenMenu?.();
                }, HOLD_ENTER_MS);
                return;
            }
            // Other keys cancel the hold (so accidentally tapping
            // another key while holding Enter won't open the menu).
            cancelHold();
        };
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
                cancelHold();
            }
        };
        startHintTimer();
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            if (holdTimer !== null) clearTimeout(holdTimer);
            if (hintTimer !== null) clearTimeout(hintTimer);
        };
    }, [listenerActive, active, search, nav, onFocusContent, onOpenMenu]);

    return (
        <nav className="kids-tabpill" aria-label="Top-level navigation">
            <div
                ref={frameRef}
                className={`kids-tabpill-frame ${focused ? "focused" : ""}`}
                data-active={active}
            >
                <span className="kids-tabpill-highlight" aria-hidden />
                {TABS.map((t) => {
                    const isActive = t.id === active;
                    const Icon = t.Icon;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            ref={(el) => {
                                buttonRefs.current[t.id] = el;
                                if (isActive) tabRef?.(el);
                            }}
                            className={`kids-tabpill-tab ${
                                isActive ? "active" : ""
                            }`}
                            onClick={() => {
                                if (isActive) return;
                                nav(tabHref(t.id, search));
                            }}
                            aria-current={isActive ? "page" : undefined}
                            data-tab-id={t.id}
                            tabIndex={isActive && focused ? 0 : -1}
                        >
                            <Icon
                                weight="fill"
                                className="kids-tabpill-icon"
                                aria-hidden
                            />
                            <span className="kids-tabpill-label">
                                {t.label}
                            </span>
                        </button>
                    );
                })}
            </div>
            <div
                className={`kids-tabpill-hint ${showHint ? "visible" : ""}`}
                aria-hidden
            >
                Hold OK for settings
            </div>
        </nav>
    );
}
