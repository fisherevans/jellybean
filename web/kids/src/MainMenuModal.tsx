import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authHeaders, clearSession, withAuthRetry } from "./auth";
import KidModalShell from "./KidModalShell";
import { clear as clearLibraryCache } from "./libraryCache";
import { useDpadCursor } from "./useDpadCursor";

// MainMenuModal is the Menu pill's overlay. Five actions:
//   - Refresh: bust the server-side row cache for this kid's profile,
//     drop the local IDB library cache, reload the page. Used by the
//     parent to pull fresh layout settings after editing in the
//     admin app, without an admin-side dev-tools round-trip.
//   - Perf overlay toggle: localStorage flag + reload (main.tsx
//     reads it on boot to wire startPerfOverlay).
//   - Sign out: clearSession + back to /login on the same TV.
//   - Swap users: same as sign out for now (no multi-profile picker yet).
//     Kept distinct so a future multi-profile UX has a place to land.
//   - Exit app: ask the Android shell to finish the activity. Browser
//     fallback is a no-op (browsers can't close their own tab).
//
// Portal + window keyboard listener (Escape, repeat-Enter swallow,
// armed gate) + focus trap live in KidModalShell. useDpadCursor
// owns the Up/Down cursor + Enter activation.

type Action = "refresh" | "perf-debug" | "sign-out" | "swap-users" | "exit";

type Props = {
    onClose: () => void;
};

// localStorage flag controlling the live perf overlay (see main.tsx
// + perfOverlay.ts). Read once on render so the menu label reflects
// current state; toggling reloads the page so the value is re-read
// from scratch and the overlay starts/stops cleanly.
const PERF_DEBUG_KEY = "jellybean.kids.perfDebug";
function isPerfDebugOn(): boolean {
    try {
        return localStorage.getItem(PERF_DEBUG_KEY) === "1";
    } catch {
        return false;
    }
}

function buildActions(perfOn: boolean): {
    id: Action;
    label: string;
    description: string;
}[] {
    return [
        {
            id: "refresh",
            label: "Refresh from server",
            description:
                "Pull fresh layout + library data after a parent's changes.",
        },
        {
            id: "perf-debug",
            label: perfOn ? "Turn off perf overlay" : "Turn on perf overlay",
            description: perfOn
                ? "Hide FPS / longtask overlay + diagnostic console logs."
                : "Show FPS / longtask overlay + diagnostic console logs (reload).",
        },
        {
            id: "sign-out",
            label: "Sign out",
            description:
                "Forget this kid on the TV. Pick a different user next.",
        },
        {
            id: "swap-users",
            label: "Switch user",
            description: "Sign out and go back to the login screen.",
        },
        {
            id: "exit",
            label: "Exit app",
            description: "Close Jellybean and return to the launcher.",
        },
    ];
}

type ActionMeta = ReturnType<typeof buildActions>[number];

export default function MainMenuModal({ onClose }: Props) {
    const nav = useNavigate();
    const [refreshing, setRefreshing] = useState(false);
    const ACTIONS = buildActions(isPerfDebugOn());

    async function refreshFromServer() {
        if (refreshing) return;
        setRefreshing(true);
        try {
            // Best-effort: a 4xx/5xx here just means the server cache
            // wasn't busted, but we still drop IDB + reload below so
            // the kid sees a fresh fetch either way.
            await withAuthRetry(() =>
                fetch("/api/kids/maintenance/refresh-layout", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: authHeaders(),
                }),
            ).catch(() => undefined);
            await clearLibraryCache().catch(() => undefined);
            // sessionStorage survives reload, so explicitly purge
            // any kid-side caches whose entries should reflect the
            // freshly-pulled server state. Browse + Tags both
            // shadow their last response under a profile-scoped
            // key prefix.
            try {
                const remove: string[] = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                    const k = sessionStorage.key(i);
                    if (
                        k &&
                        (k.startsWith("jellybean.kids.tags.") ||
                            k.startsWith("jellybean.kids.browse.cache."))
                    ) {
                        remove.push(k);
                    }
                }
                for (const k of remove) sessionStorage.removeItem(k);
            } catch {
                /* ignore */
            }
            window.location.reload();
        } finally {
            // Only reached if reload() somehow doesn't fire.
            setRefreshing(false);
        }
    }

    function activate(id: Action) {
        switch (id) {
            case "refresh":
                void refreshFromServer();
                return;
            case "perf-debug": {
                // Toggle the localStorage flag and reload. Reload
                // is the simplest way to start/stop the overlay
                // cleanly: main.tsx checks the flag at boot and
                // calls startPerfOverlay() based on it.
                try {
                    if (isPerfDebugOn()) {
                        localStorage.removeItem(PERF_DEBUG_KEY);
                    } else {
                        localStorage.setItem(PERF_DEBUG_KEY, "1");
                    }
                } catch {
                    /* localStorage unavailable - menu just no-ops */
                }
                window.location.reload();
                return;
            }
            case "sign-out":
            case "swap-users":
                clearSession();
                nav("/login", { replace: true });
                onClose();
                return;
            case "exit": {
                const bridge = (
                    window as unknown as {
                        JellybeanShell?: { exitApp?: () => void };
                    }
                ).JellybeanShell;
                if (bridge?.exitApp) {
                    bridge.exitApp();
                } else {
                    // Browser fallback: best we can do is leave the
                    // kid app and bounce back to the launcher (here,
                    // login).
                    onClose();
                    nav("/login", { replace: true });
                }
                return;
            }
        }
    }

    return (
        <KidModalShell
            onClose={onClose}
            ariaLabel="Main menu"
            backdropClassName="kids-menu-backdrop"
            cardClassName="kids-menu-card"
        >
            <MainMenuBody
                actions={ACTIONS}
                refreshing={refreshing}
                onActivate={activate}
            />
        </KidModalShell>
    );
}

// MainMenuBody lives inside KidModalShell so useDpadCursor reads the
// shell's KidModalArmedContext correctly (provider wraps the portal
// children, not the shell's caller). All interactive plumbing lives
// here; the outer component owns lifecycle / action dispatch.
function MainMenuBody({
    actions,
    refreshing,
    onActivate,
}: {
    actions: ActionMeta[];
    refreshing: boolean;
    onActivate: (id: Action) => void;
}) {
    const dpad = useDpadCursor({
        count: actions.length,
        initial: 0,
        onActivate: (i) => onActivate(actions[i].id),
    });

    return (
        <>
            <h2 className="kids-menu-title">Menu</h2>
            <ul className="kids-menu-list">
                {actions.map((a, i) => {
                    const isRefresh = a.id === "refresh";
                    const busy = isRefresh && refreshing;
                    return (
                        <li key={a.id}>
                            <button
                                type="button"
                                ref={dpad.register(i) as (
                                    el: HTMLButtonElement | null,
                                ) => void}
                                className={`kids-menu-action ${dpad.cursor === i ? "focused" : ""}`}
                                onClick={() => onActivate(a.id)}
                                onFocus={() => dpad.setCursor(i)}
                                tabIndex={dpad.cursor === i ? 0 : -1}
                                disabled={busy}
                            >
                                <span className="kids-menu-action-label">
                                    {busy ? "Refreshing…" : a.label}
                                </span>
                                <span className="kids-menu-action-desc">
                                    {a.description}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
            <p className="kids-menu-hint" aria-hidden>
                Back to close
            </p>
        </>
    );
}
