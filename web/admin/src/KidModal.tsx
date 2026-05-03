import { useEffect, useState } from "react";
import { api, HttpError, type JellyfinUser, type Kid, type Profile } from "./api";

type Props = {
    mode: "create" | "edit";
    kid?: Kid; // required when mode === "edit"
    profiles: Profile[];
    onSaved: () => void;
    onClose: () => void;
};

// KidModal handles create + edit. Create maps a Jellyfin user (picked from
// a dropdown of /Users) to a Jellybean profile. The kid's TV authenticates
// directly against Jellyfin on first launch, so no passwords or tokens are
// collected here. Edit mode only touches name + profile.

export default function KidModal({
    mode,
    kid,
    profiles,
    onSaved,
    onClose,
}: Props) {
    const [name, setName] = useState(kid?.name ?? "");
    const [profileId, setProfileId] = useState<number>(
        kid?.profileId ?? profiles[0]?.id ?? 0,
    );
    const [jellyfinUsers, setJellyfinUsers] = useState<JellyfinUser[] | null>(null);
    const [jellyfinUserId, setJellyfinUserId] = useState<string>("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape" && !busy) onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);

    // Only the create flow needs the Jellyfin user dropdown.
    useEffect(() => {
        if (mode !== "create") return;
        let cancelled = false;
        api.listJellyfinUsers()
            .then((res) => {
                if (cancelled) return;
                setJellyfinUsers(res.users);
                if (res.users.length > 0) {
                    setJellyfinUserId(res.users[0].id);
                }
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err instanceof HttpError ? err.message : String(err));
            });
        return () => {
            cancelled = true;
        };
    }, [mode]);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            if (mode === "create") {
                await api.createKid(name.trim(), profileId, jellyfinUserId);
                onSaved();
            } else if (kid) {
                await api.updateKid(kid.id, {
                    name: name.trim(),
                    profileId,
                });
                onSaved();
            }
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    function jellyfinUserLabel(u: JellyfinUser): string {
        const parts = [u.name];
        if (u.isAdmin) parts.push("(admin)");
        if (u.isDisabled) parts.push("(disabled)");
        if (u.assignedTo) parts.push(`(already → ${u.assignedTo})`);
        return parts.join(" ");
    }

    return (
        <div className="modal-backdrop" onClick={() => !busy && onClose()}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>{mode === "create" ? "Add kid" : `Edit ${kid?.name}`}</h2>
                <form className="modal-form" onSubmit={submit}>
                    <label>
                        Display name
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            autoFocus
                        />
                    </label>
                    <label>
                        Profile
                        <select
                            value={profileId}
                            onChange={(e) => setProfileId(Number(e.target.value))}
                            required
                        >
                            {profiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                    </label>

                    {mode === "create" && (
                        <label>
                            Jellyfin user
                            <select
                                value={jellyfinUserId}
                                onChange={(e) => setJellyfinUserId(e.target.value)}
                                required
                                disabled={jellyfinUsers === null}
                            >
                                {jellyfinUsers === null ? (
                                    <option value="">Loading users...</option>
                                ) : jellyfinUsers.length === 0 ? (
                                    <option value="">No Jellyfin users found</option>
                                ) : (
                                    jellyfinUsers.map((u) => (
                                        <option key={u.id} value={u.id}>
                                            {jellyfinUserLabel(u)}
                                        </option>
                                    ))
                                )}
                            </select>
                            <span className="modal-hint">
                                The kid's TV signs in to Jellyfin directly on first launch.
                                Jellybean only stores the mapping.
                            </span>
                        </label>
                    )}

                    {error && <div className="error">{error}</div>}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="submit" disabled={busy}>
                            {busy ? "Saving..." : mode === "create" ? "Add kid" : "Save"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
