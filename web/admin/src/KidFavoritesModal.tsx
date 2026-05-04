import { useCallback, useEffect, useState } from "react";
import { api, HttpError, type Item, type Kid, type KidFavorite } from "./api";
import Spinner from "./Spinner";

type Props = {
    kid: Kid;
    onClose: () => void;
};

// KidFavoritesModal lists a kid's current favorites + a search picker
// over visible-only items in the kid's profile so the admin can pre-
// seed (or curate) what shows up on the kid's favorites row.
//
// The kid-side heart toggle lands in M9 - this is the admin-only
// surface for M6.
export default function KidFavoritesModal({ kid, onClose }: Props) {
    const [favorites, setFavorites] = useState<KidFavorite[] | null>(null);
    const [picker, setPicker] = useState<Item[]>([]);
    const [search, setSearch] = useState("");
    const [pickerLoading, setPickerLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busyItemId, setBusyItemId] = useState<string | null>(null);

    const refreshFavorites = useCallback(async () => {
        try {
            const res = await api.listKidFavorites(kid.id);
            setFavorites(res.favorites);
        } catch (err) {
            setError(err instanceof Error ? err.message : "load failed");
        }
    }, [kid.id]);

    useEffect(() => {
        refreshFavorites();
    }, [refreshFavorites]);

    // Picker: visible-only items in the kid's profile, optionally
    // search-filtered. Items already in the favorites list are
    // excluded client-side.
    useEffect(() => {
        let cancelled = false;
        setPickerLoading(true);
        api.listItems({
            profileId: kid.profileId,
            state: "visible",
            search,
            limit: 50,
        })
            .then((res) => {
                if (!cancelled) setPicker(res.Items);
            })
            .catch((err) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "load failed");
                }
            })
            .finally(() => {
                if (!cancelled) setPickerLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [kid.profileId, search]);

    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === "Escape") onClose();
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    async function add(itemId: string) {
        if (busyItemId) return;
        setBusyItemId(itemId);
        setError(null);
        try {
            await api.addKidFavorite(kid.id, itemId);
            await refreshFavorites();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusyItemId(null);
        }
    }

    async function remove(itemId: string) {
        if (busyItemId) return;
        setBusyItemId(itemId);
        setError(null);
        try {
            await api.removeKidFavorite(kid.id, itemId);
            await refreshFavorites();
        } catch (err) {
            setError(err instanceof HttpError ? err.message : String(err));
        } finally {
            setBusyItemId(null);
        }
    }

    const favoriteIds = new Set((favorites ?? []).map((f) => f.itemId));

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div
                className="modal modal-wide"
                onClick={(e) => e.stopPropagation()}
            >
                <h2>Favorites for {kid.name}</h2>
                <p className="muted">
                    Profile: {kid.profileName}. Picker shows items currently
                    visible for this profile.
                </p>
                {error && <div className="error">{error}</div>}

                <h3 className="section-title">Currently favorited</h3>
                {favorites === null ? (
                    <Spinner block size={28} label="Loading favorites…" />
                ) : favorites.length === 0 ? (
                    <p className="muted">No favorites yet.</p>
                ) : (
                    <ul className="tag-item-list">
                        {favorites.map((f) => (
                            <li key={f.itemId} className="tag-item-row">
                                <div className="tag-item-info">
                                    <div className="tag-item-name">
                                        {f.name ?? "(item not found)"}
                                    </div>
                                    <div className="muted">
                                        {f.type ?? ""}
                                        {f.productionYear
                                            ? ` · ${f.productionYear}`
                                            : ""}
                                        {f.missing
                                            ? " · missing from Jellyfin"
                                            : f.visible
                                              ? ""
                                              : " · now hidden for this profile"}
                                    </div>
                                </div>
                                <button
                                    onClick={() => remove(f.itemId)}
                                    disabled={busyItemId === f.itemId}
                                >
                                    Remove
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                <h3 className="section-title">Add a favorite</h3>
                <input
                    type="search"
                    value={search}
                    placeholder="Search items…"
                    onChange={(e) => setSearch(e.target.value)}
                    className="add-items-search"
                />
                {pickerLoading ? (
                    <Spinner block size={28} label="Loading items…" />
                ) : (
                    <ul className="tag-item-list">
                        {picker
                            .filter((it) => !favoriteIds.has(it.Id))
                            .map((it) => (
                                <li key={it.Id} className="tag-item-row">
                                    <div className="tag-item-info">
                                        <div className="tag-item-name">
                                            {it.Name}
                                        </div>
                                        <div className="muted">
                                            {it.Type}
                                            {it.ProductionYear
                                                ? ` · ${it.ProductionYear}`
                                                : ""}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => add(it.Id)}
                                        disabled={busyItemId === it.Id}
                                    >
                                        Add
                                    </button>
                                </li>
                            ))}
                        {picker.filter((it) => !favoriteIds.has(it.Id)).length ===
                            0 && (
                            <li className="muted">
                                {search.trim()
                                    ? "No matching visible items."
                                    : "No visible items left to favorite."}
                            </li>
                        )}
                    </ul>
                )}

                <div className="modal-actions">
                    <button type="button" onClick={onClose}>
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}
