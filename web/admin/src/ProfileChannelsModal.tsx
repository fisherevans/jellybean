import { useEffect, useState } from "react";
import { api, HttpError, type Channel, type Profile, type Tag } from "./api";

// M15 #96: per-profile channels admin. Channel = name + sort order +
// tag membership + explicit item picks. Kid SPA uses the resulting
// queue for continuous "cable TV" playback (#94, deferred).

type Props = {
    profile: Profile;
    onClose: () => void;
};

const SORT_ORDERS: Array<{ value: Channel["sortOrder"]; label: string }> = [
    { value: "random", label: "Random shuffle" },
    { value: "round_robin_tags", label: "Round-robin across tags" },
    { value: "in_order", label: "In order (pinned first)" },
];

export default function ProfileChannelsModal({ profile, onClose }: Props) {
    const [channels, setChannels] = useState<Channel[] | null>(null);
    const [tags, setTags] = useState<Tag[]>([]);
    const [editing, setEditing] = useState<Channel | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function refresh() {
        try {
            const [c, t] = await Promise.all([
                api.listProfileChannels(profile.id),
                api.listTags(),
            ]);
            setChannels(c.channels);
            setTags(t.tags);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }
    useEffect(() => {
        void refresh();
    }, [profile.id]);

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
                profileId={profile.id}
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
        <Modal onClose={onClose} title={`Channels - ${profile.name}`}>
            <div className="modal-form">
                <p className="muted">
                    Channels are continuous shuffled streams shown on the
                    kid home (when the profile's layout includes a
                    `channel` row). Tap a channel to start the cable-TV
                    queue.
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
                                        {c.sortOrder} -{" "}
                                        {(c.tagIds ?? []).length} tag
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
                <div className="modal-actions">
                    <button onClick={onClose}>Close</button>
                    <button
                        className="primary"
                        onClick={() =>
                            setEditing({
                                id: 0,
                                profileId: profile.id,
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
        </Modal>
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
        <Modal
            onClose={onCancel}
            title={c.id === 0 ? "Add channel" : `Edit channel - ${channel.name}`}
        >
            <div className="modal-form">
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
                            No tags defined yet. Create tags in the Tags
                            page first.
                        </p>
                    ) : (
                        tags.map((t) => (
                            <label key={t.id} className="checkbox">
                                <input
                                    type="checkbox"
                                    checked={(c.tagIds ?? []).includes(t.id)}
                                    onChange={() => toggleTag(t.id)}
                                />
                                {t.name}
                            </label>
                        ))
                    )}
                </fieldset>
                <label>
                    Explicit item ids (one per line)
                    <textarea
                        rows={3}
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
                <div className="modal-actions">
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
        </Modal>
    );
}

type ModalProps = {
    onClose: () => void;
    title: string;
    children: React.ReactNode;
};

function Modal({ onClose, title, children }: ModalProps) {
    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>{title}</h3>
                    <button className="modal-close" onClick={onClose}>
                        ×
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}
