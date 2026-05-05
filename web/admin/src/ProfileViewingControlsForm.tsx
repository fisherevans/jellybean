import { useEffect, useState } from "react";
import { api, HttpError, type ProfileViewingControls } from "./api";

// Per-profile viewing controls: dim, red-shift, clock-based auto-off.
// Effective values are baseline + per-kid overrides resolved at read
// time. Per-kid overrides are set from the override modal on the TV.

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
                Baseline screen effects applied to the kid client.
                Override values (with TTL) can be granted from the
                adult-override gesture on the TV.
            </p>

            <label>
                Dim (% darker, 0-80)
                <input
                    type="number"
                    min={0}
                    max={80}
                    value={cfg.dimPercent}
                    onChange={(e) => set("dimPercent", Number(e.target.value))}
                />
            </label>

            <label>
                Red shift (% warm, 0-100)
                <input
                    type="number"
                    min={0}
                    max={100}
                    value={cfg.redShiftPercent}
                    onChange={(e) =>
                        set("redShiftPercent", Number(e.target.value))
                    }
                />
            </label>

            <label>
                Auto-off at clock time (HH:MM 24h, blank to disable)
                <input
                    type="text"
                    placeholder="20:30"
                    value={cfg.autoOffClockTime ?? ""}
                    onChange={(e) =>
                        set("autoOffClockTime", e.target.value)
                    }
                />
            </label>

            <label className="checkbox">
                <input
                    type="checkbox"
                    checked={cfg.autoOffOnTimeLimit}
                    onChange={(e) =>
                        set("autoOffOnTimeLimit", e.target.checked)
                    }
                />
                Auto-off when the daily time limit hits zero
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
