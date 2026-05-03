import { useEffect, useState } from "react";
import { api, HttpError, type Profile } from "../api";

type FormState = {
    name: string;
    description: string;
};

const blankForm: FormState = { name: "", description: "" };

export default function Profiles() {
    const [profiles, setProfiles] = useState<Profile[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [form, setForm] = useState<FormState>(blankForm);
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
                await api.updateProfile(editing.id, form);
            } else {
                await api.createProfile(form);
            }
            setForm(blankForm);
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
        setForm({ name: p.name, description: p.description ?? "" });
    }

    function cancelEdit() {
        setEditing(null);
        setForm(blankForm);
    }

    async function remove(p: Profile) {
        if (!confirm(`Delete profile "${p.name}"? Visibility decisions made for it will be lost.`)) return;
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
                Each profile carries its own visibility decisions. An item can be
                visible for one profile and hidden for another. Pick the active
                profile in the top nav before triaging.
            </p>

            {error && <div className="error">{error}</div>}

            <form className="profile-form" onSubmit={submit}>
                <input
                    placeholder="Name (e.g. Ollie)"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                />
                <input
                    placeholder="Description (optional)"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
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
                                        {p.description ?? ""}
                                        {p.description ? " · " : ""}
                                        {p.kidCount} kid{p.kidCount === 1 ? "" : "s"}
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
