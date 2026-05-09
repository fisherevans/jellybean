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

export type HomeTab = "browse" | "library" | "tags";

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
        if (raw === "library" || raw === "tags") return raw;
    } catch {
        // ignore
    }
    return "browse";
}
