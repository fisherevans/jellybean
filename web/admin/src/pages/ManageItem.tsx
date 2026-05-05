import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, HttpError, type Item, type Tag } from "../api";
import { useActiveProfile } from "../activeProfile";
import Spinner from "../Spinner";

// Manage-item deep-link page (M9 #57). The kid TV's override QR
// points at /items/:itemId. The admin scans it on their
// phone, lands here, and can manage the item without bouncing
// through the broader admin shell.
//
// We reuse the existing admin item endpoint (?profileId=N to seed
// state). For the override deep-link case we don't always know
// which kid initiated the QR; use the active admin profile for the
// state column.

export default function ManageItem() {
    const { itemId: rawId } = useParams<{ itemId: string }>();
    const itemId = rawId ?? "";
    const { profile } = useActiveProfile();
    const [item, setItem] = useState<Item | null>(null);
    const [tags, setTags] = useState<Tag[]>([]);
    const [allTags, setAllTags] = useState<Tag[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function refresh() {
        if (!profile || !itemId) return;
        try {
            const [items, t, all] = await Promise.all([
                api.listItems({
                    profileId: profile.id,
                    limit: 1,
                    type: "Movie,Series",
                    search: "",
                }),
                api.getItemTags(itemId),
                api.listTags(),
            ]);
            // listItems doesn't filter to a single id - we have to
            // ask for it via the same /api/admin/items endpoint with
            // tagId / state combos, none of which are appropriate
            // here. Instead, scan the small response for our id.
            const found = items.Items.find((it) => it.Id === itemId) ?? null;
            setItem(found);
            setTags(t.tags);
            setAllTags(all.tags);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }
    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [itemId, profile?.id]);

    const currentTagIds = useMemo(
        () => new Set(tags.map((t) => t.id)),
        [tags],
    );

    async function toggleTag(tag: Tag, checked: boolean) {
        if (!item) return;
        setBusy(true);
        setError(null);
        try {
            const next = new Set(currentTagIds);
            if (checked) next.add(tag.id);
            else next.delete(tag.id);
            await api.setItemTags(item.Id, [...next], { force: true });
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function setState(state: "visible" | "hidden" | null) {
        if (!item || !profile) return;
        setBusy(true);
        try {
            await api.setState(item.Id, profile.id, state);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    if (!profile) {
        return (
            <div className="page">
                <p className="muted">Pick a profile in the top nav.</p>
            </div>
        );
    }
    if (!item) {
        return (
            <div className="page">
                {error ? <div className="error">{error}</div> : <Spinner block size={36} label="Loading…" />}
                <Link to="/">Back home</Link>
            </div>
        );
    }

    return (
        <div className="page manage-item">
            <p className="muted">
                <Link to="/">← Home</Link>
            </p>
            <div className="page-head">
                <div>
                    <h1>{item.Name}</h1>
                    <p className="muted">
                        {item.Type}
                        {item.ProductionYear ? ` · ${item.ProductionYear}` : ""}
                        {" · "}
                        {item.State === "visible"
                            ? "Visible"
                            : item.State === "hidden"
                              ? "Hidden"
                              : "Unset"}{" "}
                        for {profile.name}
                    </p>
                </div>
            </div>

            {error && <div className="error">{error}</div>}

            <h2 className="section-title">Visibility</h2>
            <div className="manage-item-actions">
                <button
                    onClick={() => setState("visible")}
                    disabled={busy || item.State === "visible"}
                >
                    Mark visible
                </button>
                <button
                    onClick={() => setState("hidden")}
                    disabled={busy || item.State === "hidden"}
                >
                    Hide
                </button>
                <button
                    onClick={() => setState(null)}
                    disabled={busy || item.State === null}
                >
                    Unset
                </button>
            </div>

            <h2 className="section-title">Tags</h2>
            {allTags.length === 0 ? (
                <p className="muted">No tags exist yet. Create some in the Tags page.</p>
            ) : (
                <ul className="manage-item-tags">
                    {allTags.map((t) => (
                        <li key={t.id}>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={currentTagIds.has(t.id)}
                                    onChange={(e) => toggleTag(t, e.target.checked)}
                                    disabled={busy}
                                />
                                <span>{t.name}</span>
                            </label>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
