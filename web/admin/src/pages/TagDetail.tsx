import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { api, HttpError, type Item, type Tag } from "../api";
import { useActiveProfile } from "../activeProfile";
import Spinner from "../Spinner";
import TagModal from "../TagModal";

// Tag detail page (M6 #39). Two main sections:
//   1. Items currently in the tag (uses ?tagId= so tagged-but-hidden
//      items still appear - the spec is explicit about this).
//   2. Add panel: search-filtered list of items currently visible to
//      the active profile, with checkboxes to toggle membership.
//
// Tag CRUD (rename, delete) lives in the header. Delete cascades to
// item_tags + profile_tag_filters server-side.

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
            // Send force=true: removing a tag from a hidden item is the
            // intentional cleanup path the server explicitly allows.
            await api.setItemTags(itemId, remaining, { force: true });
            await Promise.all([refreshItems(), refreshTag()]);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    if (!profile) {
        return (
            <div className="page">
                <p className="muted">Pick a profile in the top nav.</p>
            </div>
        );
    }
    if (error && !tag) {
        return (
            <div className="page">
                <div className="error">{error}</div>
                <Link to="/tags">Back to tags</Link>
            </div>
        );
    }
    if (!tag) {
        return (
            <div className="page">
                <Spinner block size={36} label="Loading tag…" />
            </div>
        );
    }

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>{tag.name}</h1>
                    {tag.description ? (
                        <p className="muted">{tag.description}</p>
                    ) : null}
                    <p className="muted">
                        <Link to="/tags">← Back to tags</Link>
                    </p>
                </div>
                <div className="tag-actions">
                    <button onClick={() => setEditing(true)}>Rename</button>
                    <button onClick={removeTag}>Delete</button>
                </div>
            </div>

            {error && <div className="error">{error}</div>}

            <h2 className="section-title">Items in this tag</h2>
            {items === null ? (
                <Spinner block size={36} label="Loading items…" />
            ) : items.length === 0 ? (
                <p className="muted">
                    Nothing tagged yet. Use the panel below to add items.
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
                            <button onClick={() => untagItem(it.Id)}>Remove tag</button>
                        </li>
                    ))}
                </ul>
            )}

            <AddItemsPanel
                tag={tag}
                profileId={profile.id}
                excludeIds={items?.map((it) => it.Id) ?? []}
                onChanged={async () => {
                    await Promise.all([refreshItems(), refreshTag()]);
                }}
            />

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

type AddItemsPanelProps = {
    tag: Tag;
    profileId: number;
    excludeIds: string[];
    onChanged: () => Promise<void>;
};

// AddItemsPanel: a search-filtered picker over visible-only items
// (per the M6 design - tagging hidden content is uncommon enough that
// the default scope filters it out). We send PUT with the existing
// tag set + this tag for each pick, so the wholesale-replace
// semantics on the server still hold.
function AddItemsPanel({ tag, profileId, excludeIds, onChanged }: AddItemsPanelProps) {
    const [search, setSearch] = useState("");
    const [results, setResults] = useState<Item[]>([]);
    const [loading, setLoading] = useState(false);
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);

    const exclude = useMemo(() => new Set(excludeIds), [excludeIds]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        api.listItems({
            profileId,
            state: "visible",
            search,
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
    }, [profileId, search]);

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

    return (
        <section className="add-items-panel">
            <h2 className="section-title">Add items</h2>
            <p className="muted">
                Showing items currently visible for the active profile.
            </p>
            <input
                type="search"
                value={search}
                placeholder="Search items…"
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search items"
                className="add-items-search"
            />
            {error && <div className="error">{error}</div>}
            {loading ? (
                <Spinner block size={28} label="Loading items…" />
            ) : (
                <ul className="add-items-list">
                    {results
                        .filter((it) => !exclude.has(it.Id))
                        .map((it) => (
                            <li key={it.Id} className="tag-item-row">
                                <div className="tag-item-info">
                                    <div className="tag-item-name">{it.Name}</div>
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
                    {results.filter((it) => !exclude.has(it.Id)).length === 0 && (
                        <li className="muted">
                            {search.trim()
                                ? "No matching items."
                                : "No more visible items to tag."}
                        </li>
                    )}
                </ul>
            )}
        </section>
    );
}
