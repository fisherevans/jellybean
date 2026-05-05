import { useEffect, useMemo, useRef, useState } from "react";
import {
    api,
    HttpError,
    type Channel,
    type Item,
    type Tag,
} from "./api";

// Per-profile cable-TV channels: name + sort order + tag membership
// + explicit per-item picks. The kid SPA's channel-playback engine
// resolves these into a continuous shuffled queue.

type Props = {
    profileId: number;
};

const SORT_ORDERS: Array<{
    value: Channel["sortOrder"];
    label: string;
    desc: string;
}> = [
    {
        value: "random",
        label: "Random shuffle",
        desc: "Pure random pick from the resolved pool each step.",
    },
    {
        value: "distributed_random",
        label: "Distributed random",
        desc: "Random, but avoids picking the same series or tag twice in a row.",
    },
    {
        value: "round_robin_tags",
        label: "Round-robin across tags",
        desc: "Cycle through selected tags evenly.",
    },
    {
        value: "in_order",
        label: "In order (pinned first)",
        desc: "Play explicit picks in order, then tag content alphabetically.",
    },
];

export default function ProfileChannelsForm({ profileId }: Props) {
    const [channels, setChannels] = useState<Channel[] | null>(null);
    const [tags, setTags] = useState<Tag[]>([]);
    const [editing, setEditing] = useState<Channel | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function refresh() {
        try {
            const [c, t] = await Promise.all([
                api.listProfileChannels(profileId),
                api.listTags(),
            ]);
            setChannels(c.channels);
            setTags(t.tags);
            setError(null);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }
    useEffect(() => {
        void refresh();
    }, [profileId]);

    async function remove(c: Channel) {
        if (!confirm(`Delete channel "${c.name}"?`)) return;
        try {
            await api.deleteChannel(c.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    if (editing) {
        return (
            <ChannelEditor
                profileId={profileId}
                tags={tags}
                channel={editing}
                onCancel={() => setEditing(null)}
                onSaved={async () => {
                    setEditing(null);
                    await refresh();
                }}
            />
        );
    }

    return (
        <div className="settings-form">
            <p className="muted">
                Channels are continuous shuffled streams shown on the
                kid home (when the profile's layout includes a channel
                row). A channel mixes items by tag membership with
                explicit per-item picks.
            </p>
            {error && <p className="error">{error}</p>}
            {channels === null ? (
                <p>Loading...</p>
            ) : channels.length === 0 ? (
                <p className="muted">No channels yet.</p>
            ) : (
                <ul className="modes-list">
                    {channels.map((c) => (
                        <li key={c.id} className="modes-list-row">
                            <div>
                                <strong>{c.name}</strong>
                                <div className="muted">
                                    {c.sortOrder} - {(c.tagIds ?? []).length} tag
                                    {(c.tagIds ?? []).length === 1 ? "" : "s"} +{" "}
                                    {(c.itemIds ?? []).length} explicit item
                                    {(c.itemIds ?? []).length === 1 ? "" : "s"}
                                </div>
                            </div>
                            <div>
                                <button onClick={() => setEditing(c)}>Edit</button>
                                <button onClick={() => remove(c)}>Delete</button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            <div className="settings-actions">
                <button
                    className="primary"
                    onClick={() =>
                        setEditing({
                            id: 0,
                            profileId,
                            name: "",
                            sortOrder: "random",
                            tagIds: [],
                            itemIds: [],
                        })
                    }
                >
                    + Add channel
                </button>
            </div>
        </div>
    );
}

type EditorProps = {
    profileId: number;
    tags: Tag[];
    channel: Channel;
    onCancel: () => void;
    onSaved: () => void;
};

function ChannelEditor({ profileId, tags, channel, onCancel, onSaved }: EditorProps) {
    const [c, setC] = useState<Channel>(channel);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    // The kebab "Edit" picker resolves itemIds back to {id, name,
    // poster} so the saved-picks list isn't just a wall of opaque
    // ids. We hydrate once on open then maintain the list in
    // memory as the user adds/removes.
    const [resolvedPicks, setResolvedPicks] = useState<Item[]>([]);

    function set<K extends keyof Channel>(key: K, v: Channel[K]) {
        setC((x) => ({ ...x, [key]: v }));
    }

    function toggleTag(id: number) {
        const cur = c.tagIds ?? [];
        const has = cur.includes(id);
        set("tagIds", has ? cur.filter((t) => t !== id) : [...cur, id]);
    }

    useEffect(() => {
        let cancelled = false;
        const ids = (channel.itemIds ?? []).slice();
        if (ids.length === 0) {
            setResolvedPicks([]);
            return;
        }
        Promise.all(
            ids.map((id) =>
                api
                    .getAdminItem(id, profileId)
                    .catch(() => null as Item | null),
            ),
        ).then((items) => {
            if (cancelled) return;
            const ok = items.filter((it): it is Item => !!it);
            setResolvedPicks(ok);
        });
        return () => {
            cancelled = true;
        };
        // Resolve only once when the editor opens for this channel.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channel.id]);

    function addPick(item: Item) {
        if ((c.itemIds ?? []).includes(item.Id)) return;
        set("itemIds", [...(c.itemIds ?? []), item.Id]);
        setResolvedPicks((prev) =>
            prev.some((p) => p.Id === item.Id) ? prev : [...prev, item],
        );
    }
    function removePick(itemId: string) {
        set("itemIds", (c.itemIds ?? []).filter((id) => id !== itemId));
        setResolvedPicks((prev) => prev.filter((p) => p.Id !== itemId));
    }

    async function save() {
        if (!c.name) {
            setError("Name is required");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            if (c.id === 0) {
                await api.createChannel(profileId, c);
            } else {
                await api.updateChannel(c.id, c);
            }
            onSaved();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="settings-form">
            <h3 className="settings-subhead">
                {c.id === 0 ? "New channel" : `Editing "${channel.name}"`}
            </h3>
            <label>
                Name
                <input
                    type="text"
                    value={c.name}
                    onChange={(e) => set("name", e.target.value)}
                />
            </label>
            <label>
                Description (optional)
                <input
                    type="text"
                    value={c.description ?? ""}
                    onChange={(e) => set("description", e.target.value)}
                />
            </label>
            <fieldset className="pill-fieldset">
                <legend>Sort order</legend>
                <div className="pill-toggle-row pill-toggle-wrap">
                    {SORT_ORDERS.map((o) => {
                        const on = c.sortOrder === o.value;
                        return (
                            <button
                                key={o.value}
                                type="button"
                                className={`pill-toggle ${on ? "active" : ""}`}
                                aria-pressed={on}
                                onClick={() => set("sortOrder", o.value)}
                            >
                                {o.label}
                            </button>
                        );
                    })}
                </div>
                <p className="muted channel-sort-desc">
                    {SORT_ORDERS.find((o) => o.value === c.sortOrder)?.desc}
                </p>
            </fieldset>
            <fieldset className="pill-fieldset">
                <legend>Tags ({(c.tagIds ?? []).length} selected)</legend>
                {tags.length === 0 ? (
                    <p className="muted">
                        No tags defined yet. Create them in the Tags page first.
                    </p>
                ) : (
                    <div className="pill-toggle-row pill-toggle-wrap">
                        {tags.map((t) => {
                            const on = (c.tagIds ?? []).includes(t.id);
                            return (
                                <button
                                    key={t.id}
                                    type="button"
                                    className={`pill-toggle ${on ? "active" : ""}`}
                                    aria-pressed={on}
                                    onClick={() => toggleTag(t.id)}
                                >
                                    {t.name}
                                </button>
                            );
                        })}
                    </div>
                )}
            </fieldset>
            <fieldset className="pill-fieldset">
                <legend>
                    Explicit picks ({(c.itemIds ?? []).length})
                </legend>
                <ItemPicker
                    profileId={profileId}
                    selected={c.itemIds ?? []}
                    selectedItems={resolvedPicks}
                    onAdd={addPick}
                    onRemove={removePick}
                />
            </fieldset>
            {error && <p className="error">{error}</p>}
            <div className="settings-actions">
                <button onClick={onCancel} disabled={saving}>
                    Cancel
                </button>
                <button
                    onClick={save}
                    className="primary"
                    disabled={saving}
                >
                    {saving ? "Saving..." : "Save"}
                </button>
            </div>
        </div>
    );
}

type ItemPickerProps = {
    profileId: number;
    selected: string[];
    selectedItems: Item[];
    onAdd: (item: Item) => void;
    onRemove: (itemId: string) => void;
};

// Search-as-you-type picker for channel explicit picks. Calls
// /api/admin/items?search=... limited to 12 results, each rendered
// as a clickable row with poster + name. Selected items appear
// above with a remove button.
function ItemPicker({
    profileId,
    selected,
    selectedItems,
    onAdd,
    onRemove,
}: ItemPickerProps) {
    const [query, setQuery] = useState("");
    const [debounced, setDebounced] = useState("");
    const [results, setResults] = useState<Item[]>([]);
    const [searching, setSearching] = useState(false);
    const reqId = useRef(0);

    useEffect(() => {
        const id = window.setTimeout(() => setDebounced(query.trim()), 250);
        return () => window.clearTimeout(id);
    }, [query]);

    useEffect(() => {
        if (debounced.length < 2) {
            setResults([]);
            return;
        }
        const my = ++reqId.current;
        setSearching(true);
        api.listItems({
            profileId,
            search: debounced,
            limit: 12,
            type: "Movie,Series",
            state: "visible",
        })
            .then((res) => {
                if (my !== reqId.current) return;
                setResults(res.Items ?? []);
            })
            .catch(() => {
                if (my !== reqId.current) return;
                setResults([]);
            })
            .finally(() => {
                if (my !== reqId.current) return;
                setSearching(false);
            });
    }, [debounced, profileId]);

    const selectedSet = useMemo(() => new Set(selected), [selected]);

    return (
        <div className="channel-item-picker">
            {selectedItems.length > 0 && (
                <ul className="channel-pick-list">
                    {selectedItems.map((it) => (
                        <li key={it.Id} className="channel-pick-row">
                            <ItemRow item={it} />
                            <button
                                type="button"
                                className="channel-pick-remove"
                                onClick={() => onRemove(it.Id)}
                                aria-label={`Remove ${it.Name}`}
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <input
                type="search"
                className="channel-pick-search"
                placeholder="Search to add a movie or show…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            {debounced.length >= 2 && (
                <ul className="channel-pick-results">
                    {searching && results.length === 0 ? (
                        <li className="muted">Searching…</li>
                    ) : results.length === 0 ? (
                        <li className="muted">No matches.</li>
                    ) : (
                        results.map((it) => {
                            const already = selectedSet.has(it.Id);
                            return (
                                <li
                                    key={it.Id}
                                    className="channel-pick-result"
                                >
                                    <ItemRow item={it} />
                                    <button
                                        type="button"
                                        disabled={already}
                                        onClick={() => onAdd(it)}
                                    >
                                        {already ? "Added" : "Add"}
                                    </button>
                                </li>
                            );
                        })
                    )}
                </ul>
            )}
        </div>
    );
}

function ItemRow({ item }: { item: Item }) {
    const url = item.ImageTags?.Primary
        ? `/api/admin/items/${encodeURIComponent(item.Id)}/image?type=Primary&width=60&tag=${encodeURIComponent(item.ImageTags.Primary)}`
        : null;
    return (
        <div className="channel-pick-item">
            {url ? (
                <img src={url} alt="" className="channel-pick-poster" loading="lazy" />
            ) : (
                <div className="channel-pick-poster placeholder" aria-hidden>
                    ?
                </div>
            )}
            <div className="channel-pick-meta">
                <div className="channel-pick-name">{item.Name}</div>
                <div className="muted channel-pick-sub">
                    {item.Type === "Series" ? "TV" : "Movie"}
                    {item.ProductionYear ? ` · ${item.ProductionYear}` : ""}
                </div>
            </div>
        </div>
    );
}
