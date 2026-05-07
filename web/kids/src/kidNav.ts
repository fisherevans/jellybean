// kidNav holds the kid client's small navigation state machine. The
// browser's history is unreliable on Android WebView (goBack() races,
// state.usr drops, location.key is rewritten across remounts) and
// fundamentally URL-shaped, which doesn't survive bookmarks or
// refreshes. Instead the kid app keeps its own tiny state in
// sessionStorage and reads it whenever a back-target needs to be
// resolved.
//
// Today the state is one field: which "home tab" the kid was last on
// (browse or library). When /watch fires Back, it looks here to
// decide where to send the kid - not at history. New navigation
// concepts (e.g. "open from search results", "deep link from QR")
// can extend this without growing the URL surface.

const HOME_TAB_KEY = "jellybean.kids.nav.homeTab";
const TAB_FOCUS_KEY = "jellybean.kids.nav.tabFocus";

export type HomeTab = "browse" | "library";

export function setHomeTab(tab: HomeTab): void {
    try {
        sessionStorage.setItem(HOME_TAB_KEY, tab);
    } catch {
        // sessionStorage disabled / quota - back-nav falls back to
        // the default ("browse") on read. No user-visible failure.
    }
}

export function getHomeTab(): HomeTab {
    try {
        const raw = sessionStorage.getItem(HOME_TAB_KEY);
        if (raw === "library") return "library";
    } catch {
        // ignore
    }
    return "browse";
}

// flagTabFocus / consumeTabFocus carry "land on this tab slot when
// the next page mounts" across a tab-arrow navigation. Browse tab +
// ArrowRight nav's to /library; Library should mount with focus on
// its tab[1] so the kid can keep arrowing without backing up. The
// flag is one-shot - the destination page consumes it on mount and
// clears the value, so a subsequent navigation that doesn't set the
// flag falls back to the page's normal initial-focus rules.
export function flagTabFocus(slot: number): void {
    try {
        sessionStorage.setItem(TAB_FOCUS_KEY, String(slot));
    } catch {
        // ignore
    }
}

export function consumeTabFocus(): number | null {
    try {
        const raw = sessionStorage.getItem(TAB_FOCUS_KEY);
        if (raw === null) return null;
        sessionStorage.removeItem(TAB_FOCUS_KEY);
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}
