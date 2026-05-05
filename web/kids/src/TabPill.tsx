import { useNavigate } from "react-router-dom";

// TabPill is the shared top-of-page tab toggle between Browse and
// Library. Renders on /, /browse, and /library. The kid app's home
// is Browse; Library is the "see everything" view with filtering +
// search + (eventually M8 #49) alphabet jumpscroll.
//
// The pill participates in D-pad focus on the kid TV. The parent
// page owns the focus state machine and tells the pill which tab
// (if any) is currently focused via `focusedIndex`. The parent can
// also register refs for each tab button via `tabRef` so its focus
// effect can imperatively focus the underlying DOM element when the
// state machine parks on the pill.

type Tab = "browse" | "library";

type Props = {
    active: Tab;
    // pass-through search params keep admin-preview links working
    // (?profileId=N stays as the user toggles between tabs)
    search?: string;
    // Index of the focused tab (0 = Browse, 1 = Library) when the
    // parent's focus state has parked on the pill. null/undefined
    // means focus is elsewhere; no tab gets tabIndex=0 in that case.
    focusedIndex?: number | null;
    // Register a ref for each tab button. Parent uses these to
    // imperatively focus the tab when its focus model lands here.
    tabRef?: (i: number, el: HTMLButtonElement | null) => void;
};

const TABS: { key: Tab; label: string }[] = [
    { key: "browse", label: "Browse" },
    { key: "library", label: "Library" },
];

export function tabHref(tab: Tab, search = ""): string {
    return `/${tab}${search}`;
}

export default function TabPill({ active, search = "", focusedIndex, tabRef }: Props) {
    const nav = useNavigate();
    return (
        <nav className="kids-tabpill" aria-label="Top-level navigation">
            {TABS.map((t, i) => {
                const isFocused = focusedIndex === i;
                return (
                    <button
                        key={t.key}
                        type="button"
                        ref={(el) => tabRef?.(i, el)}
                        className={`kids-tabpill-btn ${active === t.key ? "active" : ""} ${
                            isFocused ? "focused" : ""
                        }`}
                        onClick={() => nav(tabHref(t.key, search))}
                        aria-current={active === t.key ? "page" : undefined}
                        data-tab-pill={t.key}
                        tabIndex={isFocused ? 0 : -1}
                    >
                        {t.label}
                    </button>
                );
            })}
        </nav>
    );
}
