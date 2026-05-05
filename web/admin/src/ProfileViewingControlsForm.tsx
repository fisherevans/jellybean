import { useEffect, useState } from "react";
import { api, HttpError, type ProfileViewingControls } from "./api";

// Per-profile viewing controls is now just the bedtime hard cutoff.
// Dim + warm tint moved onto modes (configure them inside a bedtime
// or focus mode); the "auto-off at zero minutes" toggle was dropped
// (the rolling-bucket lockout overlay always shows when M10's
// daily budget hits zero — no opt-in switch).

type Props = {
    profileId: number;
};

export default function ProfileViewingControlsForm({ profileId }: Props) {
    const [cfg, setCfg] = useState<ProfileViewingControls | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const got = await api.getProfileViewingControls(profileId);
                if (!cancelled) setCfg(got);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [profileId]);

    if (!cfg) {
        return error ? <p className="error">{error}</p> : <p>Loading...</p>;
    }

    function set<K extends keyof ProfileViewingControls>(
        key: K,
        v: ProfileViewingControls[K],
    ) {
        setCfg((c) => (c ? { ...c, [key]: v } : c));
        setSaved(false);
    }

    async function save() {
        if (!cfg) return;
        setSaving(true);
        setError(null);
        try {
            await api.setProfileViewingControls(profileId, cfg);
            setSaved(true);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="settings-form">
            <p className="muted">
                Hard bedtime cutoff for the kid client. Dim + warm tint
                aren't here — they're configured per mode (e.g. a
                "Bedtime" mode that applies a warm tint when active).
            </p>

            <label>
                Auto-disable streaming after
                <input
                    type="time"
                    value={cfg.autoOffClockTime ?? ""}
                    onChange={(e) =>
                        set("autoOffClockTime", e.target.value)
                    }
                />
                <span className="help">
                    Locks the kid client out with the bedtime overlay
                    starting at this clock time each day. Leave blank to
                    disable. An adult override can clear it for the
                    night.
                </span>
            </label>

            {error && <p className="error">{error}</p>}
            {saved && !error && <p className="muted">Saved.</p>}

            <div className="settings-actions">
                <button onClick={save} disabled={saving} className="primary">
                    {saving ? "Saving..." : "Save"}
                </button>
            </div>
        </div>
    );
}
