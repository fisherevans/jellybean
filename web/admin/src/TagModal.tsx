import { useEffect, useState } from "react";
import { api, HttpError, type Tag } from "./api";

type Props = {
    mode: "create" | "edit";
    tag?: Tag; // required when mode === "edit"
    onSaved: () => void;
    onClose: () => void;
};

// TagModal handles create + rename in one component. Mirrors
// ProfileModal's structure so the admin app stays uniform.
export default function TagModal({ mode, tag, onSaved, onClose }: Props) {
    const [name, setName] = useState(tag?.name ?? "");
    const [description, setDescription] = useState(tag?.description ?? "");
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
            };
            if (!payload.name) {
                throw new Error("Name is required");
            }
            if (mode === "create") {
                await api.createTag(payload);
            } else if (tag) {
                await api.updateTag(tag.id, payload);
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
                <h2>{mode === "create" ? "New tag" : `Rename "${tag?.name}"`}</h2>
                {error && <div className="error">{error}</div>}
                <form onSubmit={submit}>
                    <label className="field">
                        <span>Name</span>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                            required
                            disabled={busy}
                            placeholder="e.g. Adventure, Bedtime, Scary"
                        />
                    </label>
                    <label className="field">
                        <span>Description (optional)</span>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            disabled={busy}
                            rows={3}
                            placeholder="What kind of content this tag covers"
                        />
                    </label>
                    <div className="modal-actions">
                        <button type="button" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="submit" disabled={busy}>
                            {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
