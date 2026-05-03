import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError, type Item, type ItemState } from "../api";
import { useActiveProfile } from "../activeProfile";
import ItemCard from "../ItemCard";

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

type Loaded = {
    items: Item[];
    cursor: number;
    hasMore: boolean;
    total: number;
};

export default function Sweep() {
    const { profile } = useActiveProfile();
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [lastClicked, setLastClicked] = useState<Record<Section, number | null>>({
        visible: null, unsure: null, hidden: null,
    });

    async function loadInitial() {
        if (!profile) return;
        setError(null);
        try {
            const res = await api.listItems({
                profileId: profile.id,
                state: "unset",
                suggest: true,
                limit: 200,
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile?.id]);

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

    function clearSelection() {
        setSelected(new Set());
    }

    async function applyBulk(state: ItemState) {
        if (selected.size === 0 || !loaded || !profile) return;
        setBusy(true);
        setError(null);
        try {
            const ids = Array.from(selected);
            await api.bulkSetState(ids, profile.id, state);
            setLoaded({
                ...loaded,
                items: loaded.items.filter((it) => !selected.has(it.Id)),
            });
            setSelected(new Set());
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusy(false);
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
            <p className="muted">
                Triaging for <strong>{profile.name}</strong>. Items shown have no
                visibility decision yet for this profile. Switch profiles in the
                top nav to triage another one. Loaded {loaded.items.length} of{" "}
                {loaded.total}.
                {loaded.hasMore && (
                    <>
                        {" "}
                        <button onClick={loadMore} disabled={busy}>
                            Load 200 more
                        </button>
                    </>
                )}
            </p>

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
                                <button
                                    onClick={() => selectAllInSection(section)}
                                    className="link-button"
                                >
                                    select all
                                </button>
                            )}
                        </div>
                        <ul className="sweep-list">
                            {sections[section].map((it, i) => (
                                <li key={it.Id}>
                                    <ItemCard
                                        item={it}
                                        selected={selected.has(it.Id)}
                                        onSelect={(e) => handleSelect(section, i, e)}
                                        showSuggestion
                                    />
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>
        </div>
    );
}
