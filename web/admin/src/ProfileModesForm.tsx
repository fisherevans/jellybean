import { useEffect, useState } from "react";
import { api, HttpError, type Mode } from "./api";

// Per-profile time-based modes. Each mode has a day-of-week + clock
// schedule and can override tag filters / time limits / viewing
// controls during its window. One mode active at a time;
// alphabetical name wins on overlap.

type Props = {
    profileId: number;
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const THEMES = ["default", "bedtime", "morning", "focus"];

export default function ProfileModesForm({ profileId }: Props) {
    const [modes, setModes] = useState<Mode[] | null>(null);
    const [editing, setEditing] = useState<Mode | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function refresh() {
        try {
            const got = await api.listProfileModes(profileId);
            setModes(got.modes);
            setError(null);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }
    useEffect(() => {
        void refresh();
    }, [profileId]);

    async function remove(m: Mode) {
        if (!confirm(`Delete mode "${m.name}"?`)) return;
        try {
            await api.deleteMode(m.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    if (editing) {
        return (
            <ModeEditor
                profileId={profileId}
                mode={editing}
                onCancel={() => setEditing(null)}
                onSaved={async () => {
                    setEditing(null);
                    await refresh();
                }}
            />
        );
    }

    return (
        <div className="settings-form">
            <p className="muted">
                Modes override tag filters, time limits, and viewing
                controls during a scheduled window. One mode is active
                at a time. When two modes overlap, the alphabetically
                earlier name wins.
            </p>
            {error && <p className="error">{error}</p>}
            {modes === null ? (
                <p>Loading...</p>
            ) : modes.length === 0 ? (
                <p className="muted">No modes yet.</p>
            ) : (
                <ul className="modes-list">
                    {modes.map((m) => (
                        <li key={m.id} className="modes-list-row">
                            <div>
                                <strong>{m.name}</strong>
                                <div className="muted">
                                    {scheduleSummary(m)} - theme {m.themeKey}
                                </div>
                            </div>
                            <div>
                                <button onClick={() => setEditing(m)}>Edit</button>
                                <button onClick={() => remove(m)}>Delete</button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            <div className="settings-actions">
                <button
                    className="primary"
                    onClick={() =>
                        setEditing({
                            id: 0,
                            profileId,
                            name: "",
                            scheduleDays: 0b1111111,
                            scheduleStartTime: "20:00",
                            scheduleEndTime: "06:00",
                            tagFiltersJson: "[]",
                            themeKey: "default",
                        })
                    }
                >
                    + Add mode
                </button>
            </div>
        </div>
    );
}

type EditorProps = {
    profileId: number;
    mode: Mode;
    onCancel: () => void;
    onSaved: () => void;
};

function ModeEditor({ profileId, mode, onCancel, onSaved }: EditorProps) {
    const [m, setM] = useState<Mode>(mode);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    function set<K extends keyof Mode>(key: K, v: Mode[K]) {
        setM((x) => ({ ...x, [key]: v }));
    }

    function toggleDay(idx: number) {
        const bit = 1 << idx;
        set("scheduleDays", m.scheduleDays ^ bit);
    }

    async function save() {
        if (!m.name) {
            setError("Name is required");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            if (m.id === 0) {
                await api.createMode(profileId, m);
            } else {
                await api.updateMode(m.id, m);
            }
            onSaved();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="settings-form">
            <h3 className="settings-subhead">
                {m.id === 0 ? "New mode" : `Editing "${mode.name}"`}
            </h3>
            <label>
                Name
                <input
                    type="text"
                    value={m.name}
                    onChange={(e) => set("name", e.target.value)}
                />
            </label>
            <fieldset className="day-toggles">
                <legend>Days</legend>
                <div className="day-toggles-grid">
                    {DAYS.map((d, i) => (
                        <label key={d} className="day-toggle">
                            <input
                                type="checkbox"
                                checked={(m.scheduleDays & (1 << i)) !== 0}
                                onChange={() => toggleDay(i)}
                            />
                            <span>{d}</span>
                        </label>
                    ))}
                </div>
            </fieldset>
            <div className="settings-row">
                <label>
                    Start time
                    <input
                        type="time"
                        value={m.scheduleStartTime}
                        onChange={(e) => set("scheduleStartTime", e.target.value)}
                    />
                </label>
                <label>
                    End time
                    <input
                        type="time"
                        value={m.scheduleEndTime}
                        onChange={(e) => set("scheduleEndTime", e.target.value)}
                    />
                </label>
            </div>
            <p className="help">
                When the end time is earlier than the start time, the
                window wraps midnight (useful for bedtime modes).
            </p>
            <label>
                Theme
                <select
                    value={m.themeKey}
                    onChange={(e) => set("themeKey", e.target.value)}
                >
                    {THEMES.map((t) => (
                        <option key={t} value={t}>
                            {t}
                        </option>
                    ))}
                </select>
            </label>
            <label>
                Enter voice message (optional)
                <input
                    type="text"
                    value={m.enterVoiceMessage ?? ""}
                    onChange={(e) =>
                        set("enterVoiceMessage", e.target.value)
                    }
                />
            </label>
            <label>
                Exit voice message (optional)
                <input
                    type="text"
                    value={m.exitVoiceMessage ?? ""}
                    onChange={(e) =>
                        set("exitVoiceMessage", e.target.value)
                    }
                />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="settings-actions">
                <button onClick={onCancel} disabled={saving}>
                    Cancel
                </button>
                <button
                    onClick={save}
                    className="primary"
                    disabled={saving}
                >
                    {saving ? "Saving..." : "Save"}
                </button>
            </div>
        </div>
    );
}

function scheduleSummary(m: Mode): string {
    const days = DAYS.filter((_, i) => (m.scheduleDays & (1 << i)) !== 0);
    if (days.length === 0) return "(no days selected)";
    if (days.length === 7) return `daily ${m.scheduleStartTime}-${m.scheduleEndTime}`;
    return `${days.join(",")} ${m.scheduleStartTime}-${m.scheduleEndTime}`;
}
