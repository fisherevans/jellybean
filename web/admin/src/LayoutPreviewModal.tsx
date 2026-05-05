import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Layout } from "./api";

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
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const got = await api.getLayout(layoutId);
                if (!cancelled) setLayout(got);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "load failed");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [layoutId]);

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
                <div className="modal-head">
                    <h3>Layout preview{layout ? ` — ${layout.name}` : ""}</h3>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>
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
                                                {row.title || row.type}
                                            </div>
                                            <div className="muted">
                                                {row.type}
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </ol>
                        )}
                        <div className="modal-actions">
                            <Link to={`/layouts/${layoutId}`} className="button-link">
                                Open editor →
                            </Link>
                            <button onClick={onClose}>Close</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
