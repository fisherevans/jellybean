import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, typeFilterParam, type Item, type ItemState } from "../api";
import { useActiveProfile } from "../activeProfile";
import { useTypeFilter } from "../useTypeFilter";
import PreviewModal from "../PreviewModal";
import TypeFilterPicker from "../TypeFilter";

// Triage as a Tinder-style card stack:
//
//   ←  hide  (red flash, ✕ symbol, swipe-left)
//   →  show  (green flash, ✓ symbol, swipe-right)
//   ↓  skip  (yellow flash, ↓ symbol, swipe-down)
//   ↑  back  (no flash color, undo last action)
//
// Pointer events handle mouse + touch + pen so dragging works on a phone
// or a trackpad. The card under the active one peeks through to make the
// stack feel like real cards.

type SwipeDir = "left" | "right" | "down" | "up";
type SwipeAnim = SwipeDir | "up-incoming";
type Action = SwipeDir;

const DRAG_THRESHOLD = 80; // px before a release commits to an action
const ANIM_MS = 280;

type UndoEntry = {
    item: Item;
    appliedState: ItemState;
};

function actionToState(action: Action): ItemState | "undo" {
    switch (action) {
        case "left": return "hidden";
        case "right": return "visible";
        case "down": return null;
        case "up": return "undo";
    }
}

function flashColor(dir: SwipeDir): string {
    switch (dir) {
        case "right": return "flash-green";
        case "left": return "flash-red";
        case "down": return "flash-yellow";
        case "up": return "flash-neutral";
    }
}

function flashSymbol(dir: SwipeDir): string {
    switch (dir) {
        case "right": return "✓";
        case "left": return "✕";
        case "down": return "↓";
        case "up": return "↶";
    }
}

