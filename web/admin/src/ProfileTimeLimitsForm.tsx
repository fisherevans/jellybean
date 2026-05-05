import { useEffect, useState } from "react";
import { api, HttpError, type ProfileTimeLimits } from "./api";
import SnapSlider from "./SnapSlider";
import ToggleSwitch from "./ToggleSwitch";

// Per-profile time-limits config. Daily cap + refill cadence + day
// start anchor + optional per-show / per-movie defaults.

type Props = {
    profileId: number;
};

const REFILL_OPTIONS = [
    { value: 1, label: "Every hour" },
    { value: 4, label: "Every 4 hours" },
    { value: 12, label: "Twice a day (every 12h)" },
    { value: 24, label: "Once a day" },
];

export default function ProfileTimeLimitsForm({ profileId }: Props) {
    const [limits, setLimits] = useState<ProfileTimeLimits | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const got = await api.getProfileTimeLimits(profileId);
                if (!cancelled) setLimits(got);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [profileId]);

    if (!limits) {
        return error ? <p className="error">{error}</p> : <p>Loading...</p>;
    }

    function set<K extends keyof ProfileTimeLimits>(key: K, v: ProfileTimeLimits[K]) {
        setLimits((l) => (l ? { ...l, [key]: v } : l));
        setSaved(false);
    }

    async function save() {
        if (!limits) return;
        setSaving(true);
        setError(null);
        try {
            await api.setProfileTimeLimits(profileId, limits);
            setSaved(true);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    const previewLines = previewRefills(limits);

    return (
        <div className="settings-form">
            <p className="muted">
                Daily watch budget that refills throughout the day.
                When a kid runs out, tiles lock and playback stops
                until the next refill (or until you grant time via
                the override modal on the TV).
            </p>

            <ToggleSwitch
                label="Enable time limits for this profile"
                description="Disable to let the kid watch without restriction."
                checked={limits.enabled}
                onChange={(v) => set("enabled", v)}
            />

            <SnapSlider
                label="Daily cap"
                value={limits.dailyCapMinutes}
                min={30}
                max={1440}
                step={5}
                suffix="min"
                snaps={[
                    { value: 30, label: "30m" },
                    { value: 60, label: "1h" },
                    { value: 120, label: "2h" },
                    { value: 180, label: "3h" },
                    { value: 240, label: "4h" },
                    { value: 480, label: "8h" },
                ]}
                onChange={(v) => set("dailyCapMinutes", v)}
            />

            <div className="settings-row">
                <label>
                    Refill interval
                    <select
                        value={limits.refillIntervalHours}
                        onChange={(e) =>
                            set("refillIntervalHours", Number(e.target.value))
                        }
                    >
                        {REFILL_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Day starts at
                    <select
                        value={limits.dayStartHour}
                        onChange={(e) =>
                            set("dayStartHour", Number(e.target.value))
                        }
                    >
                        {Array.from({ length: 24 }, (_, h) => (
                            <option key={h} value={h}>
                                {formatHour(h)}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            <div className="settings-row">
                <label>
                    Per-show daily cap (minutes, optional)
                    <input
                        type="number"
                        min={1}
                        max={1440}
                        value={limits.defaultShowCapMinutes ?? ""}
                        placeholder="leave blank to disable"
                        onChange={(e) =>
                            set(
                                "defaultShowCapMinutes",
                                e.target.value === "" ? null : Number(e.target.value),
                            )
                        }
                    />
                </label>
                <label>
                    Per-movie daily starts (optional)
                    <input
                        type="number"
                        min={1}
                        max={20}
                        value={limits.defaultMovieStarts ?? ""}
                        placeholder="leave blank to disable"
                        onChange={(e) =>
                            set(
                                "defaultMovieStarts",
                                e.target.value === "" ? null : Number(e.target.value),
                            )
                        }
                    />
                </label>
            </div>

            {previewLines.length > 0 && (
                <div className="refill-preview">
                    <h4>Refill schedule</h4>
                    <table>
                        <thead>
                            <tr>
                                <th>When</th>
                                <th>Adds</th>
                                <th>Running cap</th>
                            </tr>
                        </thead>
                        <tbody>
                            {previewLines.map((row, i) => (
                                <tr key={i}>
                                    <td>{row.when}</td>
                                    <td>+{row.added} min</td>
                                    <td>{row.running} min</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

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

function formatHour(h: number): string {
    if (h === 0) return "12:00 AM (midnight)";
    if (h < 12) return `${h}:00 AM`;
    if (h === 12) return "12:00 PM (noon)";
    return `${h - 12}:00 PM`;
}

type RefillRow = { when: string; added: number; running: number };

function previewRefills(l: ProfileTimeLimits): RefillRow[] {
    if (!l.enabled) return [];
    const refillsPerDay = 24 / l.refillIntervalHours;
    const stepMin = Math.round(l.dailyCapMinutes / refillsPerDay);
    const out: RefillRow[] = [];
    let running = 0;
    const cap = Math.min(refillsPerDay, 8);
    for (let i = 0; i < cap; i++) {
        const hour = (l.dayStartHour + i * l.refillIntervalHours) % 24;
        running = Math.min(running + stepMin, l.dailyCapMinutes);
        out.push({ when: formatHour(hour), added: stepMin, running });
    }
    return out;
}
