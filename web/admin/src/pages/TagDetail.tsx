import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api, HttpError, type Item, type Tag } from "../api";
import { useActiveProfile } from "../activeProfile";
import IconPicker from "../IconPicker";
import Spinner from "../Spinner";
import { isTagIconName } from "../tagIcons";

// Tag detail page. Layout top-to-bottom:
//   1. Back link (anchored above the editor).
//   2. Edit panel: icon picker, name, description, delete. Auto-saves
//      on blur (debounced) so the kid never sees a stale edit.
//   3. Add-items: search input at the top with a popup overlay that
//      shows search results (anchored to the input, doesn't push the
//      page down).
//   4. Items in this tag: the persisted member list.

export default function TagDetail() {
    const { tagId: rawId } = useParams<{ tagId: string }>();
    const tagId = Number(rawId);
    const nav = useNavigate();
    const { profile } = useActiveProfile();

    const [tag, setTag] = useState<Tag | null>(null);
    const [items, setItems] = useState<Item[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refreshTag = useCallback(async () => {
        if (!Number.isFinite(tagId) || tagId <= 0) {
            setError("Invalid tag id");
            return;
        }
        try {
            const list = await api.listTags();
            const t = list.tags.find((x) => x.id === tagId) ?? null;
            setTag(t);
            if (!t) setError("Tag not found");
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [tagId]);

    const refreshItems = useCallback(async () => {
        if (!profile) return;
        try {
            const res = await api.listItems({
                profileId: profile.id,
                tagId,
                limit: 200,
            });
            setItems(res.Items);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [tagId, profile]);

    useEffect(() => {
        refreshTag();
    }, [refreshTag]);
    useEffect(() => {
        refreshItems();
    }, [refreshItems]);

    async function removeTag() {
        if (!tag) return;
        const itemHint =
            (tag.itemCount ?? items?.length ?? 0) > 0
                ? ` It is currently applied to ${tag.itemCount ?? items?.length} item${(tag.itemCount ?? 0) === 1 ? "" : "s"}; assignments will be removed too.`
                : "";
        if (!confirm(`Delete tag "${tag.name}"?${itemHint}`)) return;
        try {
            await api.deleteTag(tag.id);
            nav("/tags");
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    async function untagItem(itemId: string) {
        if (!tag || !items) return;
        const item = items.find((it) => it.Id === itemId);
        if (!item) return;
        const remaining = (item.Tags ?? [])
            .filter((t) => t.id !== tag.id)
            .map((t) => t.id);
        try {
            await api.setItemTags(itemId, remaining, { force: true });
            await Promise.all([refreshItems(), refreshTag()]);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    if (!profile) {
        return (
            <div className="page">
                <Link to="/tags" className="back-link">
                    ← Back to tags
                </Link>
                <p className="muted">Pick a profile in the top nav.</p>
            </div>
        );
    }
    if (error && !tag) {
        return (
            <div className="page">
                <Link to="/tags" className="back-link">
                    ← Back to tags
                </Link>
                <div className="error">{error}</div>
            </div>
        );
    }
    if (!tag) {
        return (
            <div className="page">
                <Link to="/tags" className="back-link">
                    ← Back to tags
                </Link>
                <Spinner block size={36} label="Loading tag…" />
            </div>
        );
    }

    return (
        <div className="page tag-detail">
            <Link to="/tags" className="back-link">
                ← Back to tags
            </Link>

            <TagEditPanel
                tag={tag}
                onChanged={refreshTag}
                onDelete={removeTag}
            />

            {error && <div className="error">{error}</div>}

            <AddItemsPanel
                tag={tag}
                profileId={profile.id}
                excludeIds={items?.map((it) => it.Id) ?? []}
                onChanged={async () => {
                    await Promise.all([refreshItems(), refreshTag()]);
                }}
            />

            <section className="tag-items-section">
                <h2 className="section-title">
                    Items in this tag
                    {items ? ` (${items.length.toLocaleString()})` : ""}
                </h2>
                {items === null ? (
                    <Spinner block size={36} label="Loading items…" />
                ) : items.length === 0 ? (
                    <p className="muted">
                        Nothing tagged yet. Use the search above to add items.
                    </p>
                ) : (
                    <ul className="tag-item-list">
                        {items.map((it) => (
                            <li key={it.Id} className="tag-item-row">
                                <div className="tag-item-info">
                                    <div className="tag-item-name">{it.Name}</div>
                                    <div className="muted">
                                        {it.Type}
                                        {it.ProductionYear ? ` · ${it.ProductionYear}` : ""}
                                        {" · "}
                                        {it.State === "visible"
                                            ? "Visible"
                                            : it.State === "hidden"
                                              ? "Hidden"
                                              : "Unset"}{" "}
                                        for {profile.name}
                                    </div>
                                </div>
                                <button onClick={() => untagItem(it.Id)}>
                                    Remove tag
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

// TagEditPanel inlines the tag fields with debounced autosave. Each
// field's onChange updates local state immediately (no input lag);
// after 500ms of inactivity, a PATCH fires. Save state is shown in
// the corner so the admin sees their changes are landing.
type TagEditPanelProps = {
    tag: Tag;
    onChanged: () => Promise<void>;
    onDelete: () => void;
};

function TagEditPanel({ tag, onChanged, onDelete }: TagEditPanelProps) {
    const [name, setName] = useState(tag.name);
    const [description, setDescription] = useState(tag.description ?? "");
    const [icon, setIcon] = useState<string>(
        tag.icon && isTagIconName(tag.icon) ? tag.icon : "",
    );
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const initialRef = useRef({
        name: tag.name,
        description: tag.description ?? "",
        icon: tag.icon ?? "",
    });

    // Debounced save. Each change schedules a save 500ms out; new
    // changes within the window cancel the previous timer.
    const saveTimer = useRef<number | null>(null);
    useEffect(() => {
        if (
            name === initialRef.current.name &&
            description === initialRef.current.description &&
            icon === initialRef.current.icon
        ) {
            return;
        }
        if (saveTimer.current !== null) {
            window.clearTimeout(saveTimer.current);
        }
        saveTimer.current = window.setTimeout(async () => {
            saveTimer.current = null;
            const trimmed = name.trim();
            if (!trimmed) {
                setSaveError("Name is required");
                return;
            }
            setSaving(true);
            setSaveError(null);
            try {
                await api.updateTag(tag.id, {
                    name: trimmed,
                    description: description.trim(),
                    icon,
                });
                initialRef.current = {
                    name: trimmed,
                    description: description.trim(),
                    icon,
                };
                setSavedAt(Date.now());
                await onChanged();
            } catch (err) {
                setSaveError(
                    err instanceof HttpError ? err.message : String(err),
                );
            } finally {
                setSaving(false);
            }
        }, 500);
        return () => {
            if (saveTimer.current !== null) {
                window.clearTimeout(saveTimer.current);
            }
        };
    }, [name, description, icon, tag.id, onChanged]);

    // Snap savedAt into a "Saved" indicator that fades out.
    const saveLabel = saving
        ? "Saving…"
        : saveError
          ? "Save failed"
          : savedAt
            ? "Saved"
            : "";

    return (
        <section className="tag-edit-panel">
            <div className="tag-edit-header">
                <div className="tag-edit-fields">
                    <label>
                        Name
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Adventure, Bedtime, Scary"
                        />
                    </label>
                    <label>
                        Description
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={2}
                            placeholder="Optional"
                        />
                    </label>
                </div>
                <div className="tag-edit-side">
                    <span
                        className={`tag-edit-save ${
                            saving
                                ? "saving"
                                : saveError
                                  ? "error"
                                  : savedAt
                                    ? "saved"
                                    : ""
                        }`}
                    >
                        {saveLabel}
                    </span>
                    <button
                        className="danger"
                        onClick={onDelete}
                        type="button"
                    >
                        Delete tag
                    </button>
                </div>
            </div>
            {saveError && <div className="error">{saveError}</div>}
            <IconPicker value={icon} onChange={setIcon} />
        </section>
    );
}

// AddItemsPanel: search input at the top, results in a popup overlay
// directly beneath. The popup is absolutely positioned so it doesn't
// push the items list (rendered below) down the page. Click a result
// to add it; the popup re-renders with the new exclude set.
type AddItemsPanelProps = {
    tag: Tag;
    profileId: number;
    excludeIds: string[];
    onChanged: () => Promise<void>;
};

function AddItemsPanel({ tag, profileId, excludeIds, onChanged }: AddItemsPanelProps) {
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [results, setResults] = useState<Item[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    const exclude = useMemo(() => new Set(excludeIds), [excludeIds]);

    // Debounce search input by 250ms so each keystroke doesn't fire.
    useEffect(() => {
        const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
        return () => window.clearTimeout(t);
    }, [search]);

    // Fetch results when the debounced query changes (and the popup
    // is open). Empty query: show a default visible-items list.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        api.listItems({
            profileId,
            state: "visible",
            search: debouncedSearch || undefined,
            limit: 50,
        })
            .then((res) => {
                if (cancelled) return;
                setResults(res.Items);
                setError(null);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : "load failed");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [profileId, debouncedSearch, open]);

    // Close popup on click outside the wrap.
    useEffect(() => {
        if (!open) return;
        function onDocClick(e: MouseEvent) {
            if (!wrapRef.current) return;
            if (!wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        window.addEventListener("mousedown", onDocClick);
        return () => window.removeEventListener("mousedown", onDocClick);
    }, [open]);

    async function add(it: Item) {
        if (busyIds.has(it.Id)) return;
        const next = new Set(busyIds);
        next.add(it.Id);
        setBusyIds(next);
        setError(null);
        try {
            const existingTagIds = (it.Tags ?? []).map((t) => t.id);
            if (existingTagIds.includes(tag.id)) return;
            await api.setItemTags(it.Id, [...existingTagIds, tag.id]);
            await onChanged();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            const drop = new Set(busyIds);
            drop.delete(it.Id);
            setBusyIds(drop);
        }
    }

    const filteredResults = results.filter((it) => !exclude.has(it.Id));

    return (
        <section className="tag-add-section">
            <h2 className="section-title">Add items</h2>
            <div className="tag-add-search-wrap" ref={wrapRef}>
                <input
                    type="search"
                    value={search}
                    placeholder="Search visible items to add…"
                    onChange={(e) => setSearch(e.target.value)}
                    onFocus={() => setOpen(true)}
                    aria-label="Search items"
                    className="tag-add-search"
                />
                {open && (
                    <div className="tag-add-popup">
                        {error && <div className="error">{error}</div>}
                        {loading && filteredResults.length === 0 ? (
                            <div className="muted tag-add-popup-empty">
                                Loading…
                            </div>
                        ) : filteredResults.length === 0 ? (
                            <div className="muted tag-add-popup-empty">
                                {debouncedSearch
                                    ? "No matching visible items."
                                    : "No more visible items to tag."}
                            </div>
                        ) : (
                            <ul className="tag-add-popup-list">
                                {filteredResults.map((it) => (
                                    <li key={it.Id} className="tag-add-popup-row">
                                        <div className="tag-add-popup-info">
                                            <div className="tag-add-popup-name">
                                                {it.Name}
                                            </div>
                                            <div className="muted">
                                                {it.Type}
                                                {it.ProductionYear
                                                    ? ` · ${it.ProductionYear}`
                                                    : ""}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => add(it)}
                                            disabled={busyIds.has(it.Id)}
                                        >
                                            {busyIds.has(it.Id) ? "Adding…" : "Add"}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
