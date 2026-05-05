import { useEffect, useState } from "react";
import { api, HttpError, type Mode, type Profile } from "./api";

// M13 #86: per-profile modes management. List + create + edit +
// delete. Schedule = day-of-week bitmask + start/end clock time.

type Props = {
    profile: Profile;
    onClose: () => void;
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const THEMES = ["default", "bedtime", "morning", "focus"];

export default function ProfileModesModal({ profile, onClose }: Props) {
    const [modes, setModes] = useState<Mode[] | null>(null);
    const [editing, setEditing] = useState<Mode | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function refresh() {
        try {
            const got = await api.listProfileModes(profile.id);
            setModes(got.modes);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }
    useEffect(() => {
        void refresh();
    }, [profile.id]);

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
                profileId={profile.id}
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
        <Modal onClose={onClose} title={`Modes - ${profile.name}`}>
            <div className="modal-form">
                <p className="muted">
                    Time-based modes override M6 tag filters / M10 time
                    limits / M12 viewing controls during a scheduled
                    window. One mode active at a time; alphabetical name
                    wins on overlap.
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
                <div className="modal-actions">
                    <button onClick={onClose}>Close</button>
                    <button
                        className="primary"
                        onClick={() =>
                            setEditing({
                                id: 0,
                                profileId: profile.id,
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
        </Modal>
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
        set("scheduleDays", (m.scheduleDays ^ bit) as Mode["scheduleDays"]);
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
        <Modal onClose={onCancel} title={m.id === 0 ? "Add mode" : `Edit mode - ${mode.name}`}>
            <div className="modal-form">
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
                    {DAYS.map((d, i) => (
                        <label key={d} className="checkbox">
                            <input
                                type="checkbox"
                                checked={(m.scheduleDays & (1 << i)) !== 0}
                                onChange={() => toggleDay(i)}
                            />
                            {d}
                        </label>
                    ))}
                </fieldset>
                <label>
                    Start time (HH:MM 24h)
                    <input
                        type="text"
                        value={m.scheduleStartTime}
                        onChange={(e) => set("scheduleStartTime", e.target.value)}
                    />
                </label>
                <label>
                    End time (HH:MM 24h, end &lt; start wraps midnight)
                    <input
                        type="text"
                        value={m.scheduleEndTime}
                        onChange={(e) => set("scheduleEndTime", e.target.value)}
                    />
                </label>
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
                <div className="modal-actions">
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
        </Modal>
    );
}

function scheduleSummary(m: Mode): string {
    const days = DAYS.filter((_, i) => (m.scheduleDays & (1 << i)) !== 0);
    if (days.length === 0) return "(no days selected)";
    if (days.length === 7) return `daily ${m.scheduleStartTime}-${m.scheduleEndTime}`;
    return `${days.join(",")} ${m.scheduleStartTime}-${m.scheduleEndTime}`;
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
