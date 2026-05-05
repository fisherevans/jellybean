import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api, type User } from "./api";
import { useActiveProfile } from "./activeProfile";

type Props = {
    user: User;
    onLogout: () => void;
};

type NavItem = { to: string; label: string; key?: "swipe" };

const links: NavItem[] = [
    { to: "/", label: "Home" },
    { to: "/swipe", label: "Swipe", key: "swipe" },
    { to: "/bulk", label: "Bulk categorize" },
    { to: "/activity", label: "Activity" },
    { to: "/search", label: "Search" },
    { to: "/tags", label: "Tags" },
    { to: "/layouts", label: "Layouts" },
    { to: "/profiles", label: "Profiles" },
    { to: "/manage-kids", label: "Kids" },
    { to: "/api-keys", label: "API keys" },
];

// Routes that operate on a single active profile. The profile picker is
// only useful on these; on settings pages (/profiles, /manage-kids) it
// just adds noise.
const PROFILE_SCOPED_ROUTES = new Set([
    "/",
    "/swipe",
    "/bulk",
    "/activity",
    "/search",
    "/tags",
]);

export default function Layout({ user, onLogout }: Props) {
    const { profile, profiles, setActive } = useActiveProfile();
    const location = useLocation();
    // /tags has a detail route /tags/:id that also benefits from the
    // picker (the detail page reads the visible-only items list scoped
    // to the active profile). Treat /tags/* as profile-scoped via a
    // prefix check rather than enumerating every detail variant.
    const showProfilePicker =
        PROFILE_SCOPED_ROUTES.has(location.pathname) ||
        location.pathname.startsWith("/tags/");
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
                        const isSwipe = l.key === "swipe";
                        const attention = isSwipe && (unsetCount ?? 0) > 0;
                        return (
                            <NavLink
                                key={l.to}
                                to={l.to}
                                end={l.to === "/"}
                                className={({ isActive }) =>
                                    [
                                        "nav-link",
                                        isActive && "active",
                                        isSwipe && "nav-link-primary",
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
