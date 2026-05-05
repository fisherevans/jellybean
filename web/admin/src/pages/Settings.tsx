import { useEffect, useState } from "react";
import { api, HttpError } from "../api";
import Spinner from "../Spinner";
import PinInput from "../PinInput";

// Settings page (M9 #57). Houses the override PIN config + the
// public_url app_setting that the kid client's QR-code generator
// uses to build deep links.
//
// PIN flow: typing into the input + clicking Save sends the
// plaintext to the server, which bcrypt-hashes it. The plaintext
// never leaves the form. Clear erases the PIN entirely (override
// becomes unavailable on the kid TV).

export default function Settings() {
    const [override, setOverride] = useState<{
        pinSet: boolean;
        failedAttempts: number;
        lockedForSeconds: number;
    } | null>(null);
    const [pin, setPin] = useState("");
    const [editingPIN, setEditingPIN] = useState(false);
    const [publicUrl, setPublicUrl] = useState("");
    const [pubBaseline, setPubBaseline] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    async function refresh() {
        try {
            const [ov, set] = await Promise.all([
                api.getOverrideStatus(),
                api.listSettings(),
            ]);
            setOverride({
                pinSet: ov.pinSet,
                failedAttempts: ov.failedAttempts,
                lockedForSeconds: ov.lockedForSeconds,
            });
            setPublicUrl(set.settings.public_url ?? "");
            setPubBaseline(set.settings.public_url ?? "");
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }
    useEffect(() => {
        refresh();
    }, []);

    async function savePIN(e: React.FormEvent) {
        e.preventDefault();
        if (pin.length < 4) {
            setError("PIN must be 4 digits.");
            return;
        }
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            await api.setOverridePIN(pin);
            setPin("");
            setEditingPIN(false);
            setNotice("PIN saved.");
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function clearPIN() {
        if (!override?.pinSet) return;
        if (
            !confirm(
                "Clear the override PIN? The override gesture on the kid TV will stop working until a new PIN is set.",
            )
        )
            return;
        setBusy(true);
        try {
            await api.setOverridePIN("");
            setNotice("PIN cleared.");
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function clearLockout() {
        try {
            await api.clearOverrideLockout();
            setNotice("Lockout cleared.");
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function savePublicURL() {
        setBusy(true);
        setError(null);
        try {
            await api.setSetting("public_url", publicUrl.trim());
            setNotice("Public URL saved.");
            setPubBaseline(publicUrl.trim());
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    if (override === null) {
        return (
            <div className="page">
                <Spinner block size={36} label="Loading settings…" />
            </div>
        );
    }

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Settings</h1>
                    <p className="muted">
                        Cross-cutting configuration. The override PIN gates the
                        kid TV's adult menu; the public URL is what we put in
                        the QR code so the parent can scan it on their phone.
                    </p>
                </div>
            </div>

            {error && <div className="error">{error}</div>}
            {notice && <div className="settings-notice">{notice}</div>}

            <h2 className="section-title">Adult override PIN</h2>
            <p className="muted">
                Status:{" "}
                {override.pinSet ? (
                    <strong>Configured</strong>
                ) : (
                    <strong>Not set — override is disabled on the kid TV</strong>
                )}
                {override.lockedForSeconds > 0 ? (
                    <>
                        {" "}
                        · <strong>Locked for {override.lockedForSeconds}s</strong>
                    </>
                ) : null}
                {override.failedAttempts > 0 ? (
                    <>
                        {" "}
                        · {override.failedAttempts} recent failed attempts
                    </>
                ) : null}
            </p>
            {override.pinSet && !editingPIN ? (
                <div className="settings-form">
                    <label>
                        Current PIN
                        {/* Show the configured PIN as four masked
                            cells so the layout is consistent with
                            the edit-mode input. The actual digits
                            stay server-side; the read view only
                            confirms one is set. */}
                        <div className="pin-input">
                            {[0, 1, 2, 3].map((i) => (
                                <div key={i} className="pin-input-cell readonly">
                                    •
                                </div>
                            ))}
                        </div>
                    </label>
                    <div className="settings-actions">
                        <button
                            type="button"
                            className="primary"
                            onClick={() => {
                                setPin("");
                                setEditingPIN(true);
                            }}
                            disabled={busy}
                        >
                            Edit PIN
                        </button>
                        <button
                            type="button"
                            onClick={clearPIN}
                            disabled={busy}
                        >
                            Clear PIN
                        </button>
                        {override.lockedForSeconds > 0 ? (
                            <button type="button" onClick={clearLockout}>
                                Clear lockout
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : (
                <form className="settings-form" onSubmit={savePIN}>
                    <label>
                        {override.pinSet ? "New PIN" : "PIN"}
                        <PinInput
                            value={pin}
                            onChange={setPin}
                            disabled={busy}
                            autoFocus
                            onComplete={() => {
                                /* let the user click Save deliberately */
                            }}
                        />
                    </label>
                    <div className="settings-actions">
                        <button
                            type="submit"
                            className="primary"
                            disabled={busy || pin.length < 4}
                        >
                            {busy
                                ? "Saving…"
                                : override.pinSet
                                  ? "Update PIN"
                                  : "Set PIN"}
                        </button>
                        {override.pinSet ? (
                            <button
                                type="button"
                                onClick={() => {
                                    setEditingPIN(false);
                                    setPin("");
                                }}
                                disabled={busy}
                            >
                                Cancel
                            </button>
                        ) : null}
                    </div>
                </form>
            )}

            <h2 className="section-title">Public URL</h2>
            <p className="muted">
                The base URL to embed in the override QR code. Use the LAN IP +
                port for local testing, or the Cloudflare tunnel hostname for
                phone-from-anywhere access.
            </p>
            <form
                className="settings-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    savePublicURL();
                }}
            >
                <label>
                    Public URL
                    <input
                        type="url"
                        value={publicUrl}
                        onChange={(e) => setPublicUrl(e.target.value)}
                        placeholder="https://jellybean.example.com"
                        disabled={busy}
                    />
                </label>
                <div className="settings-actions">
                    <button
                        type="submit"
                        className="primary"
                        disabled={busy || publicUrl.trim() === pubBaseline}
                    >
                        {busy ? "Saving…" : "Save"}
                    </button>
                </div>
            </form>
        </div>
    );
}
