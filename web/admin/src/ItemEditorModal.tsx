import { useCallback, useEffect, useMemo, useState } from "react";
import { api, HttpError, type Item, type Tag } from "./api";
import Spinner from "./Spinner";

// Modal editor for a single library item. Replaces the per-item
// route page; opens over the Browse grid (or anywhere else that
// wants to edit an item) and disposes when the user closes it.
//
// Visibility uses the same radio-row style as the per-profile tag
// rules form so the admin sees a consistent picker pattern. Tags
// use the same pill-toggle multiselect pattern used elsewhere in
// the admin.

type Props = {
    itemId: string;
    profileId: number;
    profileName: string;
    onClose: () => void;
    onSaved?: () => void;
};

type StateChoice = "unset" | "visible" | "hidden";

export default function ItemEditorModal({
    itemId,
    profileId,
    profileName,
    onClose,
    onSaved,
}: Props) {
    const [item, setItem] = useState<Item | null>(null);
    const [allTags, setAllTags] = useState<Tag[]>([]);
    const [currentTagIds, setCurrentTagIds] = useState<Set<number>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const [it, tags, all] = await Promise.all([
                api.getAdminItem(itemId, profileId),
                api.getItemTags(itemId),
                api.listTags({ sort: "name" }),
            ]);
            setItem(it);
            setCurrentTagIds(new Set(tags.tags.map((t) => t.id)));
            setAllTags(all.tags);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }, [itemId, profileId]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape" && !busy) onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);

    const stateChoice: StateChoice = useMemo(() => {
        if (!item) return "unset";
        if (item.State === "visible") return "visible";
        if (item.State === "hidden") return "hidden";
        return "unset";
    }, [item]);

    async function setState(choice: StateChoice) {
        if (!item) return;
        const target = choice === "unset" ? null : choice;
        setBusy(true);
        setError(null);
        try {
            await api.setState(item.Id, profileId, target);
            await refresh();
            onSaved?.();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function toggleTag(tagId: number, on: boolean) {
        if (!item) return;
        const next = new Set(currentTagIds);
        if (on) next.add(tagId);
        else next.delete(tagId);
        setCurrentTagIds(next);
        setBusy(true);
        setError(null);
        try {
            await api.setItemTags(item.Id, [...next], { force: true });
            onSaved?.();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
            // roll back optimistic flip
            await refresh();
        } finally {
            setBusy(false);
        }
    }

    const posterURL = item?.ImageTags?.Primary
        ? `/api/admin/items/${encodeURIComponent(item.Id)}/image?type=Primary&width=240&tag=${encodeURIComponent(
              item.ImageTags.Primary,
          )}`
        : null;

    return (
        <div
            className="modal-backdrop"
            onClick={() => !busy && onClose()}
        >
            <div
                className="modal item-editor-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={item ? `Edit ${item.Name}` : "Edit item"}
            >
                {!item ? (
                    <div className="item-editor-loading">
                        {error ? (
                            <div className="error">{error}</div>
                        ) : (
                            <Spinner block size={36} label="Loading…" />
                        )}
                        <button type="button" onClick={onClose}>
                            Close
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="item-editor-head">
                            {posterURL ? (
                                <img
                                    src={posterURL}
                                    alt=""
                                    className="item-editor-poster"
                                />
                            ) : (
                                <div className="item-editor-poster placeholder" aria-hidden>
                                    ?
                                </div>
                            )}
                            <div className="item-editor-title-block">
                                <h2 className="item-editor-title">{item.Name}</h2>
                                <p className="muted">
                                    {item.Type === "Series" ? "TV" : "Movie"}
                                    {item.ProductionYear
                                        ? ` · ${item.ProductionYear}`
                                        : ""}
                                    {item.OfficialRating
                                        ? ` · ${item.OfficialRating}`
                                        : ""}
                                </p>
                            </div>
                        </div>

                        {error && <div className="error">{error}</div>}

                        <h3 className="section-title">
                            Visibility for {profileName}
                        </h3>
                        <div className="tag-filter-modes item-editor-state-row">
                            <StateRadio
                                value="unset"
                                current={stateChoice}
                                onChange={setState}
                                label="Unset"
                                disabled={busy}
                            />
                            <StateRadio
                                value="visible"
                                current={stateChoice}
                                onChange={setState}
                                label="Visible"
                                disabled={busy}
                            />
                            <StateRadio
                                value="hidden"
                                current={stateChoice}
                                onChange={setState}
                                label="Hidden"
                                disabled={busy}
                            />
                        </div>

                        <h3 className="section-title">Tags</h3>
                        {allTags.length === 0 ? (
                            <p className="muted">
                                No tags yet. Create them in the Tags page.
                            </p>
                        ) : (
                            <div className="pill-toggle-row pill-toggle-wrap">
                                {allTags.map((t) => {
                                    const on = currentTagIds.has(t.id);
                                    return (
                                        <button
                                            key={t.id}
                                            type="button"
                                            className={`pill-toggle ${on ? "active" : ""}`}
                                            aria-pressed={on}
                                            disabled={busy}
                                            onClick={() => toggleTag(t.id, !on)}
                                        >
                                            {t.name}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        <div className="modal-actions item-editor-actions">
                            <button type="button" onClick={onClose} disabled={busy}>
                                Done
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

type RadioProps = {
    value: StateChoice;
    current: StateChoice;
    onChange: (v: StateChoice) => void;
    label: string;
    disabled?: boolean;
};

function StateRadio({ value, current, onChange, label, disabled }: RadioProps) {
    return (
        <label className="tag-filter-mode">
            <input
                type="radio"
                name="item-editor-state"
                value={value}
                checked={current === value}
                onChange={() => onChange(value)}
                disabled={disabled}
            />
            <span>{label}</span>
        </label>
    );
}
