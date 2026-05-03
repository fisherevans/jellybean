import { useEffect, useState } from "react";
import { api, HttpError, type Kid, type Profile } from "../api";
import KidModal from "../KidModal";

type Modal =
    | { kind: "closed" }
    | { kind: "create" }
    | { kind: "edit"; kid: Kid };

export default function Kids() {
    const [kids, setKids] = useState<Kid[] | null>(null);
    const [profiles, setProfiles] = useState<Profile[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<Modal>({ kind: "closed" });

    // Show-once API key dialog (after creating or regenerating).
    const [revealKey, setRevealKey] = useState<{ name: string; apiKey: string } | null>(null);

    async function refresh() {
        try {
            const [kidsRes, profilesRes] = await Promise.all([
                api.listKids(),
                api.listProfiles(),
            ]);
            setKids(kidsRes.kids);
            setProfiles(profilesRes.profiles);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
    }, []);

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
            <div className="page-head">
                <div>
                    <h1>Kids</h1>
                    <p className="muted">
                        Each kid maps to a Jellyfin user. We mint a per-kid Jellyfin token so
                        playback attributes correctly, and issue an API key the kid's TV
                        presents in the X-Jellybean-Key header. Passwords are never stored.
                    </p>
                </div>
                <button onClick={() => setModal({ kind: "create" })}>+ Add kid</button>
            </div>

            {error && <div className="error">{error}</div>}

            {kids === null ? (
                <p className="muted">Loading...</p>
            ) : kids.length === 0 ? (
                <p className="muted">No kids yet. Tap "+ Add kid" above.</p>
            ) : (
                <ul className="kid-list">
                    {kids.map((k) => (
                        <li key={k.id}>
                            <div className="kid-row">
                                <div className="kid-info">
                                    <div className="kid-name">{k.name}</div>
                                    <div className="muted">
                                        Profile: {k.profileName} · Jellyfin user: {k.jellyfinUserId} ·{" "}
                                        {k.hasToken ? "token issued" : "no token"}
                                    </div>
                                </div>
                                <div className="kid-actions">
                                    <a
                                        className="kid-preview"
                                        href={`/kids/library?profileId=${k.profileId}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="Open the kids client scoped to this kid's profile (admin cookie auth; library + filters work, but no resume / continue-watching since it's not the kid's Jellyfin token)"
                                    >
                                        View as {k.name}
                                    </a>
                                    <button onClick={() => setModal({ kind: "edit", kid: k })}>
                                        Edit
                                    </button>
                                    <button onClick={() => regenerate(k)}>Regenerate key</button>
                                    <button onClick={() => remove(k)}>Remove</button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {modal.kind !== "closed" && (
                <KidModal
                    mode={modal.kind}
                    kid={modal.kind === "edit" ? modal.kid : undefined}
                    profiles={profiles}
                    onClose={() => setModal({ kind: "closed" })}
                    onSaved={async (apiKey) => {
                        setModal({ kind: "closed" });
                        if (apiKey && modal.kind === "create") {
                            // Capture the newly created kid's name from the form.
                            // refresh() will give us the latest list to find it.
                            await refresh();
                            // Find the most recently created kid by ID and surface
                            // the show-once API key.
                            const latest = await api.listKids();
                            const newest = latest.kids[latest.kids.length - 1];
                            if (newest) {
                                setRevealKey({ name: newest.name, apiKey });
                            }
                        } else {
                            await refresh();
                        }
                    }}
                />
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
