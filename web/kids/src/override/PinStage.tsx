// PinStage is the PIN-entry view for the M9 adult-override modal.
// It delegates the cross-cutting bits (portal, Escape -> close,
// repeat-Enter swallow, armed/keyup gate, focus trap,
// useProgressiveBack registration) to KidModalShell. The
// PIN-specific keyboard math (arrows -> ULDR digit chars,
// Backspace -> pop, Enter -> manual submit) stays inline because
// it doesn't fit the useDpadCursor pattern.
//
// Visually identical to the override ModalShell - we render the
// same .override-backdrop.kids-override-adult / .override-modal
// class pair through the shell.

import { useEffect, useRef } from "react";
import KidModalShell from "../KidModalShell";

export type PinStageProps = {
    itemName: string;
    pinDigits: string;
    pinBusy: boolean;
    pinError: string | null;
    pinFlashError: boolean;
    onClose: () => void;
    /** Called once per arrow press with "U" / "D" / "L" / "R". The
     *  parent appends, then auto-submits when the 4th digit lands. */
    onAppendDigit: (ch: "U" | "D" | "L" | "R") => void;
    onBackspace: () => void;
    onSubmit: () => void;
};

const PIN_ARROW_MAP: Record<string, "U" | "D" | "L" | "R"> = {
    ArrowUp: "U",
    ArrowDown: "D",
    ArrowLeft: "L",
    ArrowRight: "R",
};

export function PinStage({
    itemName,
    pinDigits,
    pinBusy,
    pinError,
    pinFlashError,
    onClose,
    onAppendDigit,
    onBackspace,
    onSubmit,
}: PinStageProps) {
    // Mirror callbacks via refs so the listener attaches once and
    // reads latest values without re-binding.
    const onAppendRef = useRef(onAppendDigit);
    onAppendRef.current = onAppendDigit;
    const onBackspaceRef = useRef(onBackspace);
    onBackspaceRef.current = onBackspace;
    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;

    // Window capture-phase keydown for PIN-specific input.
    // KidModalShell already swallowed Escape -> close, repeat-Enter,
    // and pre-arm Enter. We pass closeOnBackspace=false on the shell
    // so Backspace falls through here to delete a digit (matches
    // the original desktop behavior; the TV remote routes hardware
    // Back through useProgressiveBack independent of Backspace).
    //
    // Note: no armed-gate guard on arrows here. The shell swallows
    // e.repeat at capture phase before this listener runs, so a
    // held-arrow auto-repeat from the gesture that opened this
    // modal can't reach the digit-append path.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            const arrow = PIN_ARROW_MAP[k];
            if (arrow !== undefined) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                onAppendRef.current(arrow);
                return;
            }
            if (k === "Backspace") {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                onBackspaceRef.current();
                return;
            }
            if (k === "Enter" || k === " ") {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                onSubmitRef.current();
                return;
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () =>
            window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

    return (
        <KidModalShell
            onClose={onClose}
            ariaLabel="Adult pattern"
            backdropClassName="override-backdrop kids-override-adult"
            cardClassName="override-modal"
            variant="adult"
            closeOnBackspace={false}
        >
            <h2>Adult pattern</h2>
            <p className="muted">
                Press the 4-step arrow pattern for "{itemName}".
            </p>
            <div
                className={`override-pin-display ${pinFlashError ? "error-flash" : ""}`}
                role="status"
                aria-label="Pattern progress"
            >
                {[0, 1, 2, 3].map((i) => (
                    <span
                        key={i}
                        className={`override-pin-dot ${i < pinDigits.length ? "filled" : ""}`}
                    />
                ))}
            </div>
            {pinError && <div className="error">{pinError}</div>}
            <p className="muted override-pin-hint">
                Use the remote's arrow keys. We never show what you press.
                Press Back to close.
            </p>
            {pinBusy && <p className="muted">Checking…</p>}
        </KidModalShell>
    );
}
