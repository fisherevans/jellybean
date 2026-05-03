// Active profile state lives in localStorage so it persists across reloads
// and across tabs. The Layout's profile picker writes here; consumers
// read via useActiveProfile.

import { useEffect, useState } from "react";
import { api, type Profile } from "./api";

const STORAGE_KEY = "jellybean.admin.activeProfileId";

type State = {
    profile: Profile | null;
    profiles: Profile[];
    loading: boolean;
    error: string | null;
};

export function useActiveProfile(): State & { setActive: (id: number) => void; refresh: () => void } {
    const [state, setState] = useState<State>({
        profile: null,
        profiles: [],
        loading: true,
        error: null,
    });

    async function load() {
        try {
            const res = await api.listProfiles();
            const stored = Number(localStorage.getItem(STORAGE_KEY));
            const profile =
                res.profiles.find((p) => p.id === stored) ??
                res.profiles.find((p) => p.name === "Default") ??
                res.profiles[0] ??
                null;
            setState({ profile, profiles: res.profiles, loading: false, error: null });
        } catch (err) {
            setState({
                profile: null,
                profiles: [],
                loading: false,
                error: err instanceof Error ? err.message : "load failed",
            });
        }
    }

    useEffect(() => {
        load();
        function onStorage(e: StorageEvent) {
            if (e.key === STORAGE_KEY) load();
        }
        function onCustom() {
            load();
        }
        window.addEventListener("storage", onStorage);
        window.addEventListener("jellybean:active-profile-changed", onCustom);
        return () => {
            window.removeEventListener("storage", onStorage);
            window.removeEventListener("jellybean:active-profile-changed", onCustom);
        };
    }, []);

    function setActive(id: number) {
        localStorage.setItem(STORAGE_KEY, String(id));
        window.dispatchEvent(new Event("jellybean:active-profile-changed"));
    }

    return { ...state, setActive, refresh: load };
}
