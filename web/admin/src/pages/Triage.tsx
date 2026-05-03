import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Item, type ItemState } from "../api";
import { useActiveProfile } from "../activeProfile";

// Tinder-style triage. One unset item at a time for the active profile,
// keyboard-first: ← hide, → visible, ↓ skip (leave unset), Z undo.

type UndoEntry = {
    item: Item;
    appliedState: ItemState;
};

export default function Triage() {
    const { profile } = useActiveProfile();
    const [queue, setQueue] = useState<Item[]>([]);
    const [cursor, setCursor] = useState(0);
    const [serverCursor, setServerCursor] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
    const [doneCount, setDoneCount] = useState(0);
    const [exhausted, setExhausted] = useState(false);

    async function fetchBatch(startIndex: number) {
        if (!profile) return null;
        try {
            const res = await api.listItems({
                profileId: profile.id,
                state: "unset",
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
        setQueue([]);
        setCursor(0);
        setServerCursor(0);
        setUndoStack([]);
        setDoneCount(0);
        setExhausted(false);
        if (!profile) return;
        (async () => {
            const res = await fetchBatch(0);
            if (!res) return;
            setQueue(res.Items);
            setServerCursor(res.NextStartIndex);
            if (!res.HasMore && res.Items.length === 0) setExhausted(true);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile?.id]);

    const current = queue[cursor];

    const advance = useCallback(async () => {
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
        setCursor(cursor + 1);
    }, [cursor, queue, busy, exhausted, serverCursor]);

    const apply = useCallback(
        async (state: ItemState) => {
            if (!current || busy || !profile) return;
            setBusy(true);
            setError(null);
            try {
                await api.setState(current.Id, profile.id, state);
                setUndoStack((u) => [...u.slice(-9), { item: current, appliedState: state }]);
                setDoneCount((n) => n + 1);
                await advance();
            } catch (err) {
                setError(err instanceof HttpError ? err.message : String(err));
            } finally {
                setBusy(false);
            }
        },
        [current, busy, advance, profile],
    );

    const undo = useCallback(async () => {
        const last = undoStack[undoStack.length - 1];
        if (!last || busy || !profile) return;
        setBusy(true);
        setError(null);
        try {
            await api.setState(last.item.Id, profile.id, null);
            setUndoStack((u) => u.slice(0, -1));
            setDoneCount((n) => Math.max(0, n - 1));
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
    }, [undoStack, busy, cursor, profile]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.target instanceof HTMLInputElement) return;
            if (e.key === "ArrowLeft") apply("hidden");
            else if (e.key === "ArrowRight") apply("visible");
            else if (e.key === "ArrowDown" || e.key === " ") apply(null);
            else if (e.key === "z" || e.key === "Z" || e.key === "u" || e.key === "U") undo();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [apply, undo]);

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
        return (
            <div className="page">
                <h1>Triage</h1>
                <p>All caught up for <strong>{profile.name}</strong>.{" "}
                <Link to="/sweep">Back to sweep</Link>.</p>
                <p className="muted">{doneCount} item(s) categorized this session.</p>
            </div>
        );
    }

    const meta: string[] = [];
    if (current.ProductionYear) meta.push(String(current.ProductionYear));
    if (current.OfficialRating) meta.push(current.OfficialRating);

    const posterURL = current.ImageTags?.Primary
        ? `/api/admin/items/${current.Id}/image?type=Primary&width=400`
        : null;
    const backdropURL = `/api/admin/items/${current.Id}/image?type=Backdrop&width=1280`;

    return (
        <div className="page triage">
            <div className="triage-counter muted">
                Triaging for <strong>{profile.name}</strong> · {doneCount} done ·{" "}
                {queue.length - cursor} remaining in queue
            </div>

            <div className="triage-card">
                <img
                    className="triage-backdrop"
                    src={backdropURL}
                    alt=""
                    onError={(e) => (e.currentTarget.style.display = "none")}
                />
                <div className="triage-content">
                    {posterURL ? (
                        <img className="triage-poster" src={posterURL} alt="" />
                    ) : (
                        <div className="triage-poster placeholder">no poster</div>
                    )}
                    <div className="triage-info">
                        <h1>{current.Name}</h1>
                        {meta.length > 0 && <div className="muted">{meta.join(" · ")}</div>}
                        {current.Studios && current.Studios.length > 0 && (
                            <div className="muted">
                                {current.Studios.map((s) => s.Name).join(", ")}
                            </div>
                        )}
                        {current.Suggestion && (
                            <div className={`triage-suggestion sugg-${current.Suggestion.bucket}`}>
                                guess: <strong>{current.Suggestion.bucket}</strong> (
                                {Math.round(current.Suggestion.confidence * 100)}%)
                                {current.Suggestion.reasoning?.length ? (
                                    <span> — {current.Suggestion.reasoning.join("; ")}</span>
                                ) : null}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="triage-actions">
                <button
                    onClick={() => apply("hidden")}
                    disabled={busy}
                    className="cat-button cat-hidden primary-action"
                    title="Left arrow"
                >
                    ← Hide
                </button>
                <button
                    onClick={() => apply(null)}
                    disabled={busy}
                    className="cat-button cat-unset primary-action"
                    title="Down arrow"
                >
                    ↓ Skip
                </button>
                <button
                    onClick={() => apply("visible")}
                    disabled={busy}
                    className="cat-button cat-visible primary-action"
                    title="Right arrow"
                >
                    Show →
                </button>
                <button onClick={undo} disabled={undoStack.length === 0 || busy}>
                    Z Undo ({undoStack.length})
                </button>
            </div>

            <p className="muted">
                Keyboard: ← hide · → show · ↓ skip · Z undo
            </p>
        </div>
    );
}
