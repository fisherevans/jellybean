import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authHeaders, clearSession, withAuthRetry } from "./auth";
import { clear as clearLibraryCache } from "./libraryCache";

// MainMenuModal is the Menu pill's overlay. Four actions:
//   - Refresh: bust the server-side row cache for this kid's profile,
//     drop the local IDB library cache, reload the page. Used by the
//     parent to pull fresh layout settings after editing in the
//     admin app, without an admin-side dev-tools round-trip.
//   - Sign out: clearSession + back to /login on the same TV.
//   - Swap users: same as sign out for now (no multi-profile picker yet).
//     Kept distinct so a future multi-profile UX has a place to land.
//   - Exit app: ask the Android shell to finish the activity. Browser
//     fallback is a no-op (browsers can't close their own tab).
//
// D-pad participates: ArrowUp/Down cycles, Enter activates, Escape
// closes. The first action is auto-focused on open.

type Action = "refresh" | "sign-out" | "swap-users" | "exit";

type Props = {
    onClose: () => void;
};

const ACTIONS: { id: Action; label: string; description: string }[] = [
    {
        id: "refresh",
        label: "Refresh from server",
        description: "Pull fresh layout + library data after a parent's changes.",
    },
    {
        id: "sign-out",
        label: "Sign out",
        description: "Forget this kid on the TV. Pick a different user next.",
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

export default function MainMenuModal({ onClose }: Props) {
    const nav = useNavigate();
    const [focus, setFocus] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    const refs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
        refs.current[focus]?.focus({ preventScroll: false });
    }, [focus]);

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
                    // Browser fallback: best we can do is leave the kid
                    // app and bounce back to the launcher (here, login).
                    onClose();
                    nav("/login", { replace: true });
                }
                return;
            }
        }
    }

    function onKey(e: React.KeyboardEvent) {
        // The page behind the modal also has a keydown handler on its
        // root. Without stopPropagation, every key the modal handles
        // would also drive the page's focus model and the kid would
        // see focus jump to elements behind the modal after the first
        // arrow press. Stop the bubble at the modal boundary.
        switch (e.key) {
            case "Escape":
            case "Backspace":
                e.preventDefault();
                e.stopPropagation();
                onClose();
                return;
            case "ArrowDown":
                e.preventDefault();
                e.stopPropagation();
                setFocus((f) => Math.min(ACTIONS.length - 1, f + 1));
                return;
            case "ArrowUp":
                e.preventDefault();
                e.stopPropagation();
                setFocus((f) => Math.max(0, f - 1));
                return;
            case "ArrowLeft":
            case "ArrowRight":
                // Swallow horizontal arrows too so they don't drive
                // the page's tab pill behind us.
                e.preventDefault();
                e.stopPropagation();
                return;
            case "Enter":
            case " ":
                e.preventDefault();
                e.stopPropagation();
                activate(ACTIONS[focus].id);
                return;
        }
    }

    return (
        <div
            className="kids-menu-backdrop"
            role="dialog"
            aria-modal
            aria-label="Main menu"
            onKeyDown={onKey}
            onClick={onClose}
        >
            <div
                className="kids-menu-card"
                onClick={(e) => e.stopPropagation()}
                role="document"
            >
                <h2 className="kids-menu-title">Menu</h2>
                <ul className="kids-menu-list">
                    {ACTIONS.map((a, i) => {
                        const isRefresh = a.id === "refresh";
                        const busy = isRefresh && refreshing;
                        return (
                            <li key={a.id}>
                                <button
                                    type="button"
                                    ref={(el) => (refs.current[i] = el)}
                                    className={`kids-menu-action ${focus === i ? "focused" : ""}`}
                                    onClick={() => activate(a.id)}
                                    onFocus={() => setFocus(i)}
                                    tabIndex={focus === i ? 0 : -1}
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
            </div>
        </div>
    );
}
