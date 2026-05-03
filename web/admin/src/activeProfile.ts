// Active profile state lives in localStorage so it persists across reloads
// and across tabs. The Layout's profile picker writes here; consumers
// (Sweep, Triage) read via useActiveProfile.

import { useEffect, useState } from "react";
import { api, type Profile } from "./api";

const STORAGE_KEY = "jellybean.admin.activeProfileId";

type State = {
    profile: Profile | null;
    profiles: Profile[];
    loading: boolean;
    error: string | null;
};

// useActiveProfile returns the currently-selected profile and the full
// profile list, plus a setter. The hook subscribes to a window-level event
// so multiple components stay in sync when the user picks a new profile.
export function useActiveProfile(): State & { setActive: (id: number) => void } {
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

    return { ...state, setActive };
}

// bucketForProfile classifies an item's recommended age against the active
// profile's age range. This is what Sweep groups by:
//
//   "fit"     -> within profile range (kid-safe for this profile)
//   "adult"   -> above profile.maxAge (too mature)
//   "review"  -> below profile.minAge (too young) OR no signal
//
// Pass either an explicit MinAge (already-categorized item) or a
// Suggestion.minAge (uncategorized item with an AI guess).
export type ProfileBucket = "fit" | "adult" | "review";

export function bucketForProfile(
    age: number | null | undefined,
    profile: Profile | null,
): ProfileBucket {
    if (age === null || age === undefined) return "review";
    if (!profile) {
        // No profile context: fall back to the simple kid-safe split.
        return age >= 13 ? "adult" : "fit";
    }
    if (age > profile.maxAge) return "adult";
    if (age < profile.minAge) return "review"; // too young for this profile
    return "fit";
}
