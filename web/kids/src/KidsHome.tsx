import {
    createContext,
    useContext,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type RefObject,
} from "react";
import { Outlet, useLocation } from "react-router-dom";
import TabPill from "./TabPill";
import MainMenuModal from "./MainMenuModal";
import { setHomeTab, type HomeTab } from "./kidNav";

// KidsHome is the shared layout for /browse, /library, /tags. It owns:
//   - The TabPill at the top (single instance across all three pages
//     so the highlight animation persists across navigation and
//     positioning is consistent).
//   - tabFocused state (default true): whether the kid is on the tab
//     nav vs. inside a page's content. Pages call setTabFocused via
//     useKidsHome() when their content steals focus (e.g., Down from
//     tab) or releases it back (e.g., Up at the topmost row).
//   - The MainMenuModal (opened by an Enter-hold on the tab pill so
//     pages don't each manage their own copy of the modal).
//   - The .browse-active body class (only when on /browse - that
//     route uses transform-based scroll and can't tolerate body
//     scroll layered on top).
//
// Pages render via <Outlet/> as the second flex item in this layout.
// Sharing the layout means React doesn't unmount the chrome between
// page swaps; only the page's body content is replaced.

type Ctx = {
    tabFocused: boolean;
    setTabFocused: (b: boolean) => void;
    openMenu: () => void;
};

const KidsHomeContext = createContext<Ctx | null>(null);

export function useKidsHome(): Ctx {
    const ctx = useContext(KidsHomeContext);
    if (!ctx) {
        throw new Error(
            "useKidsHome must be used inside a KidsHome layout route",
        );
    }
    return ctx;
}

function pathToTab(pathname: string): HomeTab {
    if (pathname.startsWith("/library")) return "library";
    if (pathname.startsWith("/tags")) return "tags";
    return "browse";
}

