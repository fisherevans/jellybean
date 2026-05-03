import { useEffect, useState } from "react";

// Setup is the M1 helper page that lets a parent paste in the kid's API key
// once and stash it in localStorage. The real onboarding flow lands in M2
// (key issuance via the curation web app).
//
// Supports a query-param shortcut so you can open
//   /kids/setup?key=KIDKEY&item=ITEMID
// and be redirected straight into playback.
const KEY_STORAGE = "jellybean.kids.key";

export default function Setup() {
    const [key, setKey] = useState(localStorage.getItem(KEY_STORAGE) ?? "");
    const [itemId, setItemId] = useState("");

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const k = params.get("key");
        const item = params.get("item");
        if (k) {
            localStorage.setItem(KEY_STORAGE, k);
            if (item) {
                window.location.replace(`/kids/play/${encodeURIComponent(item)}`);
            } else {
                setKey(k);
            }
        }
    }, []);

    function save() {
        localStorage.setItem(KEY_STORAGE, key.trim());
    }

    function go() {
        if (!itemId.trim()) return;
        window.location.assign(`/kids/play/${encodeURIComponent(itemId.trim())}`);
    }

    return (
        <div className="setup">
            <h1>Jellybean Kids - setup</h1>
            <p>
                M1 streaming proof. Paste a kid API key (one of the values configured
                via <code>JELLYBEAN_KIDS_KEYS</code>) and an item ID to verify
                playback.
            </p>
            <label>
                Kid API key
                <input value={key} onChange={(e) => setKey(e.target.value)} />
            </label>
            <button onClick={save}>Save key</button>
            <hr />
            <label>
                Jellyfin item id
                <input value={itemId} onChange={(e) => setItemId(e.target.value)} />
            </label>
            <button onClick={go}>Play</button>
        </div>
    );
}
