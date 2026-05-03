import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
    authHeaders,
    getActiveProfile,
    probeAdmin,
    type AdminUser,
    type KidProfile,
} from "./auth";

// Library is currently a stub. The full browse grid + D-pad focus is #20.
// Two paths reach this page:
//
// - Kid path: an active KidProfile is present. The kid's API key resolves
//   profileId server-side; we omit the profileId query param.
// - Admin path: no active profile, but the cookie auths the request. We
//   need ?profileId=N to disambiguate. Without one we punt back to the
//   picker (which gives admin a profile dropdown).

type LibraryItem = {
    Id: string;
    Name: string;
    Type: string;
};

type LibraryResponse = {
    Items: LibraryItem[] | null;
    TotalAvailable?: number;
};

export default function Library() {
    const nav = useNavigate();
    const [searchParams] = useSearchParams();
    const [profile] = useState<KidProfile | null>(() => getActiveProfile());
    const [admin, setAdmin] = useState<AdminUser | null | undefined>(undefined);
    const [items, setItems] = useState<LibraryItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const adminProfileId = searchParams.get("profileId");

    useEffect(() => {
        probeAdmin().then(setAdmin);
    }, []);

    useEffect(() => {
        if (admin === undefined) return;
        // Without a kid profile and without an admin override, send the user
        // back to the picker (which knows how to handle both cases).
        if (!profile && !adminProfileId) {
            nav("/", { replace: true });
            return;
        }
        const url = new URL("/api/kids/library", window.location.origin);
        url.searchParams.set("limit", "24");
        if (adminProfileId) url.searchParams.set("profileId", adminProfileId);
        fetch(url.toString(), {
            credentials: "same-origin",
            headers: authHeaders(),
        })
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(
                        `${res.status} ${res.statusText}: ${await res.text()}`,
                    );
                }
                return (await res.json()) as LibraryResponse;
            })
            .then((data) => setItems(data.Items ?? []))
            .catch((err) => setError(String(err.message ?? err)));
    }, [profile, admin, adminProfileId, nav]);

    if (admin === undefined) return <div className="screen">Loading...</div>;

    const heading =
        profile?.name ??
        (adminProfileId ? `Admin preview: profile ${adminProfileId}` : "Library");

    return (
        <div className="screen">
            <header className="library-header">
                <div>
                    <h1>{heading}</h1>
                    <p className="library-sub">
                        Library browse UI lands with #20. For now: tap any
                        title to play.
                    </p>
                </div>
                <Link to="/" className="picker-link">
                    {profile ? "switch profile" : "back"}
                </Link>
            </header>

            {error && <p className="error">{error}</p>}
            {!items && !error && <p>Loading library...</p>}
            {items && items.length === 0 && (
                <p>
                    No visible items for this profile. Mark some content
                    visible in the parent web app's curation UI.
                </p>
            )}
            {items && items.length > 0 && (
                <ul className="library-list">
                    {items.map((it) => (
                        <li key={it.Id}>
                            <Link to={`/play/${encodeURIComponent(it.Id)}`}>
                                <span className="library-type">{it.Type}</span>{" "}
                                {it.Name}
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
