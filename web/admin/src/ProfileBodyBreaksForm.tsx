import { useEffect, useState } from "react";
import { api, HttpError, type ProfileBodyBreaks } from "./api";

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

            <label className="checkbox">
                <input
                    type="checkbox"
                    checked={cfg.enabled}
                    onChange={(e) => set("enabled", e.target.checked)}
                />
                Enable body breaks for this profile
            </label>

            <label>
                Play before break (minutes)
                <input
                    type="number"
                    min={1}
                    max={240}
                    value={cfg.playMinutes}
                    onChange={(e) => set("playMinutes", Number(e.target.value))}
                />
            </label>

            <label>
                Break duration (minutes)
                <input
                    type="number"
                    min={1}
                    max={60}
                    value={cfg.breakMinutes}
                    onChange={(e) => set("breakMinutes", Number(e.target.value))}
                />
            </label>

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
