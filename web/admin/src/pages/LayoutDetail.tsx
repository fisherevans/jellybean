import { useCallback, useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
    api,
    HttpError,
    type Layout,
    type LayoutRow,
    type LayoutRowConfig,
    type RowType,
    ROW_TYPE_LABELS,
} from "../api";
import Spinner from "../Spinner";
import LayoutRowEditor from "../LayoutRowEditor";

// Layout editor (M8 #50). Header: layout name + description (inline
// edit). Body: ordered row list with up/down arrows + edit / delete.
// Skipped vs the full spec: drag-and-drop reorder (use buttons),
// in-modal live preview (defer).

type EditorModal =
    | { kind: "closed" }
    | { kind: "create" }
    | { kind: "edit"; row: LayoutRow };

export default function LayoutDetail() {
    const { layoutId: rawId } = useParams<{ layoutId: string }>();
    const layoutId = Number(rawId);
    const nav = useNavigate();

    const [layout, setLayout] = useState<Layout | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [headerEditing, setHeaderEditing] = useState(false);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [editorModal, setEditorModal] = useState<EditorModal>({ kind: "closed" });

    const refresh = useCallback(async () => {
        if (!Number.isFinite(layoutId) || layoutId <= 0) {
            setError("Invalid layout id");
            return;
        }
        try {
            const l = await api.getLayout(layoutId);
            setLayout(l);
            setName(l.name);
            setDescription(l.description ?? "");
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [layoutId]);

    useEffect(() => {
        refresh();
    }, [refresh]);

    async function saveHeader() {
        if (!layout) return;
        try {
            setBusy(true);
            await api.updateLayout(layout.id, { name, description });
            setHeaderEditing(false);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function moveRow(idx: number, dir: -1 | 1) {
        if (!layout) return;
        const next = idx + dir;
        if (next < 0 || next >= layout.rows.length) return;
        const ids = layout.rows.map((r) => r.id);
        [ids[idx], ids[next]] = [ids[next], ids[idx]];
        try {
            setBusy(true);
            await api.reorderLayoutRows(layout.id, ids);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function deleteRow(row: LayoutRow) {
        if (!layout) return;
        if (!confirm(`Delete the "${rowDisplayLabel(row)}" row?`)) return;
        try {
            setBusy(true);
            await api.deleteLayoutRow(layout.id, row.id);
            await refresh();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function deleteLayout() {
        if (!layout) return;
        if (layout.isDefault) return;
        if (
            !confirm(
                `Delete layout "${layout.name}"? Profiles assigned to it will need to be reassigned first.`,
            )
        )
            return;
        try {
            await api.deleteLayout(layout.id);
            nav("/layouts");
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    if (error && !layout) {
        return (
            <div className="page">
                <div className="error">{error}</div>
                <Link to="/layouts">Back to layouts</Link>
            </div>
        );
    }
    if (!layout) {
        return (
            <div className="page">
                <Spinner block size={36} label="Loading layout…" />
            </div>
        );
    }

    return (
        <div className="page">
            <p className="muted">
                <Link to="/layouts">← Back to layouts</Link>
            </p>
            <div className="page-head">
                <div className="layout-header">
                    {headerEditing ? (
                        <div className="layout-header-edit">
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                disabled={busy}
                                className="layout-header-name-input"
                            />
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={2}
                                disabled={busy}
                            />
                            <div className="layout-header-actions">
                                <button onClick={saveHeader} disabled={busy}>
                                    Save
                                </button>
                                <button
                                    onClick={() => {
                                        setHeaderEditing(false);
                                        setName(layout.name);
                                        setDescription(layout.description ?? "");
                                    }}
                                    disabled={busy}
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <h1>
                                {layout.name}
                                {layout.isDefault ? (
                                    <span className="layout-default-pill">default</span>
                                ) : null}
                            </h1>
                            {layout.description ? (
                                <p className="muted">{layout.description}</p>
                            ) : null}
                            <p className="muted">
                                {layout.rows.length} row
                                {layout.rows.length === 1 ? "" : "s"} ·{" "}
                                {layout.profileCount} profile
                                {layout.profileCount === 1 ? "" : "s"}
                            </p>
                        </>
                    )}
                </div>
                <div className="profile-actions">
                    {!headerEditing && (
                        <button onClick={() => setHeaderEditing(true)}>
                            Rename
                        </button>
                    )}
                    <button onClick={deleteLayout} disabled={layout.isDefault}>
                        Delete
                    </button>
                </div>
            </div>

            {error && <div className="error">{error}</div>}

            <h2 className="section-title">Rows</h2>
            {layout.rows.length === 0 ? (
                <p className="muted">No rows yet. Click "+ Add row" to get started.</p>
            ) : (
                <ul className="layout-row-list">
                    {layout.rows.map((row, idx) => (
                        <li key={row.id} className="layout-row-card">
                            <div className="layout-row-info">
                                <div className="layout-row-position">{idx + 1}</div>
                                <div>
                                    <div className="layout-row-title">
                                        {row.title || ROW_TYPE_LABELS[row.type]}
                                    </div>
                                    <div className="muted layout-row-type">
                                        {ROW_TYPE_LABELS[row.type]}
                                        {row.title ? " · custom title" : ""}
                                    </div>
                                    <div className="muted layout-row-config">
                                        {summarizeConfig(row.type, row.config)}
                                    </div>
                                </div>
                            </div>
                            <div className="layout-row-actions">
                                <button
                                    onClick={() => moveRow(idx, -1)}
                                    disabled={busy || idx === 0}
                                    aria-label="Move up"
                                    title="Move up"
                                >
                                    ↑
                                </button>
                                <button
                                    onClick={() => moveRow(idx, 1)}
                                    disabled={busy || idx === layout.rows.length - 1}
                                    aria-label="Move down"
                                    title="Move down"
                                >
                                    ↓
                                </button>
                                <button
                                    onClick={() =>
                                        setEditorModal({ kind: "edit", row })
                                    }
                                    disabled={busy}
                                >
                                    Edit
                                </button>
                                <button
                                    onClick={() => deleteRow(row)}
                                    disabled={busy}
                                >
                                    Delete
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            <button
                className="layout-add-row"
                onClick={() => setEditorModal({ kind: "create" })}
                disabled={busy}
            >
                + Add row
            </button>

            {editorModal.kind !== "closed" && (
                <LayoutRowEditor
                    layoutId={layout.id}
                    row={editorModal.kind === "edit" ? editorModal.row : undefined}
                    onClose={() => setEditorModal({ kind: "closed" })}
                    onSaved={async () => {
                        setEditorModal({ kind: "closed" });
                        await refresh();
                    }}
                />
            )}
        </div>
    );
}

function rowDisplayLabel(row: LayoutRow): string {
    return row.title || ROW_TYPE_LABELS[row.type];
}

// summarizeConfig produces a one-line description of a row's config
// for the list view, so admins can see at a glance what a row does
// without opening the editor.
function summarizeConfig(type: RowType, config: LayoutRowConfig): string {
    const max = (config.max_items as number) ?? 20;
    switch (type) {
        case "tag":
            return `tag #${config.tag_id ?? "?"} · sort=${config.sort ?? "name"} · ${max} items`;
        case "tag_fanout": {
            const inc = (config.include_tag_ids as number[] | undefined)?.length ?? 0;
            const exc = (config.exclude_tag_ids as number[] | undefined)?.length ?? 0;
            return `${inc > 0 ? `${inc} included` : "all tags"}${exc > 0 ? ` · ${exc} excluded` : ""} · row order=${config.row_order ?? "alpha"} · within=${config.within_row_sort ?? "name"} · ${max} items`;
        }
        case "recently_added":
            return `last ${config.lookback_days ?? 30} days · ${max} items`;
        case "watch_again":
            return `dormant ${config.dormant_days ?? 30} days · ${max} items`;
        default:
            return `${max} items`;
    }
}
