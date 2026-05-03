import { useEffect, useState } from "react";
import { setKidKey, getKidKey, probeAdmin, type AdminUser } from "./auth";

// Setup is the M1 helper page. Two flows live here:
//
// - Admin viewing the kids UI: detects an existing /api/auth/me session.
//   No key is needed; we just show a "you're admin, here's an item ID box"
//   shortcut so you can jump into /kids/play/:itemId.
//
// - Kid TV onboarding: paste an API key (one of the values from
//   JELLYBEAN_KIDS_KEYS) and an item ID. Real key issuance / profile
//   provisioning ships with M2.
//
// Supports a query-param shortcut so you can open
//   /kids/setup?key=KIDKEY&item=ITEMID
// and be redirected straight into playback.

export default function Setup() {
    const [admin, setAdmin] = useState<AdminUser | null | undefined>(undefined);
    const [key, setKey] = useState(getKidKey() ?? "");
    const [itemId, setItemId] = useState("");

    useEffect(() => {
        probeAdmin().then(setAdmin);
    }, []);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const k = params.get("key");
        const item = params.get("item");
        if (k) {
            setKidKey(k);
            if (item) {
                window.location.replace(`/kids/play/${encodeURIComponent(item)}`);
            } else {
                setKey(k);
            }
        }
    }, []);

    function saveKey() {
        if (key.trim()) setKidKey(key.trim());
    }

    function go() {
        if (!itemId.trim()) return;
        window.location.assign(`/kids/play/${encodeURIComponent(itemId.trim())}`);
    }

    if (admin === undefined) {
        return <div className="screen">Loading...</div>;
    }

    return (
        <div className="setup">
            <h1>Jellybean Kids - setup</h1>

            {admin ? (
                <p>
                    Signed in as <strong>{admin.name}</strong> (admin). No kid key
                    needed - the cookie authenticates kids endpoints too. Paste an
                    item ID below to jump into playback.
                </p>
            ) : (
                <>
                    <p>
                        Paste a kid API key (one of the values configured via{" "}
                        <code>JELLYBEAN_KIDS_KEYS</code>). Real per-profile key
                        issuance lands with the curation app (M2).
                    </p>
                    <label>
                        Kid API key
                        <input value={key} onChange={(e) => setKey(e.target.value)} />
                    </label>
                    <button onClick={saveKey}>Save key</button>
                    <hr />
                </>
            )}

            <label>
                Jellyfin item id
                <input value={itemId} onChange={(e) => setItemId(e.target.value)} />
            </label>
            <button onClick={go}>Play</button>
        </div>
    );
}
