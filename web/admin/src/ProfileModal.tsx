import { useEffect, useState } from "react";
import { api, HttpError, type Profile } from "./api";

type Props = {
    mode: "create" | "edit";
    profile?: Profile; // required when mode === "edit"
    existingProfiles: Profile[]; // for the "initialize from" picker on create
    onSaved: () => void;
    onClose: () => void;
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

// ProfileModal handles create and edit in one component. Create mode adds
// an "Initialize from" picker so a new profile can copy categorizations
// from an existing one (typical: starting a younger sibling's profile
// from the older sibling's decisions).

export default function ProfileModal({
    mode,
    profile,
    existingProfiles,
    onSaved,
    onClose,
}: Props) {
    const [name, setName] = useState(profile?.name ?? "");
    const [description, setDescription] = useState(profile?.description ?? "");
    const [defaultLanguage, setDefaultLanguage] = useState(profile?.defaultLanguage ?? "eng");
    const [baseProfileId, setBaseProfileId] = useState<number>(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape" && !busy) onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const payload = {
                name: name.trim(),
                description: description.trim(),
                defaultLanguage,
                ...(mode === "create" && baseProfileId > 0
                    ? { baseProfileId }
                    : {}),
            };
            if (mode === "create") {
                await api.createProfile(payload);
            } else if (profile) {
                await api.updateProfile(profile.id, payload);
            }
            onSaved();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="modal-backdrop" onClick={() => !busy && onClose()}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>{mode === "create" ? "Add profile" : `Edit ${profile?.name}`}</h2>
                <form className="modal-form" onSubmit={submit}>
                    <label>
                        Name
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            autoFocus
                        />
                    </label>
                    <label>
                        Description
                        <input
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Optional"
                        />
                    </label>
                    <label>
                        Default audio language
                        <select
                            value={defaultLanguage}
                            onChange={(e) => setDefaultLanguage(e.target.value)}
                        >
                            {LANGUAGE_OPTIONS.map((l) => (
                                <option key={l.code} value={l.code}>
                                    {l.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    {mode === "create" && existingProfiles.length > 0 && (
                        <label>
                            Initialize from
                            <select
                                value={baseProfileId}
                                onChange={(e) => setBaseProfileId(Number(e.target.value))}
                            >
                                <option value={0}>Blank (no copied decisions)</option>
                                {existingProfiles.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                    </option>
                                ))}
                            </select>
                            <span className="modal-hint">
                                Copies every visible / hidden decision from the chosen profile.
                                Tweak from there.
                            </span>
                        </label>
                    )}

                    {error && <div className="error">{error}</div>}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="submit" disabled={busy}>
                            {busy ? "Saving..." : mode === "create" ? "Create" : "Save"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
