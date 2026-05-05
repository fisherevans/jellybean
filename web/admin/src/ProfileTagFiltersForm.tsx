import { useCallback, useEffect, useMemo, useState } from "react";
import {
    api,
    HttpError,
    type Profile,
    type ProfileFilterMode,
    type Tag,
} from "./api";
import Spinner from "./Spinner";

// Per-tag filter rules for a profile. Three modes per row:
// none | always show | always hide. always_hidden wins on conflict.

type Props = {
    profile: Profile;
};

type ModeChoice = "none" | ProfileFilterMode;

export default function ProfileTagFiltersForm({ profile }: Props) {
    const [tags, setTags] = useState<Tag[] | null>(null);
    const [modes, setModes] = useState<Map<number, ModeChoice>>(new Map());
    const [initialModes, setInitialModes] = useState<Map<number, ModeChoice>>(
        new Map(),
    );
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const [tagRes, filterRes] = await Promise.all([
                api.listTags({ sort: "name" }),
                api.listProfileTagFilters(profile.id),
            ]);
            setTags(tagRes.tags);
            const m = new Map<number, ModeChoice>();
            for (const t of tagRes.tags) m.set(t.id, "none");
            for (const f of filterRes.filters) m.set(f.tagId, f.mode);
            setModes(new Map(m));
            setInitialModes(new Map(m));
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [profile.id]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const dirty = useMemo(() => {
        if (modes.size !== initialModes.size) return true;
        for (const [k, v] of modes) {
            if (initialModes.get(k) !== v) return true;
        }
        return false;
    }, [modes, initialModes]);

    function setMode(tagId: number, choice: ModeChoice) {
        const next = new Map(modes);
        next.set(tagId, choice);
        setModes(next);
        setSaved(false);
    }

    async function save() {
        if (!tags) return;
        setError(null);
        setBusy(true);
        try {
            const filters: { tagId: number; mode: ProfileFilterMode }[] = [];
            for (const [tagId, choice] of modes) {
                if (choice === "none") continue;
                filters.push({ tagId, mode: choice });
            }
            await api.setProfileTagFilters(profile.id, filters);
            await refresh();
            setSaved(true);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="settings-form">
            <p className="muted">
                Tag rules override per-profile categorization for items
                carrying the tag. <strong>Always hide</strong> wins
                over <strong>always show</strong> when both apply.
            </p>
            {error && <div className="error">{error}</div>}
            {tags === null ? (
                <Spinner block size={28} label="Loading tags..." />
            ) : tags.length === 0 ? (
                <p className="muted">
                    No tags yet. Create some in the Tags page.
                </p>
            ) : (
                <ul className="tag-filter-list">
                    {tags.map((t) => {
                        const choice = modes.get(t.id) ?? "none";
                        return (
                            <li key={t.id} className="tag-filter-row">
                                <div className="tag-filter-name">
                                    {t.name}
                                    {t.description ? (
                                        <div className="muted tag-filter-desc">
                                            {t.description}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="tag-filter-modes">
                                    <ModeRadio
                                        tagId={t.id}
                                        value="none"
                                        current={choice}
                                        onChange={setMode}
                                        label="None"
                                    />
                                    <ModeRadio
                                        tagId={t.id}
                                        value="always_visible"
                                        current={choice}
                                        onChange={setMode}
                                        label="Always show"
                                    />
                                    <ModeRadio
                                        tagId={t.id}
                                        value="always_hidden"
                                        current={choice}
                                        onChange={setMode}
                                        label="Always hide"
                                    />
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            {saved && !error && <p className="muted">Saved.</p>}
            <div className="settings-actions">
                <button
                    type="button"
                    onClick={save}
                    disabled={busy || !dirty || !tags}
                    className="primary"
                >
                    {busy ? "Saving..." : "Save"}
                </button>
            </div>
        </div>
    );
}

type ModeRadioProps = {
    tagId: number;
    value: ModeChoice;
    current: ModeChoice;
    onChange: (tagId: number, value: ModeChoice) => void;
    label: string;
};

function ModeRadio({ tagId, value, current, onChange, label }: ModeRadioProps) {
    return (
        <label className="tag-filter-mode">
            <input
                type="radio"
                name={`tag-filter-${tagId}`}
                value={value}
                checked={current === value}
                onChange={() => onChange(tagId, value)}
            />
            <span>{label}</span>
        </label>
    );
}
