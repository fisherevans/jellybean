import { useEffect, useState } from "react";
import { api, HttpError, type Profile } from "../api";

export default function Profiles() {
    const [profiles, setProfiles] = useState<Profile[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [editing, setEditing] = useState<Profile | null>(null);
    const [busy, setBusy] = useState(false);

    async function refresh() {
        try {
            const res = await api.listProfiles();
            setProfiles(res.profiles);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
    }, []);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            if (editing) {
                await api.updateProfile(editing.id, name, description);
            } else {
                await api.createProfile(name, description);
            }
            setName("");
            setDescription("");
            setEditing(null);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    function startEdit(p: Profile) {
        setEditing(p);
        setName(p.name);
        setDescription(p.description ?? "");
    }

    function cancelEdit() {
        setEditing(null);
        setName("");
        setDescription("");
    }

    async function remove(p: Profile) {
        if (!confirm(`Delete profile "${p.name}"?`)) return;
        setError(null);
        try {
            await api.deleteProfile(p.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    return (
        <div className="page">
            <h1>Profiles</h1>
            <p className="muted">
                Profiles define what content a kid can see. v1 has no rules yet -
                profiles are name + description only. Each kid is assigned to one
                profile; multiple kids can share. Default exists from setup.
            </p>

            {error && <div className="error">{error}</div>}

            <form className="profile-form" onSubmit={submit}>
                <input
                    placeholder="Name (e.g. Young kids)"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                />
                <input
                    placeholder="Description (optional)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                />
                <button type="submit" disabled={busy}>
                    {editing ? "Save" : "Create"}
                </button>
                {editing && (
                    <button type="button" onClick={cancelEdit}>
                        Cancel
                    </button>
                )}
            </form>

            {profiles === null ? (
                <p className="muted">Loading...</p>
            ) : (
                <ul className="profile-list">
                    {profiles.map((p) => (
                        <li key={p.id}>
                            <div className="profile-row">
                                <div className="profile-info">
                                    <div className="profile-name">{p.name}</div>
                                    <div className="muted">
                                        {p.description ?? ""} · {p.kidCount} kid
                                        {p.kidCount === 1 ? "" : "s"}
                                    </div>
                                </div>
                                <div className="profile-actions">
                                    <button onClick={() => startEdit(p)}>Edit</button>
                                    <button
                                        onClick={() => remove(p)}
                                        disabled={p.name === "Default"}
                                        title={
                                            p.name === "Default"
                                                ? "Default profile cannot be deleted"
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
        </div>
    );
}