export default function KidsHome() {
    const location = useLocation();
    const active = pathToTab(location.pathname);
    const [tabFocused, setTabFocused] = useState(true);
    const [menuOpen, setMenuOpen] = useState(false);
    const tabPillRef = useRef<HTMLButtonElement | null>(null);
    // renderedTab is the tab whose page content (via Outlet) is
    // actually mounted right now. On slow TVs this lags behind the
    // location-derived `active` by 2 rAFs after a path change, so
    // the loading interstitial paints between the previous page's
    // unmount and the next page's mount instead of the kid staring
    // at a frozen frame for the full duration of the synchronous
    // mount work. Fast TVs commit immediately - no perceptible
    // freeze, no interstitial needed.
    const [renderedTab, setRenderedTab] = useState<HomeTab>(active);

    // Per-tab random vertical offset for the rainbow bg. Each tab
    // gets its own offset, generated lazily on first visit (per
    // session). Switching tabs updates the CSS variable so the bg
    // appears at a different rainbow position; the kid sees a
    // visual change between pages even though the bg image itself
    // is identical. The dataset mirror lets Browse read the
    // numeric value from JS without unit parsing.
    const bgOffsetsRef = useRef<Record<HomeTab, number | null>>({
        browse: null,
        library: null,
        tags: null,
    });
    useLayoutEffect(() => {
        if (bgOffsetsRef.current[active] === null) {
            bgOffsetsRef.current[active] = Math.floor(
                Math.random() * 2 * window.innerHeight,
            );
        }
        const offset = bgOffsetsRef.current[active]!;
        document.documentElement.style.setProperty(
            "--kids-bg-offset-y",
            `${offset}px`,
        );
        document.documentElement.dataset.kidsBgOffsetY = String(offset);
        // Clear the per-frame scroll offset so a stale Browse value
        // doesn't shift the bg on Library/Tags. Browse re-writes it
        // each animator frame when active.
        document.documentElement.style.removeProperty("--kids-bg-pos-y");
    }, [active]);

    // Keep the home-tab pointer up to date for /watch's Back-target
    // logic. The path itself is the source of truth; setHomeTab just
    // mirrors it into sessionStorage so a deep link out of the home
    // tabs (Watch, Play) can find its way back later.
    useEffect(() => {
        setHomeTab(active);
    }, [active]);

    // Lock body scroll while inside any home tab. All three tabs
    // now use transform-based scroll (Browse via its own animator,
    // Library/Tags via useStackScroll), so body must stay at 0.
    // The class also gives .kids-home / .kids-tabpill-slot /
    // .kids-home-content their fixed-viewport layout via CSS rules
    // gated on body.kids-scroll-active.
    useEffect(() => {
        document.body.classList.add("kids-scroll-active");
        return () => document.body.classList.remove("kids-scroll-active");
    }, []);

    // Tab transition: defer mounting the new route on slow TVs so
    // the loading interstitial gets a chance to paint. Without this
    // the kid clicks Library while on /browse and sees Browse's
    // frame frozen for ~500ms (Browse unmount + Library mount work)
    // before the new page appears - looks like the TV locked up.
    //
    // Two rAFs:
    //   rAF #1: ensures the previous-page's unmount + the loading
    //           overlay's first render commits and paints.
    //   rAF #2: triggers the renderedTab state change, which makes
    //           Outlet render the new page on the very next frame.
    //
    // Net: kid sees the previous tab's content for 1 frame, then a
    // "Loading…" overlay for 1+ frames, then the new tab. On fast
    // TVs we skip the dance entirely.
    useLayoutEffect(() => {
        if (renderedTab === active) return;
        const isSlow = document.body?.dataset.perf === "slow";
        if (!isSlow) {
            setRenderedTab(active);
            return;
        }
        let id2: number | null = null;
        const id1 = requestAnimationFrame(() => {
            id2 = requestAnimationFrame(() => {
                setRenderedTab(active);
            });
        });
        return () => {
            cancelAnimationFrame(id1);
            if (id2 !== null) cancelAnimationFrame(id2);
        };
    }, [active, renderedTab]);

    const transitioning = renderedTab !== active;

    // Imperatively focus the active tab button when tabFocused is
    // true. Re-runs when the active tab changes too so cross-tab
    // navigation lands DOM focus on the new tab's button. Pages
    // running their own page-content focus path don't fight us
    // because they only do so when tabFocused goes false.
    useEffect(() => {
        if (!tabFocused) return;
        tabPillRef.current?.focus({ preventScroll: true });
    }, [tabFocused, active]);

    const ctx: Ctx = {
        tabFocused,
        setTabFocused,
        openMenu: () => setMenuOpen(true),
    };

    return (
        <KidsHomeContext.Provider value={ctx}>
            <div className="kids-home" data-active={active}>
                {/* Bg layer rendered behind everything so when the
                    TabPill scrolls up on /browse the kid sees the
                    rainbow extending all the way to the top of the
                    viewport (not a white bar). The bg is gated on
                    data-active="browse" via CSS so Library / Tags
                    don't pick it up. background-position-y is
                    driven by --kids-bg-pos-y written each animator
                    frame by Browse; falls back to the per-session
                    random offset when not set (slow mode + non-
                    browse routes). */}
                <div className="kids-home-bg" aria-hidden />
                {/* Slot wrapper so the TabPill can scroll with page
                    content on /browse (body is locked there, so we
                    drive the scroll via transform on a CSS variable
                    written by Browse's stack animator). On Library /
                    Tags, body scrolls naturally and the variable
                    stays at 0, so the TabPill scrolls with the rest
                    of the page in normal flow. */}
                <div className="kids-tabpill-slot">
                    <TabPill
                        active={active}
                        search={location.search}
                        focused={tabFocused}
                        tabRef={(el) => (tabPillRef.current = el)}
                        onFocusContent={() => setTabFocused(false)}
                        onOpenMenu={() => setMenuOpen(true)}
                    />
                </div>
                <main className="kids-home-content">
                    {transitioning ? (
                        <div
                            className="kids-route-interstitial"
                            role="status"
                            aria-live="polite"
                        >
                            <div className="kids-loading-dots" aria-hidden>
                                <span />
                                <span />
                                <span />
                            </div>
                            <p>Loading…</p>
                        </div>
                    ) : (
                        <Outlet />
                    )}
                </main>
                {menuOpen && (
                    <MainMenuModal onClose={() => setMenuOpen(false)} />
                )}
            </div>
        </KidsHomeContext.Provider>
    );
}

// Shared ref helper used by Browse to stash a DOM ref through the
// context if needed by the bg layer. (Not used today; reserved for
// future shared bg work.)
export type { RefObject };
