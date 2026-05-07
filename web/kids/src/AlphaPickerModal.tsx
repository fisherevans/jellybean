import { useEffect, useMemo, useRef, useState } from "react";

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

    function activate(i: number) {
        const key = ALPHA_KEYS[i];
        const target = indexMap[key];
        if (target === undefined) return; // dimmed - no-op
        // Just onPick - the parent owns "close the modal + set focus
        // to the picked tile" so we don't race a follow-up onClose
        // that would overwrite the grid focus back to alphaBtn.
        onPick(target);
    }

    function onKey(e: React.KeyboardEvent) {
        // Stop propagation so the page-level keydown handler doesn't
        // also process the same key (which would move focus on the
        // library behind the modal).
        const handled = (() => {
            switch (e.key) {
                case "Escape":
                case "Backspace":
                    onClose();
                    return true;
                case "ArrowLeft":
                    setCursor((c) => (c % ALPHA_GRID_COLS === 0 ? c : c - 1));
                    return true;
                case "ArrowRight":
                    setCursor((c) => {
                        if (c + 1 >= ALPHA_KEYS.length) return c;
                        if ((c + 1) % ALPHA_GRID_COLS === 0) return c;
                        return c + 1;
                    });
                    return true;
                case "ArrowUp":
                    setCursor((c) =>
                        c - ALPHA_GRID_COLS >= 0 ? c - ALPHA_GRID_COLS : c,
                    );
                    return true;
                case "ArrowDown":
                    setCursor((c) =>
                        c + ALPHA_GRID_COLS < ALPHA_KEYS.length
                            ? c + ALPHA_GRID_COLS
                            : c,
                    );
                    return true;
                case "Enter":
                case " ":
                    activate(cursor);
                    return true;
                default:
                    return false;
            }
        })();
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    return (
        <div
            className="alpha-picker-backdrop"
            role="dialog"
            aria-modal
            aria-label="Jump to letter"
            onKeyDown={onKey}
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
        </div>
    );
}
