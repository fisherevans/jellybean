import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Layout } from "../api";
import Spinner from "../Spinner";
import LayoutCreateModal from "../LayoutCreateModal";

// Layouts list (M8 #50). Lists every layout with row count + profile
// count, supports create / clone / delete (default protected). Per-row
// "Open" link opens the editor at /admin/layouts/:id.

export default function Layouts() {
    const [layouts, setLayouts] = useState<Layout[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    async function refresh() {
        try {
            const res = await api.listLayouts();
            setLayouts(res.layouts);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
    }, []);

    async function clone(l: Layout) {
        const name = prompt(`Clone "${l.name}" as:`, l.name + " (copy)");
        if (!name?.trim()) return;
        try {
            await api.cloneLayout(l.id, name.trim());
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function remove(l: Layout) {
        if (l.isDefault) return;
        if (l.profileCount > 0) {
            alert(
                `"${l.name}" is assigned to ${l.profileCount} profile${l.profileCount === 1 ? "" : "s"}. Reassign them to another layout first.`,
            );
            return;
        }
        if (!confirm(`Delete layout "${l.name}"?`)) return;
        try {
            await api.deleteLayout(l.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function setAsDefault(l: Layout) {
        if (l.isDefault) return;
        if (
            !confirm(
                `Set "${l.name}" as the default layout? New profiles will use this layout.`,
            )
        )
            return;
        try {
            await api.setDefaultLayout(l.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Layouts</h1>
                    <p className="muted">
                        Layouts define the kid Browse screen. Each layout is an
                        ordered list of rows — Continue Watching, Favorites,
                        per-tag rows, recently added, etc. Profiles reference a
                        layout; multiple profiles can share one.
                    </p>
                </div>
                <button onClick={() => setCreating(true)}>+ New layout</button>
            </div>

            {error && <div className="error">{error}</div>}

            {layouts === null ? (
                <Spinner block size={36} label="Loading layouts…" />
            ) : layouts.length === 0 ? (
                <p className="muted">No layouts yet.</p>
            ) : (
                <ul className="profile-list">
                    {layouts.map((l) => (
                        <li key={l.id}>
                            <div className="profile-row">
                                <div className="profile-info">
                                    <Link
                                        to={`/layouts/${l.id}`}
                                        className="profile-name"
                                    >
                                        {l.name}
                                        {l.isDefault ? " · default" : ""}
                                    </Link>
                                    {l.description ? (
                                        <div className="muted">
                                            {l.description}
                                        </div>
                                    ) : null}
                                    <div className="muted">
                                        {l.rows.length} row
                                        {l.rows.length === 1 ? "" : "s"} ·{" "}
                                        {l.profileCount} profile
                                        {l.profileCount === 1 ? "" : "s"}
                                    </div>
                                </div>
                                <div className="profile-actions">
                                    <Link to={`/layouts/${l.id}`}>
                                        <button>Edit</button>
                                    </Link>
                                    <button onClick={() => clone(l)}>Clone</button>
                                    <button
                                        onClick={() => setAsDefault(l)}
                                        disabled={l.isDefault}
                                    >
                                        Set default
                                    </button>
                                    <button
                                        onClick={() => remove(l)}
                                        disabled={l.isDefault}
                                        title={
                                            l.isDefault
                                                ? "Default layout cannot be deleted"
                                                : ""
                                        }
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {creating && (
                <LayoutCreateModal
                    onClose={() => setCreating(false)}
                    onSaved={async () => {
                        setCreating(false);
                        await refresh();
                    }}
                />
            )}
        </div>
    );
}
