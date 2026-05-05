import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Layout, type Mode, type Tag } from "./api";
import LayoutPreviewModal from "./LayoutPreviewModal";
import SnapSlider from "./SnapSlider";
import ViewingPreview from "./ViewingPreview";

// Per-profile time-based modes. Each mode has a day-of-week + clock
// schedule and can override tag filters / time limits / viewing
// controls during its window. One mode active at a time;
// alphabetical name wins on overlap.
//
// Editor opens as a modal. Modes list is card-style, not a tight row
// with edit/delete buttons floating off the right edge.

type Props = {
    profileId: number;
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const THEMES = ["default", "bedtime", "morning", "focus"];

type ViewingOverride = {
    dimPercent?: number;
    warmTintPercent?: number;
};

function parseViewing(json?: string): ViewingOverride {
    if (!json) return {};
    try {
        const parsed = JSON.parse(json);
        return {
            dimPercent: typeof parsed.dimPercent === "number" ? parsed.dimPercent : undefined,
            warmTintPercent:
                typeof parsed.warmTintPercent === "number" ? parsed.warmTintPercent : undefined,
        };
    } catch {
        return {};
    }
}

function serializeViewing(v: ViewingOverride): string | undefined {
    const out: ViewingOverride = {};
    if (v.dimPercent && v.dimPercent > 0) out.dimPercent = v.dimPercent;
    if (v.warmTintPercent && v.warmTintPercent > 0)
        out.warmTintPercent = v.warmTintPercent;
    if (Object.keys(out).length === 0) return undefined;
    return JSON.stringify(out);
}

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

    return (
        <div className="settings-form">
            <p className="muted">
                Modes override tag filters, time limits, and viewing
                effects (dim + warm tint) during a scheduled window. One
                mode is active at a time; the alphabetically earlier
                name wins on overlap.
            </p>
            {error && <p className="error">{error}</p>}
            {modes === null ? (
                <p>Loading...</p>
            ) : modes.length === 0 ? (
                <p className="muted">
                    No modes yet. Add one (e.g. a "Bedtime" mode that
                    warm-tints the screen and locks Continue Watching to
                    a sleepy-time layout).
                </p>
            ) : (
                <ul className="modes-cards">
                    {modes.map((m) => {
                        const layoutName = layouts.find(
                            (l) => l.id === m.layoutId,
                        )?.name;
                        const viewing = parseViewing(m.viewingControlsJson);
                        const summaryParts = [
                            scheduleSummary(m),
                            `theme ${m.themeKey}`,
                        ];
                        if (layoutName) summaryParts.push(`layout ${layoutName}`);
                        if (viewing.dimPercent)
                            summaryParts.push(`dim ${viewing.dimPercent}%`);
                        if (viewing.warmTintPercent)
                            summaryParts.push(`warm ${viewing.warmTintPercent}%`);
                        return (
                            <li key={m.id} className="modes-card">
                                <div className="modes-card-head">
                                    <strong>{m.name}</strong>
                                    <div className="modes-card-actions">
                                        <button
                                            type="button"
                                            onClick={() => setEditing(m)}
                                        >
                                            Edit
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => remove(m)}
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </div>
                                <div className="muted modes-card-summary">
                                    {summaryParts.join(" · ")}
                                </div>
                            </li>
                        );
                    })}
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
            {editing && (
                <ModeEditorModal
                    profileId={profileId}
                    tags={tags}
                    layouts={layouts}
                    mode={editing}
                    onClose={() => setEditing(null)}
                    onSaved={async () => {
                        setEditing(null);
                        await refresh();
                    }}
                />
            )}
        </div>
    );
}

type EditorProps = {
    profileId: number;
    tags: Tag[];
    layouts: Layout[];
    mode: Mode;
    onClose: () => void;
    onSaved: () => void;
};

function ModeEditorModal({
    profileId,
    tags,
    layouts,
    mode,
    onClose,
    onSaved,
}: EditorProps) {
    const [m, setM] = useState<Mode>(mode);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [previewLayoutId, setPreviewLayoutId] = useState<number | null>(null);

    const viewing = useMemo(
        () => parseViewing(m.viewingControlsJson),
        [m.viewingControlsJson],
    );

    function set<K extends keyof Mode>(key: K, v: Mode[K]) {
        setM((x) => ({ ...x, [key]: v }));
    }

    function setViewing(patch: Partial<ViewingOverride>) {
        const next = { ...viewing, ...patch };
        set("viewingControlsJson", serializeViewing(next));
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

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape" && !saving) onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose, saving]);

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
        <div className="modal-backdrop" onClick={() => !saving && onClose()}>
            <div
                className="modal mode-editor-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
            >
                <h2>{m.id === 0 ? "New mode" : `Edit "${mode.name}"`}</h2>

                <div className="settings-form">
                    <label>
                        Name
                        <input
                            type="text"
                            value={m.name}
                            onChange={(e) => set("name", e.target.value)}
                            autoFocus
                        />
                    </label>
                    <fieldset className="pill-fieldset">
                        <legend>Days active</legend>
                        <div className="pill-toggle-row">
                            {DAYS.map((d, i) => {
                                const on = (m.scheduleDays & (1 << i)) !== 0;
                                return (
                                    <button
                                        key={d}
                                        type="button"
                                        className={`pill-toggle ${on ? "active" : ""}`}
                                        aria-pressed={on}
                                        onClick={() => toggleDay(i)}
                                    >
                                        {d}
                                    </button>
                                );
                            })}
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
                        <div className="settings-input-row">
                            <select
                                value={m.layoutId ?? 0}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    set("layoutId", v > 0 ? v : null);
                                }}
                            >
                                <option value={0}>
                                    Use the profile's default layout
                                </option>
                                {layouts.map((l) => (
                                    <option key={l.id} value={l.id}>
                                        {l.name}
                                        {l.isDefault ? " (default)" : ""}
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                onClick={() => m.layoutId && setPreviewLayoutId(m.layoutId)}
                                disabled={!m.layoutId}
                            >
                                Preview
                            </button>
                            {m.layoutId ? (
                                <Link
                                    to={`/layouts/${m.layoutId}`}
                                    className="button-link"
                                >
                                    Edit
                                </Link>
                            ) : null}
                        </div>
                        <span className="help">
                            Use a stripped-down layout (e.g. Continue Watching only)
                            while the mode is active. Leave on the default to keep
                            the kid's normal browse screen.
                        </span>
                    </label>

                    <h3 className="settings-subhead">Screen effects</h3>
                    <p className="help">
                        Applied to the kid client's display while this mode
                        is active. Leave at 0 for no change.
                    </p>
                    <ViewingPreview
                        dimPercent={viewing.dimPercent ?? 0}
                        redShiftPercent={viewing.warmTintPercent ?? 0}
                    />
                    <SnapSlider
                        label="Dim (darker, 0-80%)"
                        value={viewing.dimPercent ?? 0}
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
                        onChange={(v) => setViewing({ dimPercent: v })}
                    />
                    <SnapSlider
                        label="Warm tint (cooler ↔ warmer)"
                        value={viewing.warmTintPercent ?? 0}
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
                        onChange={(v) => setViewing({ warmTintPercent: v })}
                    />

                    <fieldset className="pill-fieldset">
                        <legend>
                            Required tags ({(m.requiredTagIds ?? []).length} selected)
                        </legend>
                        {tags.length === 0 ? (
                            <p className="muted">
                                No tags defined yet. Items would be unrestricted on
                                the tag axis. Create tags in the Tags page first.
                            </p>
                        ) : (
                            <div className="pill-toggle-row pill-toggle-wrap">
                                {tags.map((t) => {
                                    const on = (m.requiredTagIds ?? []).includes(t.id);
                                    return (
                                        <button
                                            key={t.id}
                                            type="button"
                                            className={`pill-toggle ${on ? "active" : ""}`}
                                            aria-pressed={on}
                                            onClick={() => toggleRequiredTag(t.id)}
                                        >
                                            {t.name}
                                        </button>
                                    );
                                })}
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
                </div>

                {error && <p className="error">{error}</p>}
                <div className="modal-actions">
                    <button onClick={onClose} disabled={saving}>
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
            {previewLayoutId && (
                <LayoutPreviewModal
                    layoutId={previewLayoutId}
                    onClose={() => setPreviewLayoutId(null)}
                />
            )}
        </div>
    );
}

function scheduleSummary(m: Mode): string {
    const days = DAYS.filter((_, i) => (m.scheduleDays & (1 << i)) !== 0);
    if (days.length === 0) return "(no days selected)";
    if (days.length === 7) return `daily ${m.scheduleStartTime}-${m.scheduleEndTime}`;
    return `${days.join(",")} ${m.scheduleStartTime}-${m.scheduleEndTime}`;
}
