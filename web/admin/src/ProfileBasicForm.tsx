import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Layout, type Profile } from "./api";
import LayoutPreviewModal from "./LayoutPreviewModal";

// Basic profile metadata: name, description, default audio language,
// and the assigned browse layout. Non-destructive edits only -
// deletion happens from the profile list page.

type Props = {
    profile: Profile;
    onSaved: (next: Profile) => void;
};

const LANGUAGE_OPTIONS = [
    { code: "eng", label: "English" },
    { code: "spa", label: "Spanish" },
    { code: "fre", label: "French" },
    { code: "ger", label: "German" },
    { code: "ita", label: "Italian" },
    { code: "jpn", label: "Japanese" },
    { code: "kor", label: "Korean" },
    { code: "chi", label: "Chinese" },
    { code: "rus", label: "Russian" },
    { code: "por", label: "Portuguese" },
];

export default function ProfileBasicForm({ profile, onSaved }: Props) {
    const [name, setName] = useState(profile.name);
    const [description, setDescription] = useState(profile.description ?? "");
    const [defaultLanguage, setDefaultLanguage] = useState(
        profile.defaultLanguage ?? "eng",
    );
    const [layoutId, setLayoutId] = useState<number>(profile.layoutId ?? 0);
    const [layouts, setLayouts] = useState<Layout[]>([]);
    const [layoutPreview, setLayoutPreview] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        api.listLayouts()
            .then((res) => setLayouts(res.layouts))
            .catch((err) =>
                setError(err instanceof Error ? err.message : "load failed"),
            );
    }, []);

    async function save() {
        setError(null);
        setBusy(true);
        try {
            await api.updateProfile(profile.id, {
                name: name.trim(),
                description: description.trim(),
                defaultLanguage,
            });
            if ((profile.layoutId ?? 0) !== layoutId && layoutId > 0) {
                await api.setProfileLayout(profile.id, layoutId);
            }
            setSaved(true);
            onSaved({
                ...profile,
                name: name.trim(),
                description: description.trim(),
                defaultLanguage,
                layoutId,
            });
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="settings-form">
            <p className="muted">
                Each profile carries its own visibility decisions and
                its own configuration. The default audio language
                drives Jellyfin's stream selection when an item has
                multiple audio tracks.
            </p>

            <label>
                Name
                <input
                    type="text"
                    value={name}
                    onChange={(e) => {
                        setName(e.target.value);
                        setSaved(false);
                    }}
                />
            </label>

            <label>
                Description
                <input
                    type="text"
                    value={description}
                    onChange={(e) => {
                        setDescription(e.target.value);
                        setSaved(false);
                    }}
                    placeholder="Optional"
                />
            </label>

            <label>
                Default audio language
                <select
                    value={defaultLanguage}
                    onChange={(e) => {
                        setDefaultLanguage(e.target.value);
                        setSaved(false);
                    }}
                >
                    {LANGUAGE_OPTIONS.map((l) => (
                        <option key={l.code} value={l.code}>
                            {l.label}
                        </option>
                    ))}
                </select>
            </label>

            <label>
                Browse layout
                <div className="settings-input-row">
                    <select
                        value={layoutId}
                        onChange={(e) => {
                            setLayoutId(Number(e.target.value));
                            setSaved(false);
                        }}
                    >
                        {layouts.map((l) => (
                            <option key={l.id} value={l.id}>
                                {l.name}
                                {l.isDefault ? " (default)" : ""}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={() => layoutId > 0 && setLayoutPreview(true)}
                        disabled={layoutId <= 0}
                    >
                        Preview
                    </button>
                    {layoutId > 0 && (
                        <Link to={`/layouts/${layoutId}`} className="button-link">
                            Edit
                        </Link>
                    )}
                </div>
            </label>

            <div className="profile-stats">
                <span className="stat stat-visible">
                    {profile.visibleCount.toLocaleString()} visible
                </span>
                <span className="stat stat-hidden">
                    {profile.hiddenCount.toLocaleString()} hidden
                </span>
                <span className="stat">
                    {profile.kidCount} kid{profile.kidCount === 1 ? "" : "s"}
                </span>
            </div>

            {layoutPreview && layoutId > 0 && (
                <LayoutPreviewModal
                    layoutId={layoutId}
                    onClose={() => setLayoutPreview(false)}
                />
            )}

            {error && <div className="error">{error}</div>}
            {saved && !error && <p className="muted">Saved.</p>}

            <div className="settings-actions">
                <button onClick={save} disabled={busy} className="primary">
                    {busy ? "Saving..." : "Save"}
                </button>
            </div>
        </div>
    );
}
