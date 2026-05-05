import { useEffect, useState } from "react";
import { api, HttpError, type ProfileViewingControls } from "./api";
import SnapSlider from "./SnapSlider";
import ToggleSwitch from "./ToggleSwitch";
import ViewingPreview from "./ViewingPreview";

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

            <ViewingPreview
                dimPercent={cfg.dimPercent}
                redShiftPercent={cfg.redShiftPercent}
            />

            <SnapSlider
                label="Dim (darker, 0-80%)"
                value={cfg.dimPercent}
                min={0}
                max={80}
                step={5}
                suffix="%"
                snaps={[
                    { value: 0, label: "Off" },
                    { value: 15, label: "15%" },
                    { value: 30, label: "30%" },
                    { value: 50, label: "50%" },
                    { value: 80, label: "80%" },
                ]}
                onChange={(v) => set("dimPercent", v)}
            />

            <SnapSlider
                label="Red shift (warmer, 0-100%)"
                value={cfg.redShiftPercent}
                min={0}
                max={100}
                step={5}
                suffix="%"
                snaps={[
                    { value: 0, label: "Off" },
                    { value: 25, label: "25%" },
                    { value: 50, label: "50%" },
                    { value: 75, label: "75%" },
                    { value: 100, label: "Max" },
                ]}
                onChange={(v) => set("redShiftPercent", v)}
            />

            <label>
                Auto-off at clock time
                <input
                    type="time"
                    value={cfg.autoOffClockTime ?? ""}
                    onChange={(e) =>
                        set("autoOffClockTime", e.target.value)
                    }
                />
                <span className="help">
                    Locks the kid client out at this time each day.
                    Leave blank to disable.
                </span>
            </label>

            <ToggleSwitch
                label="Also auto-off when the daily time limit hits zero"
                description="Skips the locked-tile screen and goes straight to the lockout overlay when the kid runs out of minutes."
                checked={cfg.autoOffOnTimeLimit}
                onChange={(v) => set("autoOffOnTimeLimit", v)}
            />

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
