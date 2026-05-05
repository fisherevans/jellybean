import { useEffect, useState } from "react";
import { api, HttpError, type Channel, type Tag } from "./api";

// Per-profile cable-TV channels: name + sort order + tag membership
// + explicit per-item picks. The kid SPA's channel-playback engine
// resolves these into a continuous shuffled queue.

type Props = {
    profileId: number;
};

const SORT_ORDERS: Array<{ value: Channel["sortOrder"]; label: string }> = [
    { value: "random", label: "Random shuffle" },
    { value: "round_robin_tags", label: "Round-robin across tags" },
    { value: "in_order", label: "In order (pinned first)" },
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

    function set<K extends keyof Channel>(key: K, v: Channel[K]) {
        setC((x) => ({ ...x, [key]: v }));
    }

    function toggleTag(id: number) {
        const cur = c.tagIds ?? [];
        const has = cur.includes(id);
        set("tagIds", has ? cur.filter((t) => t !== id) : [...cur, id]);
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
            <label>
                Sort order
                <select
                    value={c.sortOrder}
                    onChange={(e) =>
                        set("sortOrder", e.target.value as Channel["sortOrder"])
                    }
                >
                    {SORT_ORDERS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            </label>
            <fieldset className="day-toggles">
                <legend>Tags ({(c.tagIds ?? []).length} selected)</legend>
                {tags.length === 0 ? (
                    <p className="muted">
                        No tags defined yet. Create them in the Tags page first.
                    </p>
                ) : (
                    <div className="day-toggles-grid wide">
                        {tags.map((t) => (
                            <label key={t.id} className="day-toggle">
                                <input
                                    type="checkbox"
                                    checked={(c.tagIds ?? []).includes(t.id)}
                                    onChange={() => toggleTag(t.id)}
                                />
                                <span>{t.name}</span>
                            </label>
                        ))}
                    </div>
                )}
            </fieldset>
            <label>
                Explicit item ids (one per line)
                <textarea
                    rows={4}
                    value={(c.itemIds ?? []).join("\n")}
                    onChange={(e) =>
                        set(
                            "itemIds",
                            e.target.value
                                .split("\n")
                                .map((s) => s.trim())
                                .filter(Boolean),
                        )
                    }
                />
            </label>
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
