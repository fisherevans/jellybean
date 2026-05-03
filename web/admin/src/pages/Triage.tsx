import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
    AGE_TIERS,
    AGE_LABELS,
    type AgeTier,
    api,
    HttpError,
    formatMinAge,
    type Item,
} from "../api";

// Triage primary actions are kid-safe / adult / skip - same shape as M2.
// The granular age tier ("baby content", "preschool", etc.) is a secondary
// row for when the parent wants to be specific. Default kid-safe action
// stamps a generic "kid" age (7) so profile filtering can still operate;
// the user can pick a tier first to override that default.

type UndoEntry = {
    item: Item;
    appliedAge: number | null;
};

// Mapping for shortcut keys: arrows are the primary "kid-safe / adult /
// skip" actions; number keys 1-5 set a specific age tier directly.
const KEY_TO_AGE: Record<string, AgeTier> = {
    "1": 2, "2": 5, "3": 7, "4": 13, "5": 18,
};

const DEFAULT_KID_AGE = 7;

export default function Triage() {
    const [queue, setQueue] = useState<Item[]>([]);
    const [cursor, setCursor] = useState(0);
    const [serverCursor, setServerCursor] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
    const [doneCount, setDoneCount] = useState(0);
    const [exhausted, setExhausted] = useState(false);

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
            setServerCursor(res.NextStartIndex);
            if (!res.HasMore && res.Items.length === 0) setExhausted(true);
        })();
    }, []);

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
        async (age: number | null) => {
            if (!current || busy) return;
            setBusy(true);
            setError(null);
            try {
                await api.setAge(current.Id, age);
                setUndoStack((u) => [...u.slice(-9), { item: current, appliedAge: age }]);
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
            await api.setAge(last.item.Id, null);
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
    }, [undoStack, busy, cursor]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.target instanceof HTMLInputElement) return;
            // Primary actions on arrow keys.
            if (e.key === "ArrowLeft") {
                apply(18); // adult
            } else if (e.key === "ArrowRight") {
                apply(DEFAULT_KID_AGE);
            } else if (e.key === "ArrowDown" || e.key === " ") {
                apply(null);
            } else if (e.key === "z" || e.key === "Z" || e.key === "u" || e.key === "U") {
                undo();
            } else if (KEY_TO_AGE[e.key] !== undefined) {
                // Secondary: number keys jump straight to a specific age tier.
                apply(KEY_TO_AGE[e.key]);
            }
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

    const posterURL = current.ImageTags?.Primary
        ? `/api/admin/items/${current.Id}/image?type=Primary&width=400`
        : null;
    const backdropURL = `/api/admin/items/${current.Id}/image?type=Backdrop&width=1280`;

    return (
        <div className="page triage">
            <div className="triage-counter muted">
                {doneCount} done · {queue.length - cursor} remaining in queue
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
                                guess: <strong>{formatMinAge(current.Suggestion.minAge)}</strong>{" "}
                                ({Math.round(current.Suggestion.confidence * 100)}%)
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
                    onClick={() => apply(18)}
                    disabled={busy}
                    className="cat-button cat-adult primary-action"
                    title="Left arrow"
                >
                    ← Adult / not for kids
                </button>
                <button
                    onClick={() => apply(null)}
                    disabled={busy}
                    className="cat-button cat-uncategorized primary-action"
                    title="Down arrow"
                >
                    ↓ Skip
                </button>
                <button
                    onClick={() => apply(DEFAULT_KID_AGE)}
                    disabled={busy}
                    className="cat-button cat-kid primary-action"
                    title="Right arrow"
                >
                    Kid-safe →
                </button>
                <button onClick={undo} disabled={undoStack.length === 0 || busy}>
                    Z Undo ({undoStack.length})
                </button>
            </div>

            <div className="triage-tier-row">
                <span className="muted">Be specific (overrides Kid-safe default of {DEFAULT_KID_AGE}+):</span>
                {AGE_TIERS.map((age, i) => (
                    <button
                        key={age}
                        onClick={() => apply(age)}
                        disabled={busy}
                        className={`cat-button cat-${age < 13 ? "kid" : "adult"} secondary-action`}
                        title={`${i + 1} key · ${AGE_LABELS[age as AgeTier]}`}
                    >
                        {age === 18 ? "18+" : `${age}+`}
                    </button>
                ))}
            </div>

            <p className="muted">
                Keyboard: ← adult · → kid-safe (default {DEFAULT_KID_AGE}+) · ↓ skip · Z undo · 1-5 specific tier
            </p>
        </div>
    );
}
