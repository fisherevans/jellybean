// TagsStage: edit the tag set for the focused item (or its parent
// series, when the focused item is an episode/season — host scopes
// editTargetId to the show in that case).
//
// Loads the full tag list + the item's current selection on
// mount. Save button stays disabled until the load completes; the
// kid sees a "Loading tags…" placeholder while the request is in
// flight. Save closes the modal entirely on success — there's no
// "done" stage for tag edits because the modal IS the editing
// surface.

import { useEffect, useRef, useState } from "react";
import { Check } from "@phosphor-icons/react";
import { authHeaders } from "../auth";
import { ActionList, BackLink, ModalShell } from "./shell";
import type { StageCtx, Tag } from "./types";

type Props = {
    ctx: StageCtx;
    token: string;
    itemId: string;
    itemName: string;
};

export function TagsStage({ ctx, token, itemId, itemName }: Props) {
    const [allTags, setAllTags] = useState<Tag[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        void (async () => {
            try {
                const res = await fetch(
                    `/api/kids/override/items/${encodeURIComponent(itemId)}/tags${ctx.previewQuery}`,
                    {
                        credentials: "same-origin",
                        headers: {
                            ...authHeaders(),
                            "X-Override-Token": token,
                        },
                    },
                );
                if (!res.ok) throw new Error(`${res.status}`);
                const body = (await res.json()) as {
                    tags: Tag[];
                    selected: number[];
                };
                setAllTags(body.tags);
                setSelected(new Set(body.selected ?? []));
            } catch (err) {
                setError(err instanceof Error ? err.message : "load failed");
            }
        })();
    }, [token, itemId, ctx.previewQuery]);

    async function save() {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(
                `/api/kids/override/items/${encodeURIComponent(itemId)}/tags${ctx.previewQuery}`,
                {
                    method: "PUT",
                    credentials: "same-origin",
                    headers: {
                        ...authHeaders(),
                        "X-Override-Token": token,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ tagIds: [...selected] }),
                },
            );
            if (!res.ok) throw new Error(`${res.status}`);
            ctx.close();
        } catch (err) {
            setError(err instanceof Error ? err.message : "save failed");
        } finally {
            setBusy(false);
        }
    }

    function toggle(id: number) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    return (
        <ModalShell title="Edit tags" subtitle={itemName}>
            {error && <div className="error">{error}</div>}
            {allTags === null ? (
                <p className="muted">Loading tags…</p>
            ) : allTags.length === 0 ? (
                <p className="muted">
                    No tags exist yet. Ask a grown-up to set some up.
                </p>
            ) : (
                <TagGrid
                    tags={allTags}
                    selected={selected}
                    busy={busy}
                    onToggle={toggle}
                />
            )}
            <ActionList
                items={[
                    {
                        key: "save",
                        label: busy ? "Saving…" : "Save",
                        onActivate: save,
                        disabled: busy || allTags === null,
                        autoFocus: allTags !== null && allTags.length === 0,
                    },
                ]}
            />
            <BackLink onActivate={ctx.pop} disabled={busy} />
        </ModalShell>
    );
}

// TagGrid: focusable button-per-tag in a 2-column grid. Up/Down
// moves between rows of the grid; Left/Right between columns.
// Down off the last row hands focus to the Save button below.
// Each button is a real focusable element with role=checkbox so
// the kid's TV remote (D-pad + Enter) can toggle without ever
// needing pointer / tab.
function TagGrid({
    tags,
    selected,
    busy,
    onToggle,
}: {
    tags: Tag[];
    selected: Set<number>;
    busy: boolean;
    onToggle: (id: number) => void;
}) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const COLS = 2;
    useEffect(() => {
        refs.current[0]?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function move(i: number, dRow: number, dCol: number): boolean {
        const row = Math.floor(i / COLS);
        const col = i % COLS;
        const nextRow = row + dRow;
        const nextCol = col + dCol;
        if (nextRow < 0) return false;
        if (nextCol < 0 || nextCol >= COLS) return false;
        const nextI = nextRow * COLS + nextCol;
        if (nextI < 0 || nextI >= tags.length) {
            // Off the end of the grid: try the same column on
            // the previous row to land somewhere useful instead
            // of bouncing.
            if (dRow > 0 && nextRow > row) {
                const lastI = tags.length - 1;
                if (lastI > i) {
                    refs.current[lastI]?.focus();
                    return true;
                }
            }
            return false;
        }
        refs.current[nextI]?.focus();
        return true;
    }

    function onKey(i: number, e: React.KeyboardEvent) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            const moved = move(i, 1, 0);
            if (!moved) {
                // Drop to the Save button below.
                const next = (e.currentTarget.closest(
                    ".override-modal",
                ) as HTMLElement | null)?.querySelector<HTMLButtonElement>(
                    ".override-action-list button:not(:disabled)",
                );
                next?.focus();
            }
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            move(i, -1, 0);
            return;
        }
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            move(i, 0, -1);
            return;
        }
        if (e.key === "ArrowRight") {
            e.preventDefault();
            move(i, 0, 1);
            return;
        }
    }

    return (
        <div className="override-tag-grid" role="group" aria-label="Tags">
            {tags.map((t, i) => {
                const isOn = selected.has(t.id);
                return (
                    <button
                        key={t.id}
                        ref={(el) => (refs.current[i] = el)}
                        type="button"
                        role="checkbox"
                        aria-checked={isOn}
                        disabled={busy}
                        className={`override-tag-chip${isOn ? " on" : ""}`}
                        onClick={() => onToggle(t.id)}
                        onKeyDown={(e) => onKey(i, e)}
                    >
                        <span className="override-tag-chip-mark" aria-hidden>
                            {isOn ? <Check size={14} weight="bold" /> : ""}
                        </span>
                        <span className="override-tag-chip-name">{t.name}</span>
                    </button>
                );
            })}
        </div>
    );
}
