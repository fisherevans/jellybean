import { useEffect, useMemo, useState } from "react";
import {
    api,
    HttpError,
    type LayoutRow,
    type LayoutRowConfig,
    type RowType,
    type Tag,
    ALL_ROW_TYPES,
    ROW_TYPE_LABELS,
} from "./api";
import Spinner from "./Spinner";

type Props = {
    layoutId: number;
    row?: LayoutRow; // create when undefined
    onClose: () => void;
    onSaved: () => void;
};

// LayoutRowEditor handles create + edit in one component. Type
// selector is shown only on create; the per-type config form below
// it changes as the user picks a type. On edit the type is fixed
// (matches the issue spec - changing types means recreating because
// the config shape is different).
export default function LayoutRowEditor({
    layoutId,
    row,
    onClose,
    onSaved,
}: Props) {
    const isEdit = !!row;
    const [type, setType] = useState<RowType>(row?.type ?? "continue_watching");
    const [title, setTitle] = useState(row?.title ?? "");
    const [config, setConfig] = useState<LayoutRowConfig>(row?.config ?? {});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [tags, setTags] = useState<Tag[] | null>(null);

    useEffect(() => {
        api.listTags().then((res) => setTags(res.tags)).catch(() => setTags([]));
    }, []);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape" && !busy) onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [busy, onClose]);

    // Reset config when the type changes on a fresh row (preserves
    // existing config when editing).
    useEffect(() => {
        if (isEdit) return;
        setConfig(defaultConfigFor(type));
    }, [type, isEdit]);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            if (isEdit && row) {
                await api.updateLayoutRow(layoutId, row.id, {
                    type,
                    title,
                    config,
                });
            } else {
                await api.appendLayoutRow(layoutId, { type, title, config });
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
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <h2>{isEdit ? `Edit row: ${row?.title || ROW_TYPE_LABELS[row!.type]}` : "Add row"}</h2>
                <form className="modal-form" onSubmit={submit}>
                    <label>
                        Type
                        <select
                            value={type}
                            onChange={(e) => setType(e.target.value as RowType)}
                            disabled={isEdit || busy}
                        >
                            {ALL_ROW_TYPES.map((rt) => (
                                <option key={rt} value={rt}>
                                    {ROW_TYPE_LABELS[rt]}
                                </option>
                            ))}
                        </select>
                        {isEdit ? (
                            <span className="modal-hint">
                                Type cannot change after a row is created. Delete and re-create to switch.
                            </span>
                        ) : null}
                    </label>
                    <label>
                        Title (optional)
                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={`Default: ${ROW_TYPE_LABELS[type]}`}
                            disabled={busy}
                        />
                    </label>

                    <RowConfigFields
                        type={type}
                        config={config}
                        onChange={setConfig}
                        tags={tags}
                        disabled={busy}
                    />

                    {error && <div className="error">{error}</div>}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="submit" disabled={busy}>
                            {busy ? "Saving…" : isEdit ? "Save" : "Add"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// defaultConfigFor returns the per-type starting config when the user
// picks a type for the first time. Each one mirrors the row-type's
// resolver defaults so the kid client behaves sensibly even if the
// admin doesn't tweak anything.
function defaultConfigFor(t: RowType): LayoutRowConfig {
    switch (t) {
        case "tag":
            return { tag_id: 0, sort: "name", max_items: 20 };
        case "tag_fanout":
            return {
                include_tag_ids: [],
                exclude_tag_ids: [],
                row_order: "alpha",
                within_row_sort: "name",
                max_items: 20,
            };
        case "recently_added":
            return { lookback_days: 30, max_items: 20 };
        case "watch_again":
            return { min_watch_minutes: 10, dormant_days: 30, max_items: 20 };
        default:
            return { max_items: 20 };
    }
}

type FieldsProps = {
    type: RowType;
    config: LayoutRowConfig;
    onChange: (next: LayoutRowConfig) => void;
    tags: Tag[] | null;
    disabled: boolean;
};

// RowConfigFields renders the per-type config form. Each row type
// gets a distinct subset of inputs; everything writes back into the
// raw config object so we don't have to keep separate state slices.
function RowConfigFields({ type, config, onChange, tags, disabled }: FieldsProps) {
    function patch(p: LayoutRowConfig) {
        onChange({ ...config, ...p });
    }

    const maxItems = (
        <label>
            Max items
            <input
                type="number"
                min={1}
                max={100}
                value={Number(config.max_items ?? 20)}
                onChange={(e) =>
                    patch({ max_items: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })
                }
                disabled={disabled}
            />
            <span className="modal-hint">Hard limit 100.</span>
        </label>
    );

    if (type === "tag") {
        return (
            <>
                <label>
                    Tag
                    {tags === null ? (
                        <Spinner size={18} />
                    ) : (
                        <select
                            value={Number(config.tag_id ?? 0)}
                            onChange={(e) =>
                                patch({ tag_id: Number(e.target.value) })
                            }
                            disabled={disabled}
                        >
                            <option value={0}>Pick a tag…</option>
                            {tags.map((t) => (
                                <option key={t.id} value={t.id}>
                                    {t.name}
                                </option>
                            ))}
                        </select>
                    )}
                </label>
                <label>
                    Sort
                    <select
                        value={String(config.sort ?? "name")}
                        onChange={(e) => patch({ sort: e.target.value })}
                        disabled={disabled}
                    >
                        <option value="name">Alphabetical</option>
                        <option value="random">Random (stable for 60 min)</option>
                        <option value="recently_added">Recently added</option>
                    </select>
                </label>
                {maxItems}
            </>
        );
    }

    if (type === "tag_fanout") {
        return (
            <>
                <p className="muted">
                    Empty include list = every tag in the global namespace. Use exclude to drop a few.
                </p>
                <TagMultiPicker
                    label="Include tags (empty = all)"
                    tags={tags}
                    value={(config.include_tag_ids as number[] | undefined) ?? []}
                    onChange={(ids) => patch({ include_tag_ids: ids })}
                    disabled={disabled}
                />
                <TagMultiPicker
                    label="Exclude tags"
                    tags={tags}
                    value={(config.exclude_tag_ids as number[] | undefined) ?? []}
                    onChange={(ids) => patch({ exclude_tag_ids: ids })}
                    disabled={disabled}
                />
                <label>
                    Row order
                    <select
                        value={String(config.row_order ?? "alpha")}
                        onChange={(e) => patch({ row_order: e.target.value })}
                        disabled={disabled}
                    >
                        <option value="alpha">Alphabetical</option>
                        <option value="random">Random (stable for 60 min)</option>
                    </select>
                </label>
                <label>
                    Within-row sort
                    <select
                        value={String(config.within_row_sort ?? "name")}
                        onChange={(e) => patch({ within_row_sort: e.target.value })}
                        disabled={disabled}
                    >
                        <option value="name">Alphabetical</option>
                        <option value="random">Random</option>
                        <option value="recently_added">Recently added</option>
                    </select>
                </label>
                {maxItems}
            </>
        );
    }

    if (type === "recently_added") {
        return (
            <>
                <label>
                    Lookback days (0 for no limit)
                    <input
                        type="number"
                        min={0}
                        value={Number(config.lookback_days ?? 30)}
                        onChange={(e) =>
                            patch({ lookback_days: Math.max(0, Number(e.target.value) || 0) })
                        }
                        disabled={disabled}
                    />
                </label>
                {maxItems}
            </>
        );
    }

    if (type === "watch_again") {
        return (
            <>
                <label>
                    Dormant days (only items last played longer ago than this)
                    <input
                        type="number"
                        min={1}
                        value={Number(config.dormant_days ?? 30)}
                        onChange={(e) =>
                            patch({ dormant_days: Math.max(1, Number(e.target.value) || 1) })
                        }
                        disabled={disabled}
                    />
                </label>
                <label>
                    Min watch minutes (placeholder, not yet enforced)
                    <input
                        type="number"
                        min={0}
                        value={Number(config.min_watch_minutes ?? 10)}
                        onChange={(e) =>
                            patch({ min_watch_minutes: Math.max(0, Number(e.target.value) || 0) })
                        }
                        disabled={disabled}
                    />
                    <span className="modal-hint">
                        Jellyfin doesn't expose cumulative-watched per item; this field is reserved for when we add it.
                    </span>
                </label>
                {maxItems}
            </>
        );
    }

    // continue_watching, favorites, random_unwatched: only max_items.
    return <>{maxItems}</>;
}

type TagMultiPickerProps = {
    label: string;
    tags: Tag[] | null;
    value: number[];
    onChange: (next: number[]) => void;
    disabled: boolean;
};

// TagMultiPicker is a checkbox list. Small enough that we don't need
// a search input; we'll add one in a follow-up if the global tag list
// grows past 20 or so.
function TagMultiPicker({ label, tags, value, onChange, disabled }: TagMultiPickerProps) {
    const selected = useMemo(() => new Set(value), [value]);
    function toggle(id: number, checked: boolean) {
        const next = new Set(selected);
        if (checked) next.add(id);
        else next.delete(id);
        onChange([...next].sort((a, b) => a - b));
    }
    return (
        <fieldset className="tag-multipicker">
            <legend>{label}</legend>
            {tags === null ? (
                <Spinner size={18} />
            ) : tags.length === 0 ? (
                <p className="muted">No tags exist yet.</p>
            ) : (
                <ul className="tag-multipicker-list">
                    {tags.map((t) => (
                        <li key={t.id}>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={selected.has(t.id)}
                                    onChange={(e) => toggle(t.id, e.target.checked)}
                                    disabled={disabled}
                                />
                                <span>{t.name}</span>
                            </label>
                        </li>
                    ))}
                </ul>
            )}
        </fieldset>
    );
}
