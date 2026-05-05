import { useNavigate } from "react-router-dom";

// TabPill is the shared top-of-page tab toggle between Browse and
// Library. Renders on /, /browse, and /library. The kid app's home
// is Browse; Library is the "see everything" view with filtering +
// search + (eventually M8 #49) alphabet jumpscroll.
//
// The pill participates in D-pad focus on the kid TV: each page
// owns its own focus model, but the pill component publishes a
// `data-tab-pill` attribute so page-level keydown handlers can
// detect when focus is parked there and route Up/Down properly.

type Tab = "browse" | "library";

type Props = {
    active: Tab;
    // pass-through search params keep admin-preview links working
    // (?profileId=N stays as the user toggles between tabs)
    search?: string;
};

export default function TabPill({ active, search = "" }: Props) {
    const nav = useNavigate();
    const tabs: { key: Tab; label: string; href: string }[] = [
        { key: "browse", label: "Browse", href: `/browse${search}` },
        { key: "library", label: "Library", href: `/library${search}` },
    ];
    return (
        <nav className="kids-tabpill" aria-label="Top-level navigation">
            {tabs.map((t) => (
                <button
                    key={t.key}
                    type="button"
                    className={`kids-tabpill-btn ${active === t.key ? "active" : ""}`}
                    onClick={() => nav(t.href)}
                    aria-current={active === t.key ? "page" : undefined}
                    data-tab-pill={t.key}
                >
                    {t.label}
                </button>
            ))}
        </nav>
    );
}
