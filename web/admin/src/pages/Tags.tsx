import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Tag, type TagSort } from "../api";
import TagModal from "../TagModal";
import Spinner from "../Spinner";

// Tags list page (M6 #39). Shows every tag in the global namespace
// with item count, supports sort + search + create / rename / delete.
// Tag detail (per-tag item list + add picker) lives at /tags/:id.

type Modal =
    | { kind: "closed" }
    | { kind: "create" }
    | { kind: "edit"; tag: Tag };

export default function Tags() {
    const [tags, setTags] = useState<Tag[] | null>(null);
    const [sort, setSort] = useState<TagSort>("name");
    const [search, setSearch] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<Modal>({ kind: "closed" });

    async function refresh() {
        try {
            const res = await api.listTags({ sort });
            setTags(res.tags);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }

    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sort]);

    async function remove(tag: Tag) {
        const itemHint =
            tag.itemCount && tag.itemCount > 0
                ? ` It is currently applied to ${tag.itemCount} item${tag.itemCount === 1 ? "" : "s"}; the assignments will be removed too.`
                : "";
        if (!confirm(`Delete tag "${tag.name}"?${itemHint}`)) return;
        setError(null);
        try {
            await api.deleteTag(tag.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    // Client-side search on top of the server-side sort. Server-side
    // search exists too (?search=...), but we prefer the client filter
    // here so typing feels instant and we can highlight matches if we
    // ever want to. Tag count is small.
    const visible =
        tags === null
            ? null
            : tags.filter((t) => {
                  const q = search.trim().toLowerCase();
                  if (!q) return true;
                  return (
                      t.name.toLowerCase().includes(q) ||
                      (t.description ?? "").toLowerCase().includes(q)
                  );
              });

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Tags</h1>
                    <p className="muted">
                        Tags are global labels for movies and series. Use profile
                        tag filters to make a tag always-show or always-hide for
                        a particular kid profile, regardless of categorization.
                    </p>
                </div>
                <button onClick={() => setModal({ kind: "create" })}>+ Add tag</button>
            </div>

            {error && <div className="error">{error}</div>}

            <div className="tag-controls">
                <input
                    type="search"
                    value={search}
                    placeholder="Search tags…"
                    onChange={(e) => setSearch(e.target.value)}
                    className="tag-search"
                    aria-label="Search tags"
                />
                <label className="tag-sort">
                    <span>Sort</span>
                    <select
                        value={sort}
                        onChange={(e) => setSort(e.target.value as TagSort)}
                    >
                        <option value="name">Name</option>
                        <option value="count">Item count</option>
                        <option value="recent">Recently updated</option>
                        <option value="manual">Manual order</option>
                    </select>
                </label>
            </div>

            {visible === null ? (
                <Spinner block size={36} label="Loading tags…" />
            ) : visible.length === 0 ? (
                <p className="muted">
                    {search.trim()
                        ? "No tags match that search."
                        : "No tags yet. Create one to get started."}
                </p>
            ) : (
                <ul className="tag-list">
                    {visible.map((t) => (
                        <li key={t.id}>
                            <div className="tag-row">
                                <div className="tag-info">
                                    <Link to={`/tags/${t.id}`} className="tag-name">
                                        {t.name}
                                    </Link>
                                    {t.description ? (
                                        <div className="muted tag-desc">
                                            {t.description}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="tag-meta">
                                    <span className="stat stat-visible">
                                        {(t.itemCount ?? 0).toLocaleString()} item
                                        {(t.itemCount ?? 0) === 1 ? "" : "s"}
                                    </span>
                                </div>
                                <div className="tag-actions">
                                    <button
                                        onClick={() =>
                                            setModal({ kind: "edit", tag: t })
                                        }
                                    >
                                        Rename
                                    </button>
                                    <button onClick={() => remove(t)}>Delete</button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {modal.kind !== "closed" && (
                <TagModal
                    mode={modal.kind}
                    tag={modal.kind === "edit" ? modal.tag : undefined}
                    onClose={() => setModal({ kind: "closed" })}
                    onSaved={async () => {
                        setModal({ kind: "closed" });
                        await refresh();
                    }}
                />
            )}
        </div>
    );
}
