import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api, HttpError, type Item, type Tag } from "../api";
import { useActiveProfile } from "../activeProfile";
import Spinner from "../Spinner";
import TagModal from "../TagModal";
import { TAG_ICONS, isTagIconName } from "../tagIcons";

// Tag detail page. Layout top-to-bottom:
//   1. Back link (anchored above the summary).
//   2. Summary panel: icon, name, description, Edit + Delete buttons.
//      Edit opens TagModal (same UX as creating a new tag).
//   3. Add-items: search input with popup overlay anchored beneath
//      it - doesn't push the items list down the page.
//   4. Items in this tag: the persisted member list.

export default function TagDetail() {
    const { tagId: rawId } = useParams<{ tagId: string }>();
    const tagId = Number(rawId);
    const nav = useNavigate();
    const { profile } = useActiveProfile();

    const [tag, setTag] = useState<Tag | null>(null);
    const [items, setItems] = useState<Item[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);

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

            <TagSummaryPanel
                tag={tag}
                onEdit={() => setEditing(true)}
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

            {editing && (
                <TagModal
                    mode="edit"
                    tag={tag}
                    onClose={() => setEditing(false)}
                    onSaved={async () => {
                        setEditing(false);
                        await refreshTag();
                    }}
                />
            )}
        </div>
    );
}

// TagSummaryPanel is the read-only header for a tag. Shows the icon,
// name, and description; Edit + Delete buttons sit on the right.
// Edit opens TagModal (same modal used by "+ Add tag") so the admin
// gets a single, consistent form for create / rename / icon / desc.
type TagSummaryPanelProps = {
    tag: Tag;
    onEdit: () => void;
    onDelete: () => void;
};

function TagSummaryPanel({ tag, onEdit, onDelete }: TagSummaryPanelProps) {
    const Icon =
        tag.icon && isTagIconName(tag.icon) ? TAG_ICONS[tag.icon] : null;
    return (
        <section className="tag-summary-panel">
            <div className="tag-summary-icon">
                {Icon ? <Icon weight="fill" aria-hidden /> : null}
            </div>
            <div className="tag-summary-info">
                <h1 className="tag-summary-name">{tag.name}</h1>
                {tag.description ? (
                    <p className="tag-summary-desc muted">{tag.description}</p>
                ) : (
                    <p className="tag-summary-desc muted">No description.</p>
                )}
            </div>
            <div className="tag-summary-actions">
                <button onClick={onEdit} type="button" className="primary">
                    Edit
                </button>
                <button onClick={onDelete} type="button" className="danger">
                    Delete
                </button>
            </div>
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
