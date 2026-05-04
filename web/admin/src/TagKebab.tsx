import { useEffect, useRef, useState } from "react";
import { api, HttpError, type Item, type Tag } from "./api";

// TagKebab is the M6 #39 universal "tag this item" surface. Renders
// a three-dot button on every item card; clicking opens a popover
// with a checkbox list of every tag. Toggling a checkbox persists
// immediately via PUT /api/admin/items/:id/tags so the kid's library
// reflects the change without a Save button.
//
// Props: the item itself (so we can seed checkbox state from
// item.Tags) plus an onChanged callback so the host page can refresh
// the tile (or its row) after a toggle.

type Props = {
    item: Item;
    onChanged?: (newTags: Tag[]) => void;
};

export default function TagKebab({ item, onChanged }: Props) {
    const [open, setOpen] = useState(false);
    const [tags, setTags] = useState<Tag[] | null>(null);
    const [busyTagId, setBusyTagId] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Lazy-load the global tag list once on first open. Refetch on
    // re-open in case the admin added tags in another tab.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        api.listTags()
            .then((res) => {
                if (cancelled) return;
                setTags(res.tags);
                setError(null);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : "load failed");
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    // Click-outside + Escape to close.
    useEffect(() => {
        if (!open) return;
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") setOpen(false);
        }
        function onDoc(e: MouseEvent) {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        }
        window.addEventListener("keydown", onKey);
        document.addEventListener("mousedown", onDoc);
        return () => {
            window.removeEventListener("keydown", onKey);
            document.removeEventListener("mousedown", onDoc);
        };
    }, [open]);

    const currentIds = new Set((item.Tags ?? []).map((t) => t.id));

    async function toggle(tag: Tag, checked: boolean) {
        setBusyTagId(tag.id);
        setError(null);
        try {
            const next = new Set(currentIds);
            if (checked) {
                next.add(tag.id);
            } else {
                next.delete(tag.id);
            }
            const res = await api.setItemTags(item.Id, [...next], {
                // Allow tagging hidden items via the kebab too. The
                // visible-only guard lives on the server but the
                // kebab is the universal "fix it now" surface, and
                // forcing a visible-only round trip just to add a
                // cleanup tag is friction.
                force: true,
            });
            onChanged?.(res.tags);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusyTagId(null);
        }
    }

    return (
        <div className="tag-kebab" ref={containerRef}>
            <button
                type="button"
                className="tag-kebab-trigger"
                aria-label="Tags"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    setOpen((v) => !v);
                }}
            >
                {/* three-dot vertical glyph; CSS positions it as an overlay */}
                ⋮
            </button>
            {open && (
                <div
                    className="tag-kebab-popover"
                    role="menu"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="tag-kebab-header">Tags</div>
                    {error && <div className="error">{error}</div>}
                    {tags === null ? (
                        <div className="muted tag-kebab-empty">Loading…</div>
                    ) : tags.length === 0 ? (
                        <div className="muted tag-kebab-empty">
                            No tags yet. Create one in the Tags page.
                        </div>
                    ) : (
                        <ul className="tag-kebab-list">
                            {tags.map((t) => {
                                const checked = currentIds.has(t.id);
                                const busy = busyTagId === t.id;
                                return (
                                    <li key={t.id}>
                                        <label className="tag-kebab-row">
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                disabled={busy}
                                                onChange={(e) =>
                                                    toggle(t, e.target.checked)
                                                }
                                            />
                                            <span>{t.name}</span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
