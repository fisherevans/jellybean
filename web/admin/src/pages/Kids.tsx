import { useEffect, useState } from "react";
import { api, HttpError, type Kid, type Profile } from "../api";
// useState is also used inside RevealKey below.

export default function Kids() {
    const [kids, setKids] = useState<Kid[] | null>(null);
    const [profiles, setProfiles] = useState<Profile[]>([]);
    const [error, setError] = useState<string | null>(null);

    // Add-kid form
    const [name, setName] = useState("");
    const [profileId, setProfileId] = useState<number>(0);
    const [jellyfinUsername, setJellyfinUsername] = useState("");
    const [jellyfinPassword, setJellyfinPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);

    // Show-once API key dialog
    const [revealKey, setRevealKey] = useState<{ name: string; apiKey: string } | null>(null);

    async function refresh() {
        try {
            const [kidsRes, profilesRes] = await Promise.all([
                api.listKids(),
                api.listProfiles(),
            ]);
            setKids(kidsRes.kids);
            setProfiles(profilesRes.profiles);
            if (!profileId && profilesRes.profiles.length > 0) {
                setProfileId(profilesRes.profiles[0].id);
            }
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
        setSubmitting(true);
        try {
            const res = await api.createKid(
                name.trim(),
                profileId,
                jellyfinUsername.trim(),
                jellyfinPassword,
            );
            setName("");
            setJellyfinUsername("");
            setJellyfinPassword("");
            setRevealKey({ name: res.kid.name, apiKey: res.apiKey });
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    }

    async function regenerate(k: Kid) {
        if (!confirm(`Regenerate API key for "${k.name}"? The old key will stop working immediately.`)) {
            return;
        }
        try {
            const res = await api.regenerateKidKey(k.id);
            setRevealKey({ name: k.name, apiKey: res.apiKey });
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function changeProfile(k: Kid, nextProfileId: number) {
        if (nextProfileId === k.profileId) return;
        setError(null);
        try {
            await api.updateKidProfile(k.id, nextProfileId);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function remove(k: Kid) {
        if (!confirm(`Remove kid "${k.name}"? This deletes the API key but does not revoke the Jellyfin token.`)) {
            return;
        }
        try {
            await api.deleteKid(k.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    return (
        <div className="page">
            <h1>Kids</h1>
            <p className="muted">
                Each kid maps to a Jellyfin user. We mint a per-kid Jellyfin token so
                playback attributes correctly, and issue an API key the kid's TV
                presents in the X-Jellybean-Key header. Passwords are never stored.
            </p>

            {error && <div className="error">{error}</div>}

            <form className="kid-form kid-form-grid" onSubmit={submit}>
                <h3 className="kid-form-title">Add a kid</h3>
                <label>
                    Display name
                    <input value={name} onChange={(e) => setName(e.target.value)} required />
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
                <label>
                    Jellyfin username
                    <input
                        value={jellyfinUsername}
                        onChange={(e) => setJellyfinUsername(e.target.value)}
                        required
                        autoComplete="username"
                    />
                </label>
                <label>
                    Jellyfin password
                    <input
                        type="password"
                        value={jellyfinPassword}
                        onChange={(e) => setJellyfinPassword(e.target.value)}
                        required
                        autoComplete="new-password"
                    />
                </label>
                <div className="kid-form-actions">
                    <button type="submit" disabled={submitting}>
                        {submitting ? "Adding..." : "Add kid"}
                    </button>
                </div>
            </form>

            {kids === null ? (
                <p className="muted">Loading...</p>
            ) : kids.length === 0 ? (
                <p className="muted">No kids yet. Add one above.</p>
            ) : (
                <ul className="kid-list">
                    {kids.map((k) => (
                        <li key={k.id}>
                            <div className="kid-row">
                                <div className="kid-info">
                                    <div className="kid-name">{k.name}</div>
                                    <div className="muted">
                                        Jellyfin user: {k.jellyfinUserId} ·{" "}
                                        {k.hasToken ? "token issued" : "no token"}
                                    </div>
                                </div>
                                <label className="kid-profile-pick">
                                    <span className="muted">Profile</span>
                                    <select
                                        value={k.profileId}
                                        onChange={(e) =>
                                            changeProfile(k, Number(e.target.value))
                                        }
                                    >
                                        {profiles.map((p) => (
                                            <option key={p.id} value={p.id}>
                                                {p.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <div className="kid-actions">
                                    <a
                                        className="kid-preview"
                                        href={`/kids/library?profileId=${k.profileId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="Open the kids client scoped to this kid's profile (admin cookie auth; library + filters work, but no resume / continue-watching since it's not the kid's Jellyfin token)"
                                    >
                                        View app as {k.name}
                                    </a>
                                    <button onClick={() => regenerate(k)}>Regenerate key</button>
                                    <button onClick={() => remove(k)}>Remove</button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {revealKey && (
                <RevealKey
                    name={revealKey.name}
                    apiKey={revealKey.apiKey}
                    onClose={() => setRevealKey(null)}
                />
            )}
        </div>
    );
}

function RevealKey({ name, apiKey, onClose }: { name: string; apiKey: string; onClose: () => void }) {
    const [copied, setCopied] = useState(false);
    const [copyFailed, setCopyFailed] = useState(false);
    async function copy() {
        setCopyFailed(false);
        try {
            await navigator.clipboard.writeText(apiKey);
            setCopied(true);
        } catch {
            setCopyFailed(true);
        }
    }
    // Backdrop click is intentionally a no-op so an accidental click
    // doesn't lose the key. The "I saved it" button is the only way out.
    return (
        <div className="modal-backdrop">
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>API key for {name}</h2>
                <p>
                    Save this somewhere safe. <strong>It won't be shown again.</strong>{" "}
                    Paste it into the kid's TV (X-Jellybean-Key).
                </p>
                <pre className="api-key">{apiKey}</pre>
                {copied && <p className="muted">Copied to clipboard.</p>}
                {copyFailed && (
                    <p className="error">
                        Clipboard write failed. Select the key above and copy manually.
                    </p>
                )}
                <div className="modal-actions">
                    <button onClick={copy}>Copy</button>
                    <button onClick={onClose}>I saved it</button>
                </div>
            </div>
        </div>
    );
}
