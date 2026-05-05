import { useEffect, useState } from "react";
import { api, HttpError, type ProfileBodyBreaks } from "./api";
import SnapSlider from "./SnapSlider";
import ToggleSwitch from "./ToggleSwitch";

// Per-profile body-breaks: cadence + voice template + reasons list.
// The accumulator decays on pause / menu / browse and resets on
// cross-content swap (next episode of the same series does NOT
// reset the counter).

type Props = {
    profileId: number;
};

export default function ProfileBodyBreaksForm({ profileId }: Props) {
    const [cfg, setCfg] = useState<ProfileBodyBreaks | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [reasonsRaw, setReasonsRaw] = useState("");

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const got = await api.getProfileBodyBreaks(profileId);
                if (!cancelled) {
                    setCfg(got);
                    setReasonsRaw((got.reasons ?? []).join("\n"));
                }
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

    function set<K extends keyof ProfileBodyBreaks>(key: K, v: ProfileBodyBreaks[K]) {
        setCfg((c) => (c ? { ...c, [key]: v } : c));
        setSaved(false);
    }

    async function resetDefaults() {
        if (!confirm("Reset voice message + reasons to the defaults? Your current values will be discarded.")) return;
        setSaving(true);
        setError(null);
        try {
            const fresh = await api.resetProfileBodyBreaks(profileId);
            setCfg(fresh);
            setReasonsRaw((fresh.reasons ?? []).join("\n"));
            setSaved(true);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    async function save() {
        if (!cfg) return;
        const reasons = reasonsRaw
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        setSaving(true);
        setError(null);
        try {
            await api.setProfileBodyBreaks(profileId, { ...cfg, reasons });
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
                Forced break overlay after a continuous-play threshold.
                The accumulator decays on pause, menu, or browse, and
                resets on a cross-content swap. The next episode of
                the same series does not reset the counter.
            </p>

            <ToggleSwitch
                label="Enable body breaks for this profile"
                description="When disabled, the kid is never interrupted by a break overlay."
                checked={cfg.enabled}
                onChange={(v) => set("enabled", v)}
            />

            <SnapSlider
                label="Play time before break"
                value={cfg.playMinutes}
                min={5}
                max={240}
                step={5}
                suffix="min"
                snaps={[
                    { value: 15, label: "15m" },
                    { value: 30, label: "30m" },
                    { value: 45, label: "45m" },
                    { value: 60, label: "1h" },
                    { value: 90, label: "1.5h" },
                    { value: 120, label: "2h" },
                ]}
                onChange={(v) => set("playMinutes", v)}
            />

            <SnapSlider
                label="Break duration"
                value={cfg.breakMinutes}
                min={1}
                max={30}
                step={1}
                suffix="min"
                snaps={[
                    { value: 1, label: "1m" },
                    { value: 3, label: "3m" },
                    { value: 5, label: "5m" },
                    { value: 10, label: "10m" },
                    { value: 15, label: "15m" },
                ]}
                onChange={(v) => set("breakMinutes", v)}
            />

            <label>
                Voice message template
                <input
                    type="text"
                    value={cfg.voiceMessageTemplate}
                    onChange={(e) =>
                        set("voiceMessageTemplate", e.target.value)
                    }
                />
                <span className="help">
                    Use <code>{"{reason}"}</code> as a placeholder for
                    the randomly-selected reason.
                </span>
            </label>

            <label>
                Reasons (one per line)
                <textarea
                    rows={5}
                    value={reasonsRaw}
                    onChange={(e) => {
                        setReasonsRaw(e.target.value);
                        setSaved(false);
                    }}
                />
            </label>

            <div className="settings-actions-secondary">
                <button type="button" onClick={resetDefaults} disabled={saving}>
                    Reset to defaults
                </button>
            </div>

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
