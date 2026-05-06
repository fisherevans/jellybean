import { useEffect, useState } from "react";
import { api, HttpError, type Tag } from "./api";
import IconPicker from "./IconPicker";
import { isTagIconName, type TagIconName } from "./tagIcons";

type Props = {
    mode: "create" | "edit";
    tag?: Tag; // required when mode === "edit"
    onSaved: () => void;
    onClose: () => void;
};

// TagModal handles create + rename + icon assignment in one component.
// Mirrors ProfileModal's structure so the admin app stays uniform.
export default function TagModal({ mode, tag, onSaved, onClose }: Props) {
    const [name, setName] = useState(tag?.name ?? "");
    const [description, setDescription] = useState(tag?.description ?? "");
    const [icon, setIcon] = useState<string>(
        tag?.icon && isTagIconName(tag.icon) ? tag.icon : "",
    );
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
                // Always send icon (including empty string) so PATCH can
                // CLEAR an existing icon, not just leave it unset.
                icon: icon,
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
                <form className="modal-form" onSubmit={submit}>
                    <label>
                        Name
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
                    <label>
                        Description
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            disabled={busy}
                            rows={3}
                            placeholder="Optional"
                        />
                    </label>

                    <IconPicker
                        value={icon}
                        onChange={setIcon}
                        disabled={busy}
                    />

                    {error && <div className="error">{error}</div>}

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

// Re-export the type so this module is the canonical reference for
// TagIconName when consumed elsewhere in the admin app.
export type { TagIconName };
