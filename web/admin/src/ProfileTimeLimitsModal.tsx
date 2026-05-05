import { useEffect, useState } from "react";
import { api, HttpError, type Profile, type ProfileTimeLimits } from "./api";

// M10 #67: per-profile time-limits config. Surfaced via a "Time
// limits" button on the Profiles page.

type Props = {
    profile: Profile;
    onClose: () => void;
};

const REFILL_OPTIONS = [
    { value: 1, label: "Every hour" },
    { value: 4, label: "Every 4 hours" },
    { value: 12, label: "Twice a day (every 12h)" },
    { value: 24, label: "Once a day" },
];

export default function ProfileTimeLimitsModal({ profile, onClose }: Props) {
    const [limits, setLimits] = useState<ProfileTimeLimits | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const got = await api.getProfileTimeLimits(profile.id);
                if (!cancelled) setLimits(got);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [profile.id]);

    if (!limits) {
        return (
            <Modal onClose={onClose} title={`Time limits - ${profile.name}`}>
                {error ? <p className="error">{error}</p> : <p>Loading...</p>}
            </Modal>
        );
    }

    function set<K extends keyof ProfileTimeLimits>(key: K, v: ProfileTimeLimits[K]) {
        setLimits((l) => (l ? { ...l, [key]: v } : l));
    }

    async function save() {
        if (!limits) return;
        setSaving(true);
        setError(null);
        try {
            await api.setProfileTimeLimits(profile.id, limits);
            onClose();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    // Live preview: show the next four refills assuming today.
    const previewLines = previewRefills(limits);

    return (
        <Modal onClose={onClose} title={`Time limits - ${profile.name}`}>
            <div className="modal-form">
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={limits.enabled}
                        onChange={(e) => set("enabled", e.target.checked)}
                    />
                    Enable time limits for this profile
                </label>
                <p className="muted">
                    When disabled, the kid can watch as much as they want;
                    locked tile rendering + warnings are skipped.
                </p>

                <label>
                    Daily cap (minutes)
                    <input
                        type="number"
                        min={30}
                        max={1440}
                        step={30}
                        value={limits.dailyCapMinutes}
                        onChange={(e) =>
                            set("dailyCapMinutes", Number(e.target.value))
                        }
                    />
                </label>

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

                {previewLines.length > 0 && (
                    <div className="time-limits-preview">
                        <h4>Refill preview</h4>
                        <ul>
                            {previewLines.map((line, i) => (
                                <li key={i}>{line}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {error && <p className="error">{error}</p>}

                <div className="modal-actions">
                    <button onClick={onClose} disabled={saving}>
                        Cancel
                    </button>
                    <button onClick={save} disabled={saving} className="primary">
                        {saving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

type ModalProps = {
    onClose: () => void;
    title: string;
    children: React.ReactNode;
};

function Modal({ onClose, title, children }: ModalProps) {
    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>{title}</h3>
                    <button className="modal-close" onClick={onClose}>
                        ×
                    </button>
                </div>
                {children}
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

function previewRefills(l: ProfileTimeLimits): string[] {
    if (!l.enabled) return [];
    const refillsPerDay = 24 / l.refillIntervalHours;
    const stepMin = Math.round(l.dailyCapMinutes / refillsPerDay);
    const out: string[] = [];
    for (let i = 0; i < Math.min(refillsPerDay, 6); i++) {
        const hour = (l.dayStartHour + i * l.refillIntervalHours) % 24;
        out.push(`${formatHour(hour)}: +${stepMin} min`);
    }
    if (refillsPerDay > 6) {
        out.push(`...continues every ${l.refillIntervalHours}h until ${formatHour(l.dayStartHour)}`);
    }
    return out;
}
