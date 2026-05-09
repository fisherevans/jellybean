import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useProgressiveBack } from "./useProgressiveBack";

// AlphaPickerModal is the kid-facing replacement for the old vertical
// A-Z strip. Pressing the A-Z icon button on the library controls row
// pops this overlay; the kid arrows around a 7-wide letter grid and
// Enter jumps the library to the first item starting with that
// letter (the modal closes on activation). Escape / Back closes
// without jumping.
//
// `#` represents items whose first character isn't A-Z (numerics,
// punctuation, etc.). It only renders enabled when at least one such
// item exists, mirroring how letters dim when no items match.
//
// Layout: 7 columns x 4 rows = 28 cells. Letters A-Z fill the first
// 26; # lands in the 27th; the trailing cell is filler. Auto-focuses
// the first enabled cell on open so a single OK press always
// activates something the kid can see is reachable.
//
// The letter -> index map is supplied by the caller (server-computed
// over the FULL library). Computing it on the client from the
// already-loaded items only would dim letters that are valid in the
// library but happen to be past the first paginated page.

const ALPHA_GRID_COLS = 7;
const ALPHA_KEYS = [
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    "#",
];

type Props = {
    lettersByName: Record<string, number>;
    onPick: (gridIndex: number) => void;
    onClose: () => void;
};

export default function AlphaPickerModal({
    lettersByName,
    onPick,
    onClose,
}: Props) {
    const indexMap = lettersByName;
    // Initial focus: first enabled letter so OK on open always lands
    // on something. Falls back to A's slot when nothing matches
    // (degenerate empty library - the modal still opens).
    const initialFocus = useMemo(() => {
        for (let i = 0; i < ALPHA_KEYS.length; i++) {
            if (indexMap[ALPHA_KEYS[i]] !== undefined) return i;
        }
        return 0;
    }, [indexMap]);
    const [cursor, setCursor] = useState(initialFocus);
    const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

    // Push DOM focus to match the cursor so screen readers + cheap
    // WebViews track the highlight ring.
    useEffect(() => {
        buttonRefs.current[cursor]?.focus({ preventScroll: true });
    }, [cursor]);

    // Window-level capture-phase keyboard listener. See
    // OptionPickerModal for the rationale - keys must reach the
    // modal even when DOM focus is still on the underlying page,
    // and underlying listeners (TabPill, page-level) must not see
    // the keys at all while the modal is open.
    const onPickRef = useRef(onPick);
    const onCloseRef = useRef(onClose);
    onPickRef.current = onPick;
    onCloseRef.current = onClose;

    // Hardware Back on the TV remote routes through the Kotlin
    // shell -> __jellybeanBack stack, not Backspace keydown. Push
    // our own handler so the modal closes without relying on the
    // page's parent handler.
    useProgressiveBack(() => {
        onCloseRef.current();
        return true;
    });
    const cursorRef = useRef(cursor);
    cursorRef.current = cursor;
    const indexMapRef = useRef(indexMap);
    indexMapRef.current = indexMap;

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
            if (e.repeat) return;
            switch (k) {
                case "Escape":
                case "Backspace":
                    onCloseRef.current();
                    return;
                case "ArrowLeft":
                    setCursor((c) => (c % ALPHA_GRID_COLS === 0 ? c : c - 1));
                    return;
                case "ArrowRight":
                    setCursor((c) => {
                        if (c + 1 >= ALPHA_KEYS.length) return c;
                        if ((c + 1) % ALPHA_GRID_COLS === 0) return c;
                        return c + 1;
                    });
                    return;
                case "ArrowUp":
                    setCursor((c) =>
                        c - ALPHA_GRID_COLS >= 0 ? c - ALPHA_GRID_COLS : c,
                    );
                    return;
                case "ArrowDown":
                    setCursor((c) =>
                        c + ALPHA_GRID_COLS < ALPHA_KEYS.length
                            ? c + ALPHA_GRID_COLS
                            : c,
                    );
                    return;
                case "Enter":
                case " ": {
                    const i = cursorRef.current;
                    const key = ALPHA_KEYS[i];
                    const target = indexMapRef.current[key];
                    if (target === undefined) return; // dimmed - no-op
                    onPickRef.current(target);
                    return;
                }
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        return () =>
            window.removeEventListener("keydown", onKey, { capture: true });
    }, []);

    function activate(i: number) {
        const key = ALPHA_KEYS[i];
        const target = indexMap[key];
        if (target === undefined) return;
        onPick(target);
    }

    return createPortal(
        <div
            className="alpha-picker-backdrop"
            role="dialog"
            aria-modal
            aria-label="Jump to letter"
            onClick={onClose}
        >
            <div
                className="alpha-picker-card"
                onClick={(e) => e.stopPropagation()}
                role="document"
            >
                <h2 className="alpha-picker-title">Jump to letter</h2>
                <div
                    className="alpha-picker-grid"
                    style={
                        {
                            "--cols": String(ALPHA_GRID_COLS),
                        } as React.CSSProperties
                    }
                >
                    {ALPHA_KEYS.map((key, i) => {
                        const enabled = indexMap[key] !== undefined;
                        const focused = cursor === i;
                        return (
                            <button
                                key={key}
                                ref={(el) => (buttonRefs.current[i] = el)}
                                type="button"
                                className={`alpha-picker-cell ${
                                    enabled ? "" : "disabled"
                                } ${focused ? "focused" : ""}`}
                                onClick={() => activate(i)}
                                onFocus={() => setCursor(i)}
                                tabIndex={focused ? 0 : -1}
                                aria-disabled={!enabled}
                                aria-label={
                                    key === "#" ? "Other (numbers / symbols)" : key
                                }
                            >
                                {key}
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
