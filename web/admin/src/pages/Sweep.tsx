import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, formatState, typeFilterParam, type Item, type ItemState } from "../api";
import { useActiveProfile } from "../activeProfile";
import { useTypeFilter } from "../useTypeFilter";
import ItemCard from "../ItemCard";
import PreviewModal from "../PreviewModal";
import TypeFilterPicker from "../TypeFilter";

// Sweep loads items that have no state for the active profile and groups
// them by the AI's suggestion: looks visible / needs review / looks hidden.
// The user picks visible / hidden / skip per item or in bulk; each profile
// is triaged independently.

type Section = "visible" | "unsure" | "hidden";

const sectionTitles: Record<Section, string> = {
    visible: "Looks visible",
    unsure: "Needs review",
    hidden: "Looks hidden / not for kids",
};

const LEAVE_ANIM_MS = 240;
const UNDO_TOAST_MS = 6000;

type Loaded = {
    items: Item[];
    cursor: number;
    hasMore: boolean;
    total: number;
};

type RecentAction = {
    items: Item[]; // captured Item objects so we can restore them on undo
    state: ItemState;
    timestamp: number;
};

export default function Sweep() {
    const { profile } = useActiveProfile();
    const [typeFilter, setTypeFilter] = useTypeFilter();
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [lastClicked, setLastClicked] = useState<Record<Section, number | null>>({
        visible: null, unsure: null, hidden: null,
    });
    const [leaving, setLeaving] = useState<Set<string>>(new Set());
    const [recentAction, setRecentAction] = useState<RecentAction | null>(null);
    const [previewItem, setPreviewItem] = useState<Item | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    async function loadInitial() {
        if (!profile) return;
        setError(null);
        try {
            const res = await api.listItems({
                profileId: profile.id,
                state: "unset",
                suggest: true,
                limit: 200,
                type: typeFilterParam(typeFilter),
            });
            setLoaded({
                items: res.Items,
                cursor: res.NextStartIndex,
                hasMore: res.HasMore,
                total: res.TotalRecordCount,
            });
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        }
    }

    useEffect(() => {
        loadInitial();
        setSelected(new Set());
        setLeaving(new Set());
        setRecentAction(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile?.id, typeFilter]);

    async function loadMore() {
        if (!loaded || !loaded.hasMore || busy || !profile) return;
        setBusy(true);
        try {
            const res = await api.listItems({
                profileId: profile.id,
                state: "unset",
                suggest: true,
                limit: 200,
                startIndex: loaded.cursor,
                type: typeFilterParam(typeFilter),
            });
            setLoaded({
                items: [...loaded.items, ...res.Items],
                cursor: res.NextStartIndex,
                hasMore: res.HasMore,
                total: res.TotalRecordCount,
            });
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    const sections = useMemo<Record<Section, Item[]>>(() => {
        const out: Record<Section, Item[]> = { visible: [], unsure: [], hidden: [] };
        if (!loaded) return out;
        for (const it of loaded.items) {
            const bucket = (it.Suggestion?.bucket ?? "unsure") as Section;
            out[bucket].push(it);
        }
        return out;
    }, [loaded]);

    function handleSelect(section: Section, index: number, e: React.MouseEvent) {
        if (!loaded) return;
        const list = sections[section];
        const item = list[index];
        const next = new Set(selected);
        const last = lastClicked[section];

        if (e.shiftKey && last !== null) {
            const [from, to] = last < index ? [last, index] : [index, last];
            for (let i = from; i <= to; i++) next.add(list[i].Id);
        } else if (next.has(item.Id)) {
            next.delete(item.Id);
        } else {
            next.add(item.Id);
        }
        setSelected(next);
        setLastClicked({ ...lastClicked, [section]: index });
    }

    function selectAllInSection(section: Section) {
        const next = new Set(selected);
        for (const it of sections[section]) next.add(it.Id);
        setSelected(next);
    }

    function deselectAllInSection(section: Section) {
        const next = new Set(selected);
        for (const it of sections[section]) next.delete(it.Id);
        setSelected(next);
    }

    function clearSelection() {
        setSelected(new Set());
    }

    // After an action: schedule the leaving animation and the undo toast.
    const scheduleRemoval = useCallback(
        (items: Item[], state: ItemState) => {
            const ids = new Set(items.map((it) => it.Id));
            setLeaving((prev) => {
                const next = new Set(prev);
                for (const id of ids) next.add(id);
                return next;
            });
            // After the CSS transition, drop the items from the loaded list.
            setTimeout(() => {
                setLoaded((cur) =>
                    cur
                        ? { ...cur, items: cur.items.filter((it) => !ids.has(it.Id)) }
                        : cur,
                );
                setLeaving((prev) => {
                    const next = new Set(prev);
                    for (const id of ids) next.delete(id);
                    return next;
                });
            }, LEAVE_ANIM_MS);

            // Drop them from the active selection.
            setSelected((prev) => {
                const next = new Set(prev);
                for (const id of ids) next.delete(id);
                return next;
            });

            // Show / replace the undo toast.
            const stamp = Date.now();
            setRecentAction({ items, state, timestamp: stamp });
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
            toastTimerRef.current = setTimeout(() => {
                setRecentAction((cur) => (cur && cur.timestamp === stamp ? null : cur));
                toastTimerRef.current = null;
            }, UNDO_TOAST_MS);
        },
        [],
    );

    async function applyToOne(item: Item, state: ItemState) {
        if (!loaded || !profile) return;
        setBusy(true);
        setError(null);
        try {
            await api.setState(item.Id, profile.id, state);
            scheduleRemoval([item], state);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function applyBulk(state: ItemState) {
        if (selected.size === 0 || !loaded || !profile) return;
        const affected = loaded.items.filter((it) => selected.has(it.Id));
        if (affected.length === 0) return;
        setBusy(true);
        setError(null);
        try {
            await api.bulkSetState(affected.map((it) => it.Id), profile.id, state);
            scheduleRemoval(affected, state);
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function undoRecent() {
        if (!recentAction || !profile) return;
        const { items } = recentAction;
        setBusy(true);
        setError(null);
        try {
            await api.bulkSetState(items.map((it) => it.Id), profile.id, null);
            // Restore the items into the local list (avoid a refetch).
            setLoaded((cur) => {
                if (!cur) return cur;
                const present = new Set(cur.items.map((it) => it.Id));
                const fresh = items.filter((it) => !present.has(it.Id));
                return { ...cur, items: [...fresh, ...cur.items] };
            });
            setRecentAction(null);
            if (toastTimerRef.current) {
                clearTimeout(toastTimerRef.current);
                toastTimerRef.current = null;
            }
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    function dismissToast() {
        setRecentAction(null);
        if (toastTimerRef.current) {
            clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
        }
    }

    if (!profile) {
        return (
            <div className="page">
                <h1>Sweep</h1>
                <p>No profile selected. <Link to="/profiles">Create or pick one</Link>.</p>
            </div>
        );
    }
    if (!loaded) {
        return (
            <div className="page">
                <h1>Sweep</h1>
                {error ? <div className="error">{error}</div> : <p>Loading library...</p>}
            </div>
        );
    }

    return (
        <div className="page sweep">
            <h1>Sweep</h1>
            <div className="sweep-controls">
                <TypeFilterPicker value={typeFilter} onChange={setTypeFilter} busy={busy} />
                <span className="muted">
                    Triaging for <strong>{profile.name}</strong>. Loaded{" "}
                    {loaded.items.length} of {loaded.total} unset items.
                    {loaded.hasMore && (
                        <>
                            {" "}
                            <button onClick={loadMore} disabled={busy}>
                                Load 200 more
                            </button>
                        </>
                    )}
                </span>
            </div>

            {error && <div className="error">{error}</div>}

            <div className="bulk-bar">
                <span>{selected.size} selected for {profile.name}:</span>
                <button
                    disabled={selected.size === 0 || busy}
                    onClick={() => applyBulk("visible")}
                    className="cat-button cat-visible"
                >
                    Mark visible
                </button>
                <button
                    disabled={selected.size === 0 || busy}
                    onClick={() => applyBulk("hidden")}
                    className="cat-button cat-hidden"
                >
                    Mark hidden
                </button>
                <button
                    disabled={selected.size === 0 || busy}
                    onClick={clearSelection}
                >
                    Clear selection
                </button>
            </div>

            <div className="sweep-columns">
                {(["visible", "unsure", "hidden"] as Section[]).map((section) => (
                    <div className="sweep-column" key={section}>
                        <div className="sweep-column-header">
                            <h2>{sectionTitles[section]}</h2>
                            <span className="muted">{sections[section].length}</span>
                            {sections[section].length > 0 && (
                                <>
                                    <button
                                        onClick={() => selectAllInSection(section)}
                                        className="link-button"
                                    >
                                        select all
                                    </button>
                                    <button
                                        onClick={() => deselectAllInSection(section)}
                                        className="link-button"
                                    >
                                        deselect all
                                    </button>
                                </>
                            )}
                        </div>
                        <ul className="sweep-list">
                            {sections[section].map((it, i) => (
                                <li key={it.Id}>
                                    <ItemCard
                                        item={it}
                                        selected={selected.has(it.Id)}
                                        onSelect={(e) => handleSelect(section, i, e)}
                                        onStateChange={(s) => applyToOne(it, s)}
                                        onPreview={setPreviewItem}
                                        busy={busy}
                                        showSuggestion
                                        leaving={leaving.has(it.Id)}
                                        fixedHeight
                                        expectedLanguage={profile?.defaultLanguage}
                                    />
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>

            {recentAction && (
                <div className="undo-toast" role="status">
                    <span className="undo-toast-message">
                        Marked <strong>{recentAction.items.length}</strong> as{" "}
                        <strong>{formatState(recentAction.state)}</strong>
                    </span>
                    <button onClick={undoRecent} disabled={busy}>
                        Undo
                    </button>
                    <button className="undo-dismiss" onClick={dismissToast}>
                        ✕
                    </button>
                </div>
            )}
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
