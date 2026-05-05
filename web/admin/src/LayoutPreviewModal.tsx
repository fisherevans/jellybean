import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
    api,
    ROW_TYPE_LABELS,
    type Layout,
    type LayoutRow,
    type Tag,
} from "./api";

// Quick preview of a layout's row list. Used from the profile Basic
// tab so an admin can confirm what's about to be served on the kid
// home without leaving the settings flow. Does NOT preview the
// resolved tile content - that's a much heavier render involving
// Jellyfin metadata. The row list + config gives the admin enough to
// decide.

type Props = {
    layoutId: number;
    onClose: () => void;
};

export default function LayoutPreviewModal({ layoutId, onClose }: Props) {
    const [layout, setLayout] = useState<Layout | null>(null);
    const [tags, setTags] = useState<Tag[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const [got, tagRes] = await Promise.all([
                    api.getLayout(layoutId),
                    api.listTags({ sort: "name" }),
                ]);
                if (cancelled) return;
                setLayout(got);
                setTags(tagRes.tags);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [layoutId]);

    const tagsById = new Map(tags.map((t) => [t.id, t]));

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
                <button
                    type="button"
                    className="modal-close-corner"
                    aria-label="Close"
                    onClick={onClose}
                >
                    ×
                </button>
                <h3 className="modal-title">
                    Layout preview{layout ? ` — ${layout.name}` : ""}
                </h3>
                {error ? (
                    <p className="error">{error}</p>
                ) : !layout ? (
                    <p>Loading...</p>
                ) : (
                    <div className="layout-preview">
                        {layout.description && (
                            <p className="muted">{layout.description}</p>
                        )}
                        {layout.rows.length === 0 ? (
                            <p className="muted">This layout has no rows.</p>
                        ) : (
                            <ol className="layout-preview-rows">
                                {layout.rows.map((row, i) => (
                                    <li key={row.id}>
                                        <span className="layout-preview-num">
                                            {i + 1}
                                        </span>
                                        <div>
                                            <div className="layout-preview-title">
                                                {row.title || ROW_TYPE_LABELS[row.type]}
                                            </div>
                                            <div className="muted">
                                                {summarizeRow(row, tagsById)}
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </ol>
                        )}
                        <div className="modal-actions modal-actions-right">
                            <button onClick={onClose}>Close</button>
                            <Link
                                to={`/layouts/${layoutId}`}
                                className="button-link primary"
                            >
                                Edit
                            </Link>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// Build a human-readable summary line for a layout row. Pulls
// type-specific fields out of row.config (loosely-typed) and falls
// back to the friendly type label when there's nothing extra to
// say. Tag names are resolved against the global tag list passed
// in - tag_fanout shows "all tags" or the explicit tag id list.
function summarizeRow(row: LayoutRow, tagsById: Map<number, Tag>): string {
    const cfg = (row.config ?? {}) as Record<string, unknown>;
    const max = typeof cfg.max === "number" ? cfg.max : undefined;
    switch (row.type) {
        case "continue_watching":
            return max ? `${max} most recent` : "Most recent in-progress items";
        case "favorites":
            return max ? `${max} most recent favorites` : "Recently favorited items";
        case "tag": {
            const id = typeof cfg.tagId === "number" ? cfg.tagId : undefined;
            const tag = id ? tagsById.get(id)?.name : undefined;
            const sort = typeof cfg.sort === "string" ? cfg.sort : "random";
            return [
                tag ? `Tag: ${tag}` : "Tag (none picked)",
                sort,
                max ? `${max} max` : null,
            ]
                .filter(Boolean)
                .join(" · ");
        }
        case "tag_fanout": {
            const ids = Array.isArray(cfg.tagIds)
                ? (cfg.tagIds as unknown[]).filter(
                      (x): x is number => typeof x === "number",
                  )
                : [];
            const order =
                typeof cfg.rowOrder === "string" ? cfg.rowOrder : "alpha";
            const within =
                typeof cfg.within === "string" ? cfg.within : "random";
            const tagSummary =
                ids.length === 0
                    ? "all tags"
                    : ids.length <= 3
                      ? ids
                            .map((id) => tagsById.get(id)?.name ?? `tag ${id}`)
                            .join(", ")
                      : `${ids.length} tags`;
            return [
                tagSummary,
                `rows ${order}`,
                `within ${within}`,
                max ? `${max} per row` : null,
            ]
                .filter(Boolean)
                .join(" · ");
        }
        case "recently_added": {
            const lookback =
                typeof cfg.lookbackDays === "number" ? cfg.lookbackDays : undefined;
            return [
                lookback ? `last ${lookback} days` : "all time",
                max ? `${max} items` : null,
            ]
                .filter(Boolean)
                .join(" · ");
        }
        case "random_unwatched":
            return max ? `${max} random unwatched` : "Random unwatched picks";
        case "watch_again":
            return max ? `${max} recently completed` : "Recently completed items";
        default:
            return ROW_TYPE_LABELS[row.type] ?? row.type;
    }
}
