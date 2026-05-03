import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
    addProfile,
    listProfiles,
    probeAdmin,
    setActiveKey,
    type AdminUser,
    type KidProfile,
} from "./auth";

// Setup adds another kid profile to this device. Two flows:
//
// - Manual entry: parent types a kid display name + API key from the parent
//   web app, taps Add. New entry appended to localStorage.
//
// - Query-param shortcut: opening
//     /kids/setup?key=KIDKEY&name=KIDNAME[&item=ITEMID]
//   adds the profile, makes it active, then either jumps to playback (when
//   item is present) or returns to the picker. This is the M2 flow that the
//   parent app shares with each TV.
//
// Admin sessions also see a small "test playback by item id" helper so the
// kids UI is testable from a logged-in browser without minting a kid key.

export default function Setup() {
    const nav = useNavigate();
    const [admin, setAdmin] = useState<AdminUser | null | undefined>(undefined);
    const [name, setName] = useState("");
    const [key, setKey] = useState("");
    const [itemId, setItemId] = useState("");
    const [profiles, setProfiles] = useState<KidProfile[]>(() => listProfiles());
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        probeAdmin().then(setAdmin);
    }, []);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const k = params.get("key");
        const n = params.get("name");
        const item = params.get("item");
        if (!k) return;
        const profileName = (n ?? "").trim() || "Kid";
        addProfile({ name: profileName, apiKey: k });
        setActiveKey(k);
        if (item) {
            window.location.replace(`/kids/play/${encodeURIComponent(item)}`);
        } else {
            nav("/", { replace: true });
        }
    }, [nav]);

    function add() {
        const n = name.trim();
        const k = key.trim();
        if (!n) {
            setError("Display name is required");
            return;
        }
        if (!k) {
            setError("API key is required");
            return;
        }
        const updated = addProfile({ name: n, apiKey: k });
        setProfiles(updated);
        setName("");
        setKey("");
        setError(null);
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
            <h1>Add kid profile</h1>
            <p>
                Each profile binds a kid name to an API key issued by the
                parent web app. Keys are stored locally on this device only.
            </p>

            <label>
                Display name
                <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
                Kid API key
                <input value={key} onChange={(e) => setKey(e.target.value)} />
            </label>
            {error && <p className="error">{error}</p>}
            <button onClick={add}>Add profile</button>

            {profiles.length > 0 && (
                <p className="setup-meta">
                    {profiles.length} profile{profiles.length === 1 ? "" : "s"}{" "}
                    configured. <Link to="/">Back to picker</Link>
                </p>
            )}

            {admin && (
                <>
                    <hr />
                    <p>
                        Signed in as <strong>{admin.name}</strong> (admin). The
                        admin cookie also authenticates kids endpoints, so you
                        can jump straight into playback by item id.
                    </p>
                    <label>
                        Jellyfin item id
                        <input
                            value={itemId}
                            onChange={(e) => setItemId(e.target.value)}
                        />
                    </label>
                    <button onClick={go}>Play</button>
                </>
            )}
        </div>
    );
}
