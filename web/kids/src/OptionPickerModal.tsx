import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProgressiveBack } from "./useProgressiveBack";

// OptionPickerModal is the shared "pick one of N values" modal used by
// Library + TagDetail for the Filter and Sort dropdown buttons.
// Renders through a portal on document.body so the page's local
// stacking-context rules (e.g. TagDetail's `.kids-tag-detail > *`
// position-relative override) can't reposition the fixed backdrop.
// Visually mirrors AlphaPickerModal (white card on dim backdrop) but
// renders a vertical stack of options instead of a letter grid.
//
// Keyboard contract:
//   ArrowUp / ArrowDown move the cursor (no wrap).
//   Enter / Space activates the cursored option.
//   Escape / Backspace closes without selecting.
//   e.repeat is ignored - this modal is opened by the same Enter the
//     parent's keyboard listener saw, so swallowing repeats prevents
//     a held key from immediately re-firing onSelect inside us.
//
// The listener is on `window` at capture phase + uses
// stopImmediatePropagation. This is load-bearing on the kid TV: with
// JSX onKeyDown the modal only sees keys when DOM focus is inside its
// subtree, but the kid TV's WebView often leaves focus on whichever
// element opened the modal (a filter/sort button on the page) so the
// modal's listener never fired and the kid couldn't navigate. Capture
// phase + stopImmediatePropagation guarantees the modal sees keys
// regardless of focus AND blocks the underlying page/tab-pill window
// listeners from double-handling.

export type OptionPickerOption = {
    id: string;
    label: string;
};

type Props = {
    title: string;
    options: OptionPickerOption[];
    currentId: string;
    onSelect: (id: string) => void;
    onClose: () => void;
};

export default function OptionPickerModal({
    title,
    options,
    currentId,
    onSelect,
    onClose,
}: Props) {
    // Initial cursor: the currently-selected option, falling back to 0
    // if the saved value isn't in the list (defensive against stale
    // localStorage values).
    const initialCursor = useMemo(() => {
        const i = options.findIndex((o) => o.id === currentId);
        return i >= 0 ? i : 0;
    }, [options, currentId]);
    const [cursor, setCursor] = useState(initialCursor);
    const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
    // armed: defers DOM focus on the cursored button until we've seen
    // a keyup. Without this, a held Enter from the parent that opened
    // us would trigger an immediate keypress on the now-focused first
    // button, selecting that option without any kid intent. Same
    // pattern MainMenuModal uses.
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        const onKeyUp = () => setArmed(true);
        window.addEventListener("keyup", onKeyUp, { once: true });
        return () => window.removeEventListener("keyup", onKeyUp);
    }, []);

    useEffect(() => {
        if (!armed) return;
        buttonRefs.current[cursor]?.focus({ preventScroll: true });
    }, [cursor, armed]);

    // Latest props captured in refs so the window listener doesn't
    // need to re-bind on every render.
    const onSelectRef = useRef(onSelect);
    const onCloseRef = useRef(onClose);
    onSelectRef.current = onSelect;
    onCloseRef.current = onClose;

    // Hardware Back on the TV remote routes through the Kotlin
    // shell -> __jellybeanBack -> useProgressiveBack stack. Push
    // our own handler so the page's parent handler doesn't have
    // to know about us.
    useProgressiveBack(() => {
        onCloseRef.current();
        return true;
    });
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const cursorRef = useRef(cursor);
    cursorRef.current = cursor;

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
            // Block every other listener (page-level keydown,
            // TabPill, useLongPressEnter, etc.) from seeing this key
            // while the modal is open. Capture phase guarantees we
            // run before bubble-phase listeners.
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            switch (k) {
                case "Escape":
                case "Backspace":
                    onCloseRef.current();
                    return;
                case "ArrowUp":
                    setCursor((c) => Math.max(0, c - 1));
                    return;
                case "ArrowDown":
                    setCursor((c) =>
                        Math.min(optionsRef.current.length - 1, c + 1),
                    );
                    return;
                case "Enter":
                case " ": {
                    const opt = optionsRef.current[cursorRef.current];
                    if (opt) onSelectRef.current(opt.id);
                    return;
                }
                // ArrowLeft / ArrowRight: swallowed (no horizontal nav
                // in this modal) so the underlying page doesn't see
                // them.
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () =>
            window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

    return createPortal(
        <div
            className="alpha-picker-backdrop"
            role="dialog"
            aria-modal
            aria-label={title}
            onClick={onClose}
        >
            <div
                className="alpha-picker-card option-picker-card"
                onClick={(e) => e.stopPropagation()}
                role="document"
            >
                <h2 className="alpha-picker-title">{title}</h2>
                <div className="option-picker-list">
                    {options.map((opt, i) => {
                        const focused = cursor === i;
                        const isCurrent = opt.id === currentId;
                        return (
                            <button
                                key={opt.id}
                                ref={(el) => (buttonRefs.current[i] = el)}
                                type="button"
                                className={`option-picker-item ${
                                    isCurrent ? "current" : ""
                                } ${focused ? "focused" : ""}`}
                                onClick={() => {
                                    const opt = options[i];
                                    if (opt) onSelect(opt.id);
                                }}
                                onFocus={() => setCursor(i)}
                                tabIndex={focused ? 0 : -1}
                                aria-pressed={isCurrent}
                            >
                                <span className="option-picker-label">
                                    {opt.label}
                                </span>
                                {isCurrent && (
                                    <span
                                        className="option-picker-check"
                                        aria-hidden
                                    >
                                        ✓
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
                <p className="alpha-picker-hint" aria-hidden>
                    Back to close
                </p>
            </div>
        </div>,
        document.body,
    );
}
