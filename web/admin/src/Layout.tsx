import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api, type User } from "./api";
import { useActiveProfile } from "./activeProfile";

type Props = {
    user: User;
    onLogout: () => void;
};

type NavItem = {
    to: string;
    label: string;
    key?: "categorize";
    /** other paths whose match should also activate this link */
    matchPrefixes?: string[];
};

// Top-level nav is intentionally short. Categorize wraps swipe + bulk;
// Settings is a hub page that links to Profiles / Kids / Layouts / API
// keys / Activity / General settings so the bar isn't cluttered.
const links: NavItem[] = [
    { to: "/", label: "Home" },
    {
        to: "/categorize",
        label: "Categorize",
        key: "categorize",
        matchPrefixes: ["/categorize", "/swipe", "/bulk"],
    },
    { to: "/browse", label: "Browse" },
    { to: "/search", label: "Search" },
    { to: "/tags", label: "Tags", matchPrefixes: ["/tags"] },
    {
        to: "/admin",
        label: "Settings",
        matchPrefixes: [
            "/admin",
            "/profiles",
            "/kids",
            "/layouts",
            "/api-keys",
            "/settings",
            "/activity",
        ],
    },
];

// Routes that operate on a single active profile. The profile picker is
// only useful on these; on settings hub pages it just adds noise.
const PROFILE_SCOPED_PATHS = [
    "/",
    "/swipe",
    "/bulk",
    "/categorize",
    "/browse",
    "/search",
    "/tags",
];

export default function Layout({ user, onLogout }: Props) {
    const { profile, profiles, setActive } = useActiveProfile();
    const location = useLocation();
    const path = location.pathname;
    const showProfilePicker = PROFILE_SCOPED_PATHS.some(
        (p) => path === p || (p !== "/" && path.startsWith(p + "/")),
    );
    const [unsetCount, setUnsetCount] = useState<number | null>(null);

    // Fetch the active profile's "needs review" count so the Swipe nav
    // entry can call attention to itself when there's work to do. Stale
    // by definition (other tabs / actions don't notify), but the value
    // refreshes on profile switch and on full reloads, which is enough
    // for a nav-bar hint.
    useEffect(() => {
        if (!profile) {
            setUnsetCount(null);
            return;
        }
        let cancelled = false;
        api.listItems({
            profileId: profile.id,
            state: "unset",
            limit: 1,
            type: "Movie,Series",
        })
            .then((res) => {
                if (!cancelled) setUnsetCount(res.TotalRecordCount);
            })
            .catch(() => {
                if (!cancelled) setUnsetCount(null);
            });
        return () => {
            cancelled = true;
        };
    }, [profile?.id, location.pathname]);

    async function handleLogout() {
        try {
            await api.logout();
        } catch {
            /* ignore */
        }
        onLogout();
    }

    return (
        <div className="layout">
            <header className="topbar">
                <Link to="/" className="brand">
                    <img
                        src="/jellybean-admin.png"
                        alt=""
                        className="brand-mark"
                        width={32}
                        height={32}
                    />
                    Jellybean
                </Link>
                <nav className="nav">
                    {links.map((l) => {
                        const isCategorize = l.key === "categorize";
                        const attention = isCategorize && (unsetCount ?? 0) > 0;
                        const matched =
                            l.matchPrefixes?.some((p) =>
                                p === "/" ? path === "/" : path === p || path.startsWith(p + "/"),
                            ) ?? path === l.to;
                        return (
                            <NavLink
                                key={l.to}
                                to={l.to}
                                end={l.to === "/"}
                                className={() =>
                                    [
                                        "nav-link",
                                        matched && "active",
                                        isCategorize && "nav-link-primary",
                                        attention && "nav-link-attention",
                                    ]
                                        .filter(Boolean)
                                        .join(" ")
                                }
                            >
                                {l.label}
                                {attention && (
                                    <span className="nav-badge">{unsetCount}</span>
                                )}
                            </NavLink>
                        );
                    })}
                </nav>
                <div className="user">
                    {showProfilePicker && profiles.length > 0 && (
                        <label className="profile-pick">
                            <span>Profile</span>
                            <select
                                value={profile?.id ?? ""}
                                onChange={(e) => setActive(Number(e.target.value))}
                            >
                                {profiles.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    <span>{user.name}</span>
                    <button onClick={handleLogout}>Sign out</button>
                </div>
            </header>
            <main className="content">
                <Outlet />
            </main>
        </div>
    );
}
