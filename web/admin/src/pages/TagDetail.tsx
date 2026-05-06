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
                taggedItems={items ?? []}
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
                    <ul className="browse-grid">
                        {items.map((it) => (
                            <TaggedItemCard
                                key={it.Id}
                                item={it}
                                onRemove={() => untagItem(it.Id)}
                            />
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

// TaggedItemCard mirrors the admin Browse page card layout with a
// destructive Remove action. Visibility state is intentionally
// omitted - the kid client filters by visibility separately, and
// the tag detail page is about tag membership, not the per-profile
// visibility decision.
type TaggedItemCardProps = {
    item: Item;
    onRemove: () => void;
};

function TaggedItemCard({ item, onRemove }: TaggedItemCardProps) {
    const posterURL = item.ImageTags?.Primary
        ? `/api/admin/items/${encodeURIComponent(item.Id)}/image?type=Primary&width=80&tag=${encodeURIComponent(
              item.ImageTags.Primary,
          )}`
        : null;
    return (
        <li className="browse-item">
            <div className="browse-item-link">
                {posterURL ? (
                    <img
                        src={posterURL}
                        alt=""
                        className="browse-item-poster"
                        loading="lazy"
                    />
                ) : (
                    <div className="browse-item-poster placeholder" aria-hidden>
                        ?
                    </div>
                )}
                <div className="browse-item-body">
                    <div className="browse-item-head">
                        <div className="browse-item-name">{item.Name}</div>
                        <div className="browse-item-meta">
                            <span className="muted">
                                {item.Type === "Series" ? "TV" : "Movie"}
                                {item.ProductionYear
                                    ? ` · ${item.ProductionYear}`
                                    : ""}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
            <button
                type="button"
                className="browse-item-edit destructive"
                aria-label={`Remove ${item.Name} from tag`}
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemove();
                }}
            >
                Remove
            </button>
        </li>
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
    // Items currently in the tag, regardless of visibility state.
    // Used to (a) exclude them from the addable results and (b) show
    // them in the bottom "Already tagged" section when they match
    // the search - including hidden items that the server-side
    // visible-only filter would otherwise drop.
    taggedItems: Item[];
    onChanged: () => Promise<void>;
};

function AddItemsPanel({ tag, profileId, taggedItems, onChanged }: AddItemsPanelProps) {
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [results, setResults] = useState<Item[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    const exclude = useMemo(
        () => new Set(taggedItems.map((it) => it.Id)),
        [taggedItems],
    );

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

    async function remove(it: Item) {
        if (busyIds.has(it.Id)) return;
        const next = new Set(busyIds);
        next.add(it.Id);
        setBusyIds(next);
        setError(null);
        try {
            const remaining = (it.Tags ?? [])
                .filter((t) => t.id !== tag.id)
                .map((t) => t.id);
            // force=true: removing a tag from a hidden item is the
            // intentional cleanup path the server explicitly allows.
            await api.setItemTags(it.Id, remaining, { force: true });
            await onChanged();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            const drop = new Set(busyIds);
            drop.delete(it.Id);
            setBusyIds(drop);
        }
    }

    // Split results: addable (visible items not yet tagged) come from
    // the server search; already-tagged results come from the parent's
    // taggedItems array filtered locally by the search query. We
    // can't get tagged-but-hidden items from the server search
    // (state: "visible" filters them out), so the local filter is
    // necessary to show those.
    const addableResults = results.filter((it) => !exclude.has(it.Id));
    const alreadyTaggedResults = useMemo(() => {
        const q = debouncedSearch.toLowerCase();
        if (!q) return [] as Item[];
        return taggedItems.filter((it) =>
            it.Name.toLowerCase().includes(q),
        );
    }, [taggedItems, debouncedSearch]);

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
                        {loading &&
                        addableResults.length === 0 &&
                        alreadyTaggedResults.length === 0 ? (
                            <div className="muted tag-add-popup-empty">
                                Loading…
                            </div>
                        ) : addableResults.length === 0 &&
                          alreadyTaggedResults.length === 0 ? (
                            <div className="muted tag-add-popup-empty">
                                {debouncedSearch
                                    ? "No matching visible items."
                                    : "No more visible items to tag."}
                            </div>
                        ) : (
                            <>
                                {addableResults.length > 0 && (
                                    <ul className="tag-add-popup-list">
                                        {addableResults.map((it) => (
                                            <li
                                                key={it.Id}
                                                className="tag-add-popup-row"
                                            >
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
                                                    className="constructive"
                                                    onClick={() => add(it)}
                                                    disabled={busyIds.has(
                                                        it.Id,
                                                    )}
                                                >
                                                    {busyIds.has(it.Id)
                                                        ? "Adding…"
                                                        : "Add"}
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {alreadyTaggedResults.length > 0 && (
                                    <>
                                        <div className="tag-add-popup-section-head">
                                            Already tagged
                                        </div>
                                        <ul className="tag-add-popup-list">
                                            {alreadyTaggedResults.map((it) => (
                                                <li
                                                    key={it.Id}
                                                    className="tag-add-popup-row tag-add-popup-row-tagged"
                                                >
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
                                                        className="destructive"
                                                        onClick={() =>
                                                            remove(it)
                                                        }
                                                        disabled={busyIds.has(
                                                            it.Id,
                                                        )}
                                                    >
                                                        {busyIds.has(it.Id)
                                                            ? "Removing…"
                                                            : "Remove"}
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
