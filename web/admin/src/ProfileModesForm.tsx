import { useEffect, useState } from "react";
import { api, HttpError, type Layout, type Mode, type Tag } from "./api";

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
    const [tags, setTags] = useState<Tag[]>([]);
    const [layouts, setLayouts] = useState<Layout[]>([]);
    const [editing, setEditing] = useState<Mode | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function refresh() {
        try {
            const [modesRes, tagsRes, layoutsRes] = await Promise.all([
                api.listProfileModes(profileId),
                api.listTags({ sort: "name" }),
                api.listLayouts(),
            ]);
            setModes(modesRes.modes);
            setTags(tagsRes.tags);
            setLayouts(layoutsRes.layouts);
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
                tags={tags}
                layouts={layouts}
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
                            requiredTagIds: [],
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
    tags: Tag[];
    layouts: Layout[];
    mode: Mode;
    onCancel: () => void;
    onSaved: () => void;
};

function ModeEditor({
    profileId,
    tags,
    layouts,
    mode,
    onCancel,
    onSaved,
}: EditorProps) {
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

    function toggleRequiredTag(id: number) {
        const cur = m.requiredTagIds ?? [];
        const has = cur.includes(id);
        set("requiredTagIds", has ? cur.filter((t) => t !== id) : [...cur, id]);
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
                Layout while this mode is active
                <select
                    value={m.layoutId ?? 0}
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        set("layoutId", v > 0 ? v : null);
                    }}
                >
                    <option value={0}>Use the profile's default layout</option>
                    {layouts.map((l) => (
                        <option key={l.id} value={l.id}>
                            {l.name}
                            {l.isDefault ? " (default)" : ""}
                        </option>
                    ))}
                </select>
                <span className="help">
                    Use a stripped-down layout (e.g. Continue Watching only)
                    while the mode is active. Leave on the default to keep
                    the kid's normal browse screen.
                </span>
            </label>
            <fieldset className="day-toggles">
                <legend>
                    Required tags ({(m.requiredTagIds ?? []).length} selected)
                </legend>
                {tags.length === 0 ? (
                    <p className="muted">
                        No tags defined yet. Items would be unrestricted on
                        the tag axis. Create tags in the Tags page first.
                    </p>
                ) : (
                    <div className="day-toggles-grid wide">
                        {tags.map((t) => (
                            <label key={t.id} className="day-toggle">
                                <input
                                    type="checkbox"
                                    checked={(m.requiredTagIds ?? []).includes(t.id)}
                                    onChange={() => toggleRequiredTag(t.id)}
                                />
                                <span>{t.name}</span>
                            </label>
                        ))}
                    </div>
                )}
                <p className="help">
                    When set, only items that carry at least one of these
                    tags will be visible during the mode. Leave empty to
                    skip the extra tag filter.
                </p>
            </fieldset>
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
