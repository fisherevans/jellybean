import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Tag, type TagSort } from "../api";
import TagModal from "../TagModal";
import Spinner from "../Spinner";
import { TAG_ICONS, isTagIconName } from "../tagIcons";

// Tags list page (M6 #39). Each row is a Link to /tags/:id - the
// detail page is where rename / description / icon / delete live.
// The list itself just shows: icon (when set), name, description,
// item count.

export default function Tags() {
    const [tags, setTags] = useState<Tag[] | null>(null);
    const [sort, setSort] = useState<TagSort>("name");
    const [search, setSearch] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

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

    // Client-side search on top of the server-side sort. Fast
    // because tag count is small.
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
                        Tags are global labels for movies and series. Use
                        profile tag filters to make a tag always-show or
                        always-hide for a particular kid profile,
                        regardless of categorization.
                    </p>
                </div>
                <button className="primary" onClick={() => setCreating(true)}>
                    + Add tag
                </button>
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
                            <TagListRow tag={t} />
                        </li>
                    ))}
                </ul>
            )}

            {creating && (
                <TagModal
                    mode="create"
                    onClose={() => setCreating(false)}
                    onSaved={async () => {
                        setCreating(false);
                        await refresh();
                    }}
                />
            )}
        </div>
    );
}

// TagListRow: the entire row is one Link to the tag's detail page.
// No inline rename / delete buttons - those live on the detail
// page now.
function TagListRow({ tag }: { tag: Tag }) {
    const Icon =
        tag.icon && isTagIconName(tag.icon) ? TAG_ICONS[tag.icon] : null;
    const count = tag.itemCount ?? 0;
    return (
        <Link to={`/tags/${tag.id}`} className="tag-row tag-row-link">
            <div className="tag-row-icon">
                {Icon ? <Icon weight="fill" aria-hidden /> : null}
            </div>
            <div className="tag-row-info">
                <div className="tag-row-name">{tag.name}</div>
                {tag.description ? (
                    <div className="muted tag-row-desc">{tag.description}</div>
                ) : null}
            </div>
            <div className="tag-row-meta">
                <span className="stat stat-visible">
                    {count.toLocaleString()} item{count === 1 ? "" : "s"}
                </span>
            </div>
        </Link>
    );
}
