import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { clearSession } from "./auth";

// MainMenuModal is the Menu pill's overlay. Three actions:
//   - Sign out: clearSession + back to /login on the same TV.
//   - Swap users: same as sign out for now (no multi-profile picker yet).
//     Kept distinct so a future multi-profile UX has a place to land.
//   - Exit app: ask the Android shell to finish the activity. Browser
//     fallback is a no-op (browsers can't close their own tab).
//
// D-pad participates: ArrowUp/Down cycles, Enter activates, Escape
// closes. The first action is auto-focused on open.

type Action = "sign-out" | "swap-users" | "exit";

type Props = {
    onClose: () => void;
};

const ACTIONS: { id: Action; label: string; description: string }[] = [
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
    const refs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
        refs.current[focus]?.focus({ preventScroll: false });
    }, [focus]);

    function activate(id: Action) {
        switch (id) {
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
        switch (e.key) {
            case "Escape":
            case "Backspace":
                e.preventDefault();
                onClose();
                return;
            case "ArrowDown":
                e.preventDefault();
                setFocus((f) => Math.min(ACTIONS.length - 1, f + 1));
                return;
            case "ArrowUp":
                e.preventDefault();
                setFocus((f) => Math.max(0, f - 1));
                return;
            case "Enter":
            case " ":
                e.preventDefault();
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
                    {ACTIONS.map((a, i) => (
                        <li key={a.id}>
                            <button
                                type="button"
                                ref={(el) => (refs.current[i] = el)}
                                className={`kids-menu-action ${focus === i ? "focused" : ""}`}
                                onClick={() => activate(a.id)}
                                onFocus={() => setFocus(i)}
                                tabIndex={focus === i ? 0 : -1}
                            >
                                <span className="kids-menu-action-label">{a.label}</span>
                                <span className="kids-menu-action-desc">{a.description}</span>
                            </button>
                        </li>
                    ))}
                </ul>
                <p className="kids-menu-hint" aria-hidden>
                    Back to close
                </p>
            </div>
        </div>
    );
}
