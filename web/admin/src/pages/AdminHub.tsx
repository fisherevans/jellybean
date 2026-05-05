import { Link } from "react-router-dom";

// Settings hub page. The top-level nav points here; this page links
// out to every admin-side surface (profiles, kids, layouts, api keys,
// activity, system settings). Keeps the top nav short while still
// surfacing the deeper admin tools.

type Card = {
    to: string;
    title: string;
    description: string;
};

const CARDS: Card[] = [
    {
        to: "/profiles",
        title: "Profiles",
        description:
            "Per-profile visibility decisions, tag rules, time limits, body breaks, viewing controls, modes, and channels.",
    },
    {
        to: "/kids",
        title: "Kids",
        description:
            "Map Jellyfin users to Jellybean profiles. The kid TV / app authenticates directly with Jellyfin.",
    },
    {
        to: "/layouts",
        title: "Layouts",
        description:
            "Define the kid Browse screen. An ordered list of rows (Continue Watching, Favorites, per-tag, recently added, etc.).",
    },
    {
        to: "/activity",
        title: "Activity",
        description:
            "Recent visibility changes across all profiles. Useful for spot-checking a kid's library after a triage session.",
    },
    {
        to: "/api-keys",
        title: "API keys",
        description:
            "Bearer tokens for headless admin access. Equivalent permission to the admin cookie - no scopes in v1.",
    },
    {
        to: "/settings",
        title: "System",
        description:
            "Adult override PIN and the public URL embedded in override QR codes.",
    },
];

export default function AdminHub() {
    return (
        <div className="page admin-hub">
            <div className="page-head">
                <div>
                    <h1>Settings</h1>
                    <p className="muted">
                        Admin tools, profile management, and system
                        configuration.
                    </p>
                </div>
            </div>

            <div className="admin-hub-grid">
                {CARDS.map((c) => (
                    <Link key={c.to} to={c.to} className="admin-hub-card">
                        <div className="admin-hub-card-title">{c.title}</div>
                        <div className="admin-hub-card-desc">{c.description}</div>
                        <div className="admin-hub-card-arrow">→</div>
                    </Link>
                ))}
            </div>
        </div>
    );
}
