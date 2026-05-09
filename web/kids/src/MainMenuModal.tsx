import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authHeaders, clearSession, withAuthRetry } from "./auth";
import { clear as clearLibraryCache } from "./libraryCache";
import { useProgressiveBack } from "./useProgressiveBack";

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

export default function MainMenuModal({ onClose }: Props) {
    const nav = useNavigate();
    const [focus, setFocus] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const ACTIONS = buildActions(isPerfDebugOn());
    // armed flips true after the FIRST keyup. The modal opens via
    // TabPill's hold-Enter gesture; the kid is still holding Enter
    // when we mount. Some TV WebViews don't set e.repeat on the
    // ongoing held-key events, so the e.repeat guard below is not
    // sufficient on its own - we'd focus the first button, the
    // continued held keydown would reach it, and the synthesized
    // keyup→click on the focused button activates the first action.
    // By gating both the initial DOM focus AND the activate path on
    // `armed`, no Enter that arrived before the first keyup can
    // ever fire onClick on a menu item. Once armed (after any
    // keyup), the modal becomes fully interactive.
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        const onKeyUp = () => setArmed(true);
        window.addEventListener("keyup", onKeyUp, { once: true });
        return () => window.removeEventListener("keyup", onKeyUp);
    }, []);

    // Back routing for the TV remote: hardware Back is delivered
    // through the Kotlin shell -> __jellybeanBack -> the
    // useProgressiveBack stack, NOT as a Backspace keydown. So we
    // can't rely on the keydown listener below to close the menu;
    // explicitly push a back handler. Stack push happens on mount,
    // so we sit above the page's handler and consume Back first.
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useProgressiveBack(() => {
        closeRef.current();
        return true;
    });

    useEffect(() => {
        if (!armed) return;
        refs.current[focus]?.focus({ preventScroll: false });
    }, [focus, armed]);

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
                    // Browser fallback: best we can do is leave the kid
                    // app and bounce back to the launcher (here, login).
                    onClose();
                    nav("/login", { replace: true });
                }
                return;
            }
        }
    }

    // Window-level capture-phase listener. See OptionPickerModal for
    // the rationale - the kid TV often leaves DOM focus on the tab
    // pill that opened this modal, so a JSX onKeyDown never fired
    // and the kid couldn't navigate or close. Capture +
    // stopImmediatePropagation also blocks TabPill's window listener
    // from arrow-navigating between tabs while the menu is open.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const focusRef = useRef(focus);
    focusRef.current = focus;
    const armedRef = useRef(armed);
    armedRef.current = armed;
    const actionsRef = useRef(ACTIONS);
    actionsRef.current = ACTIONS;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            const handles =
                k === "ArrowUp" ||
                k === "ArrowDown" ||
                k === "ArrowLeft" ||
                k === "ArrowRight" ||
                k === "Enter" ||
                k === " " ||
                k === "Escape" ||
                k === "Backspace";
            if (!handles) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            // armed gate: a keydown that arrived before the kid
            // released the Enter that opened the modal would
            // synthesize a click on the (eventually-focused) first
            // item. Swallow until first keyup flips armed true.
            if (e.repeat || !armedRef.current) return;
            switch (k) {
                case "Escape":
                case "Backspace":
                    onCloseRef.current();
                    return;
                case "ArrowDown":
                    setFocus((f) =>
                        Math.min(actionsRef.current.length - 1, f + 1),
                    );
                    return;
                case "ArrowUp":
                    setFocus((f) => Math.max(0, f - 1));
                    return;
                case "Enter":
                case " ":
                    activate(actionsRef.current[focusRef.current].id);
                    return;
                // Left/Right swallowed (no horizontal nav) so they
                // don't drive TabPill behind us.
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () =>
            window.removeEventListener("keydown", onKey, { capture: true });
        // activate closes over nav + perfDebug refs but its identity
        // doesn't change in a way that needs re-binding.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div
            className="kids-menu-backdrop"
            role="dialog"
            aria-modal
            aria-label="Main menu"
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
