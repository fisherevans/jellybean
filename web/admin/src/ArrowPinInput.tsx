import { useEffect, useRef } from "react";

// 4-step arrow-direction PIN input. Stores the canonical format
// (U/D/L/R characters, e.g. "UULR") that the kid TV's override
// modal sends on the verify-pin endpoint, so the bcrypt hash
// matches whether the kid entered it via remote arrows or the
// admin set it via this UI.
//
// The admin can build the sequence by clicking the arrow buttons
// OR by pressing keyboard arrow keys (the latter mirrors what the
// kid does on the TV). Backspace deletes the last step. Reset
// clears all 4. We never display the actual characters - just
// the arrow glyph - because typing in a PIN that's visible
// defeats the security purpose of hiding it on the kid TV side.

type Props = {
    value: string;
    onChange: (next: string) => void;
    onComplete?: (full: string) => void;
    disabled?: boolean;
    autoFocus?: boolean;
};

const LENGTH = 4;

const ARROW_GLYPH: Record<string, string> = {
    U: "↑",
    D: "↓",
    L: "←",
    R: "→",
};

export default function ArrowPinInput({
    value,
    onChange,
    onComplete,
    disabled,
    autoFocus,
}: Props) {
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (autoFocus) rootRef.current?.focus();
    }, [autoFocus]);

    function append(ch: string) {
        if (disabled) return;
        if (value.length >= LENGTH) return;
        const next = value + ch;
        onChange(next);
        if (next.length === LENGTH && onComplete) onComplete(next);
    }

    function backspace() {
        if (disabled) return;
        if (value.length === 0) return;
        onChange(value.slice(0, -1));
    }

    function clearAll() {
        if (disabled) return;
        onChange("");
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
        const map: Record<string, string> = {
            ArrowUp: "U",
            ArrowDown: "D",
            ArrowLeft: "L",
            ArrowRight: "R",
        };
        const ch = map[e.key];
        if (ch) {
            e.preventDefault();
            append(ch);
            return;
        }
        if (e.key === "Backspace") {
            e.preventDefault();
            backspace();
            return;
        }
    }

    // preventDefault on mousedown stops the click from moving DOM
    // focus to the button. Without this the first click parks
    // focus on (typically) the Up button - because of the global
    // `button:focus` browser outline (or :focus-within applying to
    // the wrapper) that read as the Up button being persistently
    // "selected" when the admin moused around the input area.
    // Click events still fire normally.
    const noFocus = (e: React.MouseEvent) => e.preventDefault();

    return (
        <div
            className="arrow-pin-input"
            role="group"
            aria-label="Arrow pattern"
            ref={rootRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
        >
            <div className="arrow-pin-cells">
                {Array.from({ length: LENGTH }, (_, i) => (
                    <div
                        key={i}
                        className={`arrow-pin-cell ${value[i] ? "filled" : ""}`}
                        aria-label={`Step ${i + 1}`}
                    >
                        {value[i] ? ARROW_GLYPH[value[i]] : ""}
                    </div>
                ))}
            </div>
            <div className="arrow-pin-pad">
                <button
                    type="button"
                    onClick={() => append("U")}
                    onMouseDown={noFocus}
                    disabled={disabled || value.length >= LENGTH}
                    aria-label="Up"
                    className="arrow-pin-btn arrow-pin-btn-up"
                >
                    ↑
                </button>
                <div className="arrow-pin-row">
                    <button
                        type="button"
                        onClick={() => append("L")}
                        onMouseDown={noFocus}
                        disabled={disabled || value.length >= LENGTH}
                        aria-label="Left"
                        className="arrow-pin-btn"
                    >
                        ←
                    </button>
                    <button
                        type="button"
                        onClick={() => append("D")}
                        onMouseDown={noFocus}
                        disabled={disabled || value.length >= LENGTH}
                        aria-label="Down"
                        className="arrow-pin-btn"
                    >
                        ↓
                    </button>
                    <button
                        type="button"
                        onClick={() => append("R")}
                        onMouseDown={noFocus}
                        disabled={disabled || value.length >= LENGTH}
                        aria-label="Right"
                        className="arrow-pin-btn"
                    >
                        →
                    </button>
                </div>
            </div>
            <div className="arrow-pin-actions">
                <button
                    type="button"
                    onClick={backspace}
                    onMouseDown={noFocus}
                    disabled={disabled || value.length === 0}
                >
                    Backspace
                </button>
                <button
                    type="button"
                    onClick={clearAll}
                    onMouseDown={noFocus}
                    disabled={disabled || value.length === 0}
                >
                    Clear
                </button>
            </div>
        </div>
    );
}
