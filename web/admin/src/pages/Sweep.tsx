import { useEffect, useMemo, useState } from "react";
import { AGE_TIERS, AGE_LABELS, type AgeTier, api, HttpError, type Item } from "../api";
import { bucketForProfile, useActiveProfile, type ProfileBucket } from "../activeProfile";
import ItemCard from "../ItemCard";

// Sweep loads uncategorized items in 200-item pages and groups them by how
// well they match the active profile's age range:
//
//   "fit"    - suggested age is within profile.[minAge..maxAge]
//   "review" - suggested age is below profile.minAge, or no signal at all
//   "adult"  - suggested age is above profile.maxAge
//
// The user picks a specific age tier from the bulk bar; default kid-safe
// stamps profile.minAge so the item ends up at the bottom of the profile's
// range.

const sectionTitles: Record<ProfileBucket, string> = {
    fit: "Looks good for this profile",
    review: "Needs review (off-range or unclear)",
    adult: "Likely too mature / adult",
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
    const [lastClickedByGroup, setLastClickedByGroup] = useState<Record<ProfileBucket, number | null>>({
        fit: null, review: null, adult: null,
    });

    async function loadInitial() {
        setError(null);
        try {
            const res = await api.listItems({
                category: "uncategorized",
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
    }, []);

    async function loadMore() {
        if (!loaded || !loaded.hasMore || busy) return;
        setBusy(true);
        try {
            const res = await api.listItems({
                category: "uncategorized",
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

    const sections = useMemo<Record<ProfileBucket, Item[]>>(() => {
        const out: Record<ProfileBucket, Item[]> = { fit: [], review: [], adult: [] };
        if (!loaded) return out;
        for (const it of loaded.items) {
            const bucket = bucketForProfile(it.Suggestion?.minAge ?? null, profile);
            out[bucket].push(it);
        }
        return out;
    }, [loaded, profile]);

    function handleSelect(section: ProfileBucket, index: number, e: React.MouseEvent) {
        if (!loaded) return;
        const list = sections[section];
        const item = list[index];
        const next = new Set(selected);
        const last = lastClickedByGroup[section];

        if (e.shiftKey && last !== null) {
            const [from, to] = last < index ? [last, index] : [index, last];
            for (let i = from; i <= to; i++) next.add(list[i].Id);
        } else if (next.has(item.Id)) {
            next.delete(item.Id);
        } else {
            next.add(item.Id);
        }
        setSelected(next);
        setLastClickedByGroup({ ...lastClickedByGroup, [section]: index });
    }

    function selectAllInSection(section: ProfileBucket) {
        const next = new Set(selected);
        for (const it of sections[section]) next.add(it.Id);
        setSelected(next);
    }

    function clearSelection() {
        setSelected(new Set());
    }

    async function applyBulk(minAge: number | null) {
        if (selected.size === 0 || !loaded) return;
        setBusy(true);
        setError(null);
        try {
            const ids = Array.from(selected);
            await api.bulkSetAge(ids, minAge);
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

    if (!loaded) {
        return (
            <div className="page">
                <h1>Sweep</h1>
                {error ? <div className="error">{error}</div> : <p>Loading library...</p>}
            </div>
        );
    }

    const profileLabel = profile
        ? `${profile.name} (ages ${profile.minAge}..${profile.maxAge})`
        : "(no profile)";

    return (
        <div className="page sweep">
            <h1>Sweep</h1>
            <p className="muted">
                Loaded {loaded.items.length} of {loaded.total} uncategorized items.
                Grouping is relative to the active profile: <strong>{profileLabel}</strong>.
                Switch profiles in the top nav to see the same items grouped a different way.
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
                <span>{selected.size} selected · mark as:</span>
                {AGE_TIERS.map((age: AgeTier) => (
                    <button
                        key={age}
                        disabled={selected.size === 0 || busy}
                        onClick={() => applyBulk(age)}
                        title={AGE_LABELS[age]}
                        className={`cat-button cat-${age < 13 ? "kid" : "adult"}`}
                    >
                        {age === 18 ? "18+" : `${age}+`}
                    </button>
                ))}
                <button
                    disabled={selected.size === 0 || busy}
                    onClick={() => applyBulk(null)}
                    className="cat-button cat-uncategorized"
                    title="Leave uncategorized but remove from sweep view"
                >
                    Skip
                </button>
                <button disabled={selected.size === 0 || busy} onClick={clearSelection}>
                    Clear
                </button>
            </div>

            <div className="sweep-columns">
                {(["fit", "review", "adult"] as ProfileBucket[]).map((section) => (
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
