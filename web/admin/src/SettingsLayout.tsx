import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { api, type Profile, type Layout } from "./api";

// Two-pane layout that wraps every admin / settings route. Left
// sidebar carries the section tree (Profiles can expand into the
// list of actual profiles, Layouts likewise); right pane renders
// the active route via <Outlet />.
//
// Drives the active-state styling off the URL so deep links open
// with the correct sidebar entry highlighted (eg /profiles/3 keeps
// the Profiles section expanded and "Default" selected).

export default function SettingsLayout() {
    const location = useLocation();
    const params = useParams();
    const [profiles, setProfiles] = useState<Profile[]>([]);
    const [layouts, setLayouts] = useState<Layout[]>([]);
    const [error, setError] = useState<string | null>(null);

    const path = location.pathname;
    const onProfilesPage =
        path === "/profiles" || path.startsWith("/profiles/");
    const onLayoutsPage =
        path === "/layouts" || path.startsWith("/layouts/");
    const activeProfileId = onProfilesPage ? Number(params.id) || null : null;
    const activeLayoutId = onLayoutsPage ? Number(params.layoutId) || null : null;

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [pRes, lRes] = await Promise.all([
                    api.listProfiles(),
                    api.listLayouts(),
                ]);
                if (cancelled) return;
                setProfiles(pRes.profiles);
                setLayouts(lRes.layouts);
            } catch (err) {
                if (!cancelled)
                    setError(err instanceof Error ? err.message : "load failed");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <div className="settings-layout">
            <aside className="settings-sidebar">
                <h2 className="settings-sidebar-title">Settings</h2>
                <nav className="settings-sidebar-nav">
                    <SettingsSection
                        label="Profiles"
                        rootHref="/profiles"
                        expanded={onProfilesPage}
                    >
                        {onProfilesPage &&
                            profiles.map((p) => (
                                <NavLink
                                    key={p.id}
                                    to={`/profiles/${p.id}`}
                                    className={() =>
                                        [
                                            "settings-sidebar-child",
                                            activeProfileId === p.id && "active",
                                        ]
                                            .filter(Boolean)
                                            .join(" ")
                                    }
                                >
                                    {p.name}
                                </NavLink>
                            ))}
                    </SettingsSection>

                    <SettingsLink to="/kids" label="Kids" />

                    <SettingsSection
                        label="Layouts"
                        rootHref="/layouts"
                        expanded={onLayoutsPage}
                    >
                        {onLayoutsPage &&
                            layouts.map((l) => (
                                <NavLink
                                    key={l.id}
                                    to={`/layouts/${l.id}`}
                                    className={() =>
                                        [
                                            "settings-sidebar-child",
                                            activeLayoutId === l.id && "active",
                                        ]
                                            .filter(Boolean)
                                            .join(" ")
                                    }
                                >
                                    {l.name}
                                    {l.isDefault ? (
                                        <span className="settings-sidebar-badge">
                                            default
                                        </span>
                                    ) : null}
                                </NavLink>
                            ))}
                    </SettingsSection>

                    <SettingsLink to="/activity" label="Activity" />
                    <SettingsLink to="/api-keys" label="API keys" />
                    <SettingsLink to="/settings" label="System" />
                </nav>
                {error && <p className="error">{error}</p>}
            </aside>
            <div className="settings-content">
                <Outlet />
            </div>
        </div>
    );
}

type SectionProps = {
    label: string;
    rootHref: string;
    expanded: boolean;
    children: React.ReactNode;
};

function SettingsSection({ label, rootHref, expanded, children }: SectionProps) {
    return (
        <div
            className={`settings-sidebar-section ${expanded ? "expanded" : ""}`}
        >
            <Link
                to={rootHref}
                className={`settings-sidebar-link ${expanded ? "active" : ""}`}
            >
                {label}
            </Link>
            {expanded && (
                <div className="settings-sidebar-children">{children}</div>
            )}
        </div>
    );
}

function SettingsLink({ to, label }: { to: string; label: string }) {
    return (
        <NavLink
            to={to}
            className={({ isActive }) =>
                [
                    "settings-sidebar-link",
                    isActive && "active",
                ]
                    .filter(Boolean)
                    .join(" ")
            }
        >
            {label}
        </NavLink>
    );
}