export default function Triage() {
    const { profile } = useActiveProfile();
    const [typeFilter, setTypeFilter] = useTypeFilter();
    const [queue, setQueue] = useState<Item[]>([]);
    const [cursor, setCursor] = useState(0);
    const [serverCursor, setServerCursor] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
    const [doneCount, setDoneCount] = useState(0);
    const [exhausted, setExhausted] = useState(false);

    const [swipe, setSwipe] = useState<SwipeAnim | null>(null);
    const [flash, setFlash] = useState<SwipeDir | null>(null);
    const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
    const [previewItem, setPreviewItem] = useState<Item | null>(null);
    const dragRef = useRef<{ startX: number; startY: number } | null>(null);

    async function fetchBatch(startIndex: number) {
        if (!profile) return null;
        try {
            const res = await api.listItems({
                profileId: profile.id,
                state: "unset",
                suggest: true,
                limit: 50,
                startIndex,
                type: typeFilterParam(typeFilter),
            });
            return res;
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
            return null;
        }
    }

    useEffect(() => {
        setQueue([]);
        setCursor(0);
        setServerCursor(0);
        setUndoStack([]);
        setDoneCount(0);
        setExhausted(false);
        setSwipe(null);
        setFlash(null);
        setDragOffset(null);
        if (!profile) return;
        (async () => {
            const res = await fetchBatch(0);
            if (!res) return;
            setQueue(res.Items);
            setServerCursor(res.NextStartIndex);
            if (!res.HasMore && res.Items.length === 0) setExhausted(true);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile?.id, typeFilter]);

    const current = queue[cursor];
    const upcoming = queue[cursor + 1];

    const refillIfNeeded = useCallback(async () => {
        if (cursor + 5 >= queue.length && queue.length > 0 && !busy && !exhausted) {
            const res = await fetchBatch(serverCursor);
            if (res) {
                const seen = new Set(queue.map((q) => q.Id));
                const fresh = res.Items.filter((i) => !seen.has(i.Id));
                setQueue([...queue, ...fresh]);
                setServerCursor(res.NextStartIndex);
                if (!res.HasMore && fresh.length === 0) setExhausted(true);
            }
        }
    }, [cursor, queue, busy, exhausted, serverCursor]);

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const doForward = useCallback(
        async (dir: SwipeDir, state: ItemState) => {
            if (!current || !profile) return;
            setBusy(true);
            setError(null);
            setSwipe(dir);
            setFlash(dir);
            try {
                await api.setState(current.Id, profile.id, state);
                setUndoStack((u) => [...u.slice(-9), { item: current, appliedState: state }]);
                setDoneCount((n) => n + 1);
                await sleep(ANIM_MS);
                setSwipe(null);
                setFlash(null);
                setDragOffset(null);
                setCursor((c) => c + 1);
                await refillIfNeeded();
            } catch (err) {
                setError(err instanceof HttpError ? err.message : String(err));
                setSwipe(null);
                setFlash(null);
                setDragOffset(null);
            } finally {
                setBusy(false);
            }
        },
        [current, profile, refillIfNeeded],
    );

    const doUndo = useCallback(async () => {
        const last = undoStack[undoStack.length - 1];
        if (!last || !profile) return;
        setBusy(true);
        setError(null);
        // Trigger the up-flash without translating the current card:
        // undo conceptually drops the previous one back from above.
        setFlash("up");
        try {
            await api.setState(last.item.Id, profile.id, null);
            setUndoStack((u) => u.slice(0, -1));
            setDoneCount((n) => Math.max(0, n - 1));
            // Insert the recovered item at cursor so it becomes current.
            setQueue((q) => {
                const copy = q.slice();
                copy.splice(cursor, 0, last.item);
                return copy;
            });
            // Brief flash, then snap to the recovered card.
            setSwipe("up-incoming"); // CSS handles a brief slide-down-from-top
            await sleep(ANIM_MS);
            setSwipe(null);
            setFlash(null);
            setDragOffset(null);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
            setSwipe(null);
            setFlash(null);
        } finally {
            setBusy(false);
        }
    }, [undoStack, profile, cursor]);

    const performAction = useCallback(
        (action: Action) => {
            if (busy) return;
            const state = actionToState(action);
            if (state === "undo") {
                doUndo();
                return;
            }
            doForward(action, state);
        },
        [busy, doForward, doUndo],
    );

    // Keyboard
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.target instanceof HTMLInputElement) return;
            if (e.key === "ArrowLeft") performAction("left");
            else if (e.key === "ArrowRight") performAction("right");
            else if (e.key === "ArrowDown" || e.key === " ") performAction("down");
            else if (e.key === "ArrowUp") performAction("up");
            else if (e.key === "z" || e.key === "Z" || e.key === "u" || e.key === "U") performAction("up");
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [performAction]);

    // Pointer drag
    function onPointerDown(e: React.PointerEvent) {
        if (busy || swipe) return;
        // Don't capture drag when the user clicked an interactive element
        // inside the card (the action buttons handle their own clicks).
        if ((e.target as HTMLElement).closest("button")) return;
        dragRef.current = { startX: e.clientX, startY: e.clientY };
        setDragOffset({ x: 0, y: 0 });
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    function onPointerMove(e: React.PointerEvent) {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setDragOffset({ x: dx, y: dy });
    }

    function onPointerUp(e: React.PointerEvent) {
        if (!dragRef.current) return;
        const start = dragRef.current;
        dragRef.current = null;
        const dx = e.clientX - start.startX;
        const dy = e.clientY - start.startY;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);

        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (absX < DRAG_THRESHOLD && absY < DRAG_THRESHOLD) {
            // Snap back.
            setDragOffset(null);
            return;
        }
        if (absX > absY) {
            performAction(dx > 0 ? "right" : "left");
        } else {
            performAction(dy > 0 ? "down" : "up");
        }
    }

    if (!profile) {
        return (
            <div className="page">
                <h1>Triage</h1>
                <p>No profile selected. <Link to="/profiles">Pick or create one</Link>.</p>
            </div>
        );
    }
    if (error) return <div className="page"><div className="error">{error}</div></div>;

    if (!current) {
        if (!exhausted) {
            return (
                <div className="page">
                    <h1>Triage</h1>
                    <p className="muted">Loading items for <strong>{profile.name}</strong>…</p>
                </div>
            );
        }
        return (
            <div className="page">
                <h1>Triage</h1>
                <p>All caught up for <strong>{profile.name}</strong>.{" "}
                <Link to="/sweep">Back to sweep</Link>.</p>
                <p className="muted">{doneCount} item(s) categorized this session.</p>
            </div>
        );
    }

    const cardTransform = (() => {
        if (swipe === "left") return "translate(-130%, 0) rotate(-18deg)";
        if (swipe === "right") return "translate(130%, 0) rotate(18deg)";
        if (swipe === "down") return "translate(0, 130%)";
        if (swipe === "up-incoming") return "translate(0, 0)";
        if (dragOffset) {
            const rot = (dragOffset.x / window.innerWidth) * 25;
            return `translate(${dragOffset.x}px, ${dragOffset.y}px) rotate(${rot}deg)`;
        }
        return undefined;
    })();

    const cardOpacity = swipe && swipe !== "up-incoming" ? 0 : 1;

    return (
        <div className="page triage">
            <div className="triage-controls">
                <TypeFilterPicker value={typeFilter} onChange={setTypeFilter} busy={busy} />
                <span className="muted">
                    Triaging for <strong>{profile.name}</strong> · {doneCount} done ·{" "}
                    {queue.length - cursor} remaining
                </span>
            </div>

            <div className="triage-stack">
                {upcoming && (
                    <Card
                        item={upcoming}
                        className="triage-card behind"
                        interactive={false}
                        expectedLanguage={profile?.defaultLanguage}
                    />
                )}
                <Card
                    key={current.Id}
                    item={current}
                    className={`triage-card front swipe-${swipe ?? "idle"}`}
                    style={{
                        transform: cardTransform,
                        opacity: cardOpacity,
                        transition: dragOffset && !swipe ? "none" : `transform ${ANIM_MS}ms ease-out, opacity ${ANIM_MS}ms`,
                    }}
                    interactive={!busy && !swipe}
                    showSuggestion
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onPreview={() => setPreviewItem(current)}
                    expectedLanguage={profile?.defaultLanguage}
                />
                {flash && (
                    <div className={`triage-flash ${flashColor(flash)}`}>
                        <span className="triage-flash-symbol">{flashSymbol(flash)}</span>
                    </div>
                )}
            </div>

            <div className="triage-actions">
                <button
                    onClick={() => performAction("left")}
                    disabled={busy}
                    className="cat-button cat-hidden primary-action"
                    title="Left arrow"
                >
                    ← Hide
                </button>
                <button
                    onClick={() => performAction("up")}
                    disabled={busy || undoStack.length === 0}
                    className="cat-button cat-unset primary-action"
                    title="Up arrow"
                >
                    ↑ Back ({undoStack.length})
                </button>
                <button
                    onClick={() => performAction("down")}
                    disabled={busy}
                    className="cat-button cat-unset primary-action"
                    title="Down arrow"
                >
                    ↓ Skip
                </button>
                <button
                    onClick={() => performAction("right")}
                    disabled={busy}
                    className="cat-button cat-visible primary-action"
                    title="Right arrow"
                >
                    Show →
                </button>
            </div>

            <p className="muted">
                Keyboard: ← hide · → show · ↓ skip · ↑ back · or drag the card.
            </p>

            {previewItem && (
                <PreviewModal
                    itemId={previewItem.Id}
                    itemName={previewItem.Name}
                    onClose={() => setPreviewItem(null)}
                />
            )}
        </div>
    );
}

