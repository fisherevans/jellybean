import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
    listProfiles,
    probeAdmin,
    removeProfile,
    setActiveKey,
    type AdminUser,
    type KidProfile,
} from "./auth";

// Profiles is the kids client landing page. Shows one tile per kid
// configured on this device. Single-tap activates that profile and routes
// to the library. With exactly one profile we skip the picker entirely;
// with zero we show an onboarding stub (or, if an admin cookie is present,
// an admin-only profile selector for testing the kids UI in-browser).

export default function Profiles() {
    const nav = useNavigate();
    const [profiles, setProfiles] = useState<KidProfile[]>(() => listProfiles());
    const [admin, setAdmin] = useState<AdminUser | null | undefined>(undefined);
    const [editMode, setEditMode] = useState(false);

    useEffect(() => {
        probeAdmin().then(setAdmin);
    }, []);

    useEffect(() => {
        if (profiles.length === 1 && !editMode) {
            setActiveKey(profiles[0]!.apiKey);
            nav("/library", { replace: true });
        }
    }, [profiles, editMode, nav]);

    function pick(p: KidProfile) {
        setActiveKey(p.apiKey);
        nav("/library");
    }

    function remove(apiKey: string) {
        const next = removeProfile(apiKey);
        setProfiles(next);
        if (next.length === 0) setEditMode(false);
    }

    if (profiles.length === 0) {
        return <EmptyState admin={admin} />;
    }

    return (
        <div className="picker">
            <h1>Who's watching?</h1>
            <div className="picker-grid">
                {profiles.map((p, i) => (
                    <div key={p.apiKey} className="picker-tile-wrap">
                        <button
                            className="picker-tile"
                            onClick={() => (editMode ? remove(p.apiKey) : pick(p))}
                            autoFocus={!editMode && i === 0}
                        >
                            <div className="picker-avatar">{firstLetter(p.name)}</div>
                            <div className="picker-name">{p.name}</div>
                            {editMode && <div className="picker-remove">remove</div>}
                        </button>
                    </div>
                ))}
            </div>
            <div className="picker-footer">
                <button onClick={() => setEditMode(!editMode)}>
                    {editMode ? "done" : "edit"}
                </button>
                <Link to="/setup" className="picker-link">
                    add profile
                </Link>
            </div>
        </div>
    );
}

function firstLetter(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed[0]!.toUpperCase() : "?";
}

function EmptyState({ admin }: { admin: AdminUser | null | undefined }) {
    if (admin) return <AdminPreview />;
    const url = `${window.location.origin}/kids/setup?key=KIDKEY&name=KIDNAME`;
    return (
        <div className="setup">
            <h1>Set up your TV</h1>
            <p>
                No kid profiles configured on this device yet. Open the parent
                web app, generate an API key for each kid, and visit this URL
                on this TV with the key + name filled in:
            </p>
            <pre className="snippet">
                <code>{url}</code>
            </pre>
            <p>
                Repeat for each kid that should appear on this TV. You can
                also enter values manually:
            </p>
            <Link to="/setup" className="picker-link">
                manual entry
            </Link>
        </div>
    );
}

type AdminProfile = { id: number; name: string };

// AdminPreview is dev-only: when there are zero kid profiles on this device
// but the request carries an admin cookie, show a profile dropdown so the
// kids UI is testable in-browser without minting a kid key. The selected
// profile id is passed to /library?profileId=N so the server can scope.
function AdminPreview() {
    const [adminProfiles, setAdminProfiles] = useState<AdminProfile[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch("/api/admin/profiles", { credentials: "same-origin" })
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(`${res.status} ${await res.text()}`);
                }
                return res.json();
            })
            .then((data: { profiles: AdminProfile[] }) =>
                setAdminProfiles(data.profiles ?? []),
            )
            .catch((err) => setError(String(err.message ?? err)));
    }, []);

    return (
        <div className="setup">
            <h1>Kids client preview (admin)</h1>
            <p>
                No kid profiles configured on this device. As an admin you
                can preview the kids UI scoped to any server-side profile;
                this is a dev-only path.
            </p>
            {error && <p className="error">{error}</p>}
            <ul className="library-list">
                {adminProfiles.map((p) => (
                    <li key={p.id}>
                        <Link to={`/library?profileId=${p.id}`}>
                            <span className="library-type">id {p.id}</span>{" "}
                            {p.name}
                        </Link>
                    </li>
                ))}
            </ul>
            <p>
                Or <Link to="/setup">add a real kid profile</Link>.
            </p>
        </div>
    );
}
