import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Item } from "../api";

// Tinder-style triage. One uncategorized item at a time, keyboard nav for
// fast burndown. Undo stack is in-memory (last 10) and re-applies the
// previous category via the same set-category endpoint.

type UndoEntry = {
    item: Item;
    appliedCategory: Item["Category"];
};

export default function Triage() {
    const [queue, setQueue] = useState<Item[]>([]);
    const [cursor, setCursor] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
    const [doneCount, setDoneCount] = useState(0);
    const [exhausted, setExhausted] = useState(false);

    // Pre-fetch 50 items at a time. When we run out, fetch the next batch.
    async function fetchBatch(startIndex: number) {
        try {
            const res = await api.listItems({
                category: "uncategorized",
                suggest: true,
                limit: 50,
                startIndex,
            });
            return res;
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
            return null;
        }
    }

    useEffect(() => {
        (async () => {
            const res = await fetchBatch(0);
            if (!res) return;
            setQueue(res.Items);
            if (res.Items.length === 0) setExhausted(true);
        })();
    }, []);

    const current = queue[cursor];

    const advance = useCallback(async () => {
        if (cursor + 5 >= queue.length && queue.length > 0 && !busy && !exhausted) {
            // Refill the queue ahead of time.
            const last = queue[queue.length - 1];
            // We don't know last's Jellyfin position; pass 0 to refetch from
            // the start of remaining uncategorized. The categorized items
            // are excluded server-side, so previously-acted items don't
            // come back. (Cursor handoff in the API is by Jellyfin index;
            // refetching from 0 is correct since acted-on items are now
            // categorized and excluded.)
            const res = await fetchBatch(0);
            if (res) {
                // Keep items we haven't acted on yet, append fresh ones we
                // don't already have.
                const seen = new Set(queue.map((q) => q.Id));
                const fresh = res.Items.filter((i) => !seen.has(i.Id));
                if (fresh.length === 0 && !res.HasMore) setExhausted(true);
                setQueue([...queue, ...fresh]);
            }
            void last;
        }
        setCursor(cursor + 1);
    }, [cursor, queue, busy, exhausted]);

    const apply = useCallback(
        async (category: Item["Category"]) => {
            if (!current || busy) return;
            setBusy(true);
            setError(null);
            try {
                await api.setCategory(current.Id, category);
                setUndoStack((u) => [
                    ...u.slice(-9),
                    { item: current, appliedCategory: category },
                ]);
                setDoneCount((n) => n + 1);
                await advance();
            } catch (err) {
                setError(err instanceof HttpError ? err.message : String(err));
            } finally {
                setBusy(false);
            }
        },
        [current, busy, advance],
    );

    const undo = useCallback(async () => {
        const last = undoStack[undoStack.length - 1];
        if (!last || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.setCategory(last.item.Id, "uncategorized");
            setUndoStack((u) => u.slice(0, -1));
            setDoneCount((n) => Math.max(0, n - 1));
            // Push the item back onto the queue at the current cursor.
            setQueue((q) => {
                const copy = q.slice();
                copy.splice(cursor, 0, last.item);
                return copy;
            });
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [undoStack, busy, cursor]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.target instanceof HTMLInputElement) return;
            if (e.key === "ArrowLeft") apply("adult");
            else if (e.key === "ArrowRight") apply("kid");
            else if (e.key === "ArrowDown" || e.key === " ") apply("uncategorized");
            else if (e.key === "z" || e.key === "Z" || e.key === "u" || e.key === "U") undo();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [apply, undo]);

    if (error) return <div className="page"><div className="error">{error}</div></div>;

    if (!current) {
        return (
            <div className="page">
                <h1>Triage</h1>
                <p>All caught up. <Link to="/sweep">Back to sweep</Link>.</p>
                <p className="muted">{doneCount} item(s) categorized this session.</p>
            </div>
        );
    }

    const meta: string[] = [];
    if (current.ProductionYear) meta.push(String(current.ProductionYear));
    if (current.OfficialRating) meta.push(current.OfficialRating);

    return (
        <div className="page triage">
            <div className="triage-counter muted">
                {doneCount} done · {queue.length - cursor} remaining in queue
            </div>

            <div className="triage-card">
                <h1>{current.Name}</h1>
                {meta.length > 0 && <div className="muted">{meta.join(" · ")}</div>}
                {current.Studios && current.Studios.length > 0 && (
                    <div className="muted">
                        {current.Studios.map((s) => s.Name).join(", ")}
                    </div>
                )}
                {current.Suggestion && (
                    <div className={`triage-suggestion sugg-${current.Suggestion.category}`}>
                        guess: <strong>{current.Suggestion.category}</strong> (
                        {Math.round(current.Suggestion.confidence * 100)}%)
                        {current.Suggestion.reasoning?.length ? (
                            <span> — {current.Suggestion.reasoning.join("; ")}</span>
                        ) : null}
                    </div>
                )}
            </div>

            <div className="triage-actions">
                <button onClick={() => apply("adult")} disabled={busy} className="cat-button cat-adult">
                    ← Adult
                </button>
                <button
                    onClick={() => apply("uncategorized")}
                    disabled={busy}
                    className="cat-button cat-uncategorized"
                >
                    ↓ Skip
                </button>
                <button onClick={() => apply("kid")} disabled={busy} className="cat-button cat-kid">
                    Kid →
                </button>
                <button onClick={undo} disabled={undoStack.length === 0 || busy}>
                    Z Undo ({undoStack.length})
                </button>
            </div>

            <p className="muted">
                Keyboard: ← adult, → kid, ↓ skip, Z undo
            </p>
        </div>
    );
}
