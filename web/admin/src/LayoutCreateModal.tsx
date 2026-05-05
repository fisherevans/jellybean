import { useEffect, useState } from "react";
import { api, HttpError } from "./api";

type Props = {
    onSaved: () => void;
    onClose: () => void;
};

// Small modal for "+ New layout" - just name + optional description.
// The detail editor (/layouts/:id) handles row management.
export default function LayoutCreateModal({ onSaved, onClose }: Props) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
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
            await api.createLayout({
                name: name.trim(),
                description: description.trim(),
            });
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
                <h2>New layout</h2>
                <form className="modal-form" onSubmit={submit}>
                    <label>
                        Name
                        <input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            autoFocus
                            required
                            disabled={busy}
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
                    {error && <div className="error">{error}</div>}
                    <div className="modal-actions">
                        <button type="button" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="submit" disabled={busy}>
                            {busy ? "Creating…" : "Create"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