type CardProps = {
    item: Item;
    className: string;
    interactive: boolean;
    showSuggestion?: boolean;
    style?: React.CSSProperties;
    onPointerDown?: (e: React.PointerEvent) => void;
    onPointerMove?: (e: React.PointerEvent) => void;
    onPointerUp?: (e: React.PointerEvent) => void;
    onPointerCancel?: (e: React.PointerEvent) => void;
    onPreview?: () => void;
    expectedLanguage?: string;
};

function Card({
    item,
    className,
    interactive,
    showSuggestion = false,
    style,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPreview,
    expectedLanguage,
}: CardProps) {
    const meta: string[] = [];
    if (item.ProductionYear) meta.push(String(item.ProductionYear));
    if (item.OfficialRating) meta.push(item.OfficialRating);

    const posterURL = item.ImageTags?.Primary
        ? `/api/admin/items/${item.Id}/image?type=Primary&width=400`
        : null;
    const backdropURL = `/api/admin/items/${item.Id}/image?type=Backdrop&width=1280`;
    const expected = (expectedLanguage ?? "").toLowerCase();
    const available = (item.AudioLanguages ?? [])
        .map((l) => l.toLowerCase())
        .filter(Boolean);
    const primary = (item.AudioLanguage ?? "").toLowerCase();
    const langMismatch =
        !!expected && available.length > 0 && !available.includes(expected);
    const lang =
        expected && available.includes(expected) ? expected : primary;
    const cardClass = langMismatch ? `${className} lang-mismatch` : className;

    // Confidence-scaled gradient hint: red bleeding from the left for a
    // "hidden" guess, green bleeding from the right for a "visible" guess.
    // Alpha ramps from a faint floor at 0% confidence up to a heavy tint at
    // 100%. Only painted on the active card; the behind card peeks above
    // the front and its hint would read as a stray colored border.
    const suggestOverlayStyle = (() => {
        if (!showSuggestion) return null;
        if (!item.Suggestion) return null;
        const { bucket, confidence } = item.Suggestion;
        if (bucket === "unsure") return null;
        const c = Math.max(0, Math.min(1, confidence));
        const alpha = 0.1 + 0.7 * c;
        if (bucket === "hidden") {
            return {
                background: `linear-gradient(to right, rgba(229, 83, 129, ${alpha}), rgba(229, 83, 129, 0) 65%)`,
            } as React.CSSProperties;
        }
        return {
            background: `linear-gradient(to left, rgba(6, 214, 160, ${alpha}), rgba(6, 214, 160, 0) 65%)`,
        } as React.CSSProperties;
    })();

    return (
        <div
            className={cardClass}
            style={{ ...style, touchAction: interactive ? "none" : undefined }}
            onPointerDown={interactive ? onPointerDown : undefined}
            onPointerMove={interactive ? onPointerMove : undefined}
            onPointerUp={interactive ? onPointerUp : undefined}
            onPointerCancel={interactive ? onPointerCancel : undefined}
        >
            <img
                className="triage-backdrop"
                src={backdropURL}
                alt=""
                draggable={false}
                onError={(e) => (e.currentTarget.style.display = "none")}
            />
            {suggestOverlayStyle && (
                <div className="triage-suggest-overlay" style={suggestOverlayStyle} />
            )}
            <div className="triage-content">
                <div className="triage-poster-wrap">
                    {posterURL ? (
                        <img className="triage-poster" src={posterURL} alt="" draggable={false} />
                    ) : (
                        <div className="triage-poster placeholder">no poster</div>
                    )}
                    {onPreview && interactive && (
                        <button
                            type="button"
                            className="triage-preview"
                            aria-label={`Preview ${item.Name}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                                e.stopPropagation();
                                onPreview();
                            }}
                        >
                            ▶
                        </button>
                    )}
                </div>
                <div className="triage-info">
                    <h1>{item.Name}</h1>
                    {(meta.length > 0 || lang) && (
                        <div className="muted">
                            {meta.join(" · ")}
                            {lang && (
                                <span
                                    className={`lang-badge ${langMismatch ? "lang-badge-mismatch" : ""}`}
                                    title={
                                        langMismatch
                                            ? `Audio: ${lang}; profile default is ${expected}`
                                            : `Audio: ${lang}`
                                    }
                                >
                                    {lang}
                                </span>
                            )}
                        </div>
                    )}
                    {item.Studios && item.Studios.length > 0 && (
                        <div className="muted">
                            {item.Studios.map((s) => s.Name).join(", ")}
                        </div>
                    )}
                    {item.Suggestion && (
                        <div className={`triage-suggestion sugg-${item.Suggestion.bucket}`}>
                            guess: <strong>{item.Suggestion.bucket}</strong> (
                            {Math.round(item.Suggestion.confidence * 100)}%)
                            {item.Suggestion.reasoning?.length ? (
                                <span> — {item.Suggestion.reasoning.join("; ")}</span>
                            ) : null}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
