// onlineStatus: tiny React hook around `navigator.onLine`. Re-renders on
// the browser's `online` / `offline` events.
//
// Caveat worth knowing: `navigator.onLine` is a best-effort signal. The
// browser flips it when the OS reports loss of network connectivity, but
// it stays `true` for captive portals, DNS poisoning, or upstream
// outages. Pair with explicit fetch-rejection detection for the cases
// the OS can't see; this hook is the cheap half of that pair.

import { useEffect, useState } from "react";

export function useOnlineStatus(): boolean {
    const [online, setOnline] = useState<boolean>(() =>
        typeof navigator === "undefined" ? true : navigator.onLine,
    );
    useEffect(() => {
        const onOnline = () => setOnline(true);
        const onOffline = () => setOnline(false);
        window.addEventListener("online", onOnline);
        window.addEventListener("offline", onOffline);
        return () => {
            window.removeEventListener("online", onOnline);
            window.removeEventListener("offline", onOffline);
        };
    }, []);
    return online;
}
