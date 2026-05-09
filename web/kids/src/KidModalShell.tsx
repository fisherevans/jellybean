import {
    createContext,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useProgressiveBack } from "./useProgressiveBack";

// KidModalShell owns the cross-cutting machinery shared by every
// D-pad-friendly modal in the kid app:
//
//   - Portals through document.body so a transformed ancestor (e.g.
//     TagDetail's positioned root, or Browse's stack transform) can
//     never re-anchor the fixed backdrop.
//   - Installs a window-level capture-phase keydown listener that
//     consumes Escape / Backspace -> onClose, swallows repeat keydowns
//     (so a held Enter that opened the modal can't fire again), and
//     swallows Enter / Space pre-arming (the open-press is still
//     traveling through; we wait for the first keyup before letting
//     content listeners see Enter).
//     Arrow keys are NOT consumed at this layer - they bubble to
//     whatever inner listener the modal installs (typically
//     useDpadCursor or a grid-shaped handler).
//   - Tracks `armed`: flips true on the first keyup. Exposes via
//     KidModalArmedContext so inner listeners (useDpadCursor) can
//     match the gate without re-implementing the keyup wiring.
//   - Registers a useProgressiveBack handler so the Android Kotlin
//     bridge's hardware-Back routes through onClose.
//   - Installs a focusin focus-trap: any focus that escapes the
//     modal subtree snaps back to the last-known-inside element (or
//     the modal root). Same pattern OverrideModal's old ModalShell
//     used; centralized so all four kid modals get the same
//     treatment.
//
// The visual card lives in `children` - the shell is intentionally
// thin so existing per-modal class palettes (alpha-picker-card,
// kids-menu-card, override-modal) keep their tuned styling. Pass
// `backdropClassName` and `cardClassName` to wire each modal's
// existing CSS in place. `variant="adult"` is informational today
// (no behavioral split) and reserved for future per-variant
// treatment.

type Variant = "default" | "adult";

type Props = {
    onClose: () => void;
    children: ReactNode;
    /** Card-level role. Defaults to "dialog". */
    role?: string;
    ariaLabel?: string;
    /** ClassName on the backdrop div. */
    backdropClassName: string;
    /** ClassName on the inner card div. */
    cardClassName: string;
    /** Reserved for future behavioral splits. Currently
     *  informational. */
    variant?: Variant;
    /** Click handler for the backdrop. Defaults to onClose; pass
     *  null to disable. The OverrideModal's mousedown trap on the
     *  backdrop is implemented at the listener layer separately. */
    onBackdropClick?: (() => void) | null;
    /** When true (default), Backspace closes the modal alongside
     *  Escape. PIN entry sets this false so its inline listener
     *  can repurpose Backspace (delete-a-digit) without competing
     *  with the shell. The TV remote routes hardware Back through
     *  useProgressiveBack regardless, so disabling this only
     *  affects desktop keyboard testing. */
    closeOnBackspace?: boolean;
};

const KidModalArmedContext = createContext<boolean>(false);

/** Read the modal's armed flag inside any descendant listener. */
export function useKidModalArmed(): boolean {
    return useContext(KidModalArmedContext);
}

export default function KidModalShell({
    onClose,
    children,
    role = "dialog",
    ariaLabel,
    backdropClassName,
    cardClassName,
    variant: _variant = "default",
    onBackdropClick,
    closeOnBackspace = true,
}: Props) {
    const cardRef = useRef<HTMLDivElement | null>(null);
    const lastInsideRef = useRef<HTMLElement | null>(null);

    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const closeOnBackspaceRef = useRef(closeOnBackspace);
    closeOnBackspaceRef.current = closeOnBackspace;

    // armed flips on first keyup. Both the shell's listener and any
    // descendant useDpadCursor listener gate Enter activation on
    // this so a held Enter that opened the modal never synthesizes
    // an immediate selection.
    const [armed, setArmed] = useState(false);
    const armedRef = useRef(armed);
    armedRef.current = armed;
    useEffect(() => {
        const onKeyUp = () => setArmed(true);
        window.addEventListener("keyup", onKeyUp, { once: true });
        return () => window.removeEventListener("keyup", onKeyUp);
    }, []);

    // Hardware Back -> close.
    useProgressiveBack(() => {
        onCloseRef.current();
        return true;
    });

    // Window-level capture-phase keydown listener:
    //   - swallows e.repeat (any key) so held-key auto-repeat from
    //     the open gesture can't drive the modal.
    //   - swallows Enter / Space while !armed for the same reason
    //     (the original keydown is still in flight; we wait for a
    //     keyup before treating Enter as a real press).
    //   - consumes Escape / Backspace -> onClose.
    //   - lets arrow keys (and post-arm Enter / Space) fall
    //     through to inner listeners.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            const isNav =
                k === "ArrowUp" ||
                k === "ArrowDown" ||
                k === "ArrowLeft" ||
                k === "ArrowRight" ||
                k === "Enter" ||
                k === " " ||
                k === "Escape" ||
                k === "Backspace";
            if (!isNav) return;
            if (e.repeat) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                return;
            }
            if (k === "Escape" || (k === "Backspace" && closeOnBackspaceRef.current)) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                onCloseRef.current();
                return;
            }
            if ((k === "Enter" || k === " ") && !armedRef.current) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                return;
            }
            // Arrow keys + post-arm Enter / Space: leave for inner
            // listeners (useDpadCursor or modal-specific grid). They
            // run in registration order; child effects mount first
            // so child listeners fire first, but the shell's
            // listener will still see anything they don't
            // stopImmediatePropagation.
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () =>
            window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

    // Focus trap: if focus drifts outside the modal subtree (e.g.
    // backdrop click on desktop), snap it back. Without this the
    // keyboard has no target inside the modal and arrow keys do
    // nothing.
    useEffect(() => {
        function onFocusIn(e: FocusEvent) {
            const target = e.target as HTMLElement | null;
            const root = cardRef.current;
            if (!root) return;
            if (target && root.contains(target)) {
                lastInsideRef.current = target;
                return;
            }
            const restore =
                lastInsideRef.current && root.contains(lastInsideRef.current)
                    ? lastInsideRef.current
                    : root.querySelector<HTMLElement>(
                          'button, [tabindex]:not([tabindex="-1"])',
                      );
            (restore ?? root).focus();
        }
        // Mousedown on the backdrop: prevent the default
        // body-becomes-active behavior so focus inside the modal
        // survives the click.
        function onBackdropMouseDown(e: MouseEvent) {
            const root = cardRef.current;
            if (!root) return;
            if (root.contains(e.target as Node)) return;
            e.preventDefault();
        }
        document.addEventListener("focusin", onFocusIn);
        document.addEventListener("mousedown", onBackdropMouseDown);
        return () => {
            document.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("mousedown", onBackdropMouseDown);
        };
    }, []);

    const handleBackdropClick =
        onBackdropClick === undefined ? onClose : onBackdropClick;

    return createPortal(
        <KidModalArmedContext.Provider value={armed}>
            <div
                className={backdropClassName}
                role={role}
                aria-modal
                aria-label={ariaLabel}
                onClick={handleBackdropClick ?? undefined}
            >
                <div
                    ref={cardRef}
                    className={cardClassName}
                    tabIndex={-1}
                    onClick={(e) => e.stopPropagation()}
                    role="document"
                >
                    {children}
                </div>
            </div>
        </KidModalArmedContext.Provider>,
        document.body,
    );
}
