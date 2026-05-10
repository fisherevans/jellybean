import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    Backspace as BackspaceIcon,
    CheckCircle,
    Eraser,
} from "@phosphor-icons/react";
import { useProgressiveBack } from "./useProgressiveBack";

// Keyboard is a D-pad-driven on-screen keyboard for the kids app.
// The Skyworth Android TV's native IME is slow and visually intrusive,
// so search input on Library uses this instead. The component is
// stateless / controlled - the parent owns `value` and the keyboard
// only emits changes via the callbacks.
//
// Layout (t15): 6 columns x 8 rows on a CSS grid.
//
//   Row 1:  A    B    C    D    E    BACK    <- BACK row-spans 2
//   Row 2:  F    G    H    I    J    (BACK)
//   Row 3:  K    L    M    N    O    CLEAR
//   Row 4:  P    Q    R    S    T    DONE
//   Row 5:  U    V    W    X    Y    Z
//   Row 6:  [---------- SPACE (col-spans 6) ----------]
//   Row 7:  1    2    3    4    5    '
//   Row 8:  6    7    8    9    0    -
//
// Letters first because kids don't know QWERTY; alphabetical gets
// them to the right key faster. BACK is doubled-up vertically so it
// reads as a tall rest-position for the right thumb. SPACE is one
// wide cell so it can't be missed.
//
// Navigation:
//   - ArrowLeft / ArrowRight clamp horizontally within a row (no wrap).
//   - ArrowUp / ArrowDown clamp vertically between rows (no wrap).
//   - When a target cell is part of a span (BACK or SPACE), the focus
//     lands on the key anchor; the kid sees one solid focused cell.
//   - Enter on a char key (letters, digits, ', -) appends to value.
//   - Enter on SPACE appends a single space.
//   - Enter on BACK removes the last char; held BACK repeats at
//     REPEAT_THROTTLE_MS via the time-since-last-event pattern from
//     PlayerTransport.tsx (e.repeat is unreliable on this WebView).
//   - Enter on CLEAR empties value.
//   - Enter on DONE calls onSubmit(value).
//   - Back calls onClose() and lets the page own the back-press.
//
// The keyboard owns a window-level capture-phase keydown listener
// while open: it preventDefault + stopPropagation on every key it
// handles so the page's native search input never double-fires.
//
// Internal focus stays inside this component - Library's focus state
// machine sees a single "search" focus while the keyboard is up.

type KeyKind =
    | { kind: "char"; label: string; value: string }
    | { kind: "space" }
    | { kind: "backspace" }
    | { kind: "clear" }
    | { kind: "done" };

// Key descriptor including grid placement. row/col are 1-indexed to
// match CSS `grid-row` / `grid-column` semantics; rowSpan/colSpan
// default to 1 and increase only for BACK and SPACE.
type Key = {
    id: string;
    kind: KeyKind;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
};

const COLS = 6;
const ROWS = 8;

function ch(c: string, row: number, col: number): Key {
    return {
        id: `c:${c}`,
        kind: { kind: "char", label: c, value: c },
        row,
        col,
        rowSpan: 1,
        colSpan: 1,
    };
}

const KEYS: Key[] = [
    // Row 1: A B C D E + BACK (rowSpan 2)
    ch("A", 1, 1),
    ch("B", 1, 2),
    ch("C", 1, 3),
    ch("D", 1, 4),
    ch("E", 1, 5),
    {
        id: "ctrl:back",
        kind: { kind: "backspace" },
        row: 1,
        col: 6,
        rowSpan: 2,
        colSpan: 1,
    },
    // Row 2: F G H I J (BACK fills col 6)
    ch("F", 2, 1),
    ch("G", 2, 2),
    ch("H", 2, 3),
    ch("I", 2, 4),
    ch("J", 2, 5),
    // Row 3: K L M N O CLEAR
    ch("K", 3, 1),
    ch("L", 3, 2),
    ch("M", 3, 3),
    ch("N", 3, 4),
    ch("O", 3, 5),
    {
        id: "ctrl:clear",
        kind: { kind: "clear" },
        row: 3,
        col: 6,
        rowSpan: 1,
        colSpan: 1,
    },
    // Row 4: P Q R S T DONE
    ch("P", 4, 1),
    ch("Q", 4, 2),
    ch("R", 4, 3),
    ch("S", 4, 4),
    ch("T", 4, 5),
    {
        id: "ctrl:done",
        kind: { kind: "done" },
        row: 4,
        col: 6,
        rowSpan: 1,
        colSpan: 1,
    },
    // Row 5: U V W X Y Z
    ch("U", 5, 1),
    ch("V", 5, 2),
    ch("W", 5, 3),
    ch("X", 5, 4),
    ch("Y", 5, 5),
    ch("Z", 5, 6),
    // Row 6: SPACE (colSpan 6)
    {
        id: "ctrl:space",
        kind: { kind: "space" },
        row: 6,
        col: 1,
        rowSpan: 1,
        colSpan: 6,
    },
    // Row 7: digits 1-5 + apostrophe
    ch("1", 7, 1),
    ch("2", 7, 2),
    ch("3", 7, 3),
    ch("4", 7, 4),
    ch("5", 7, 5),
    ch("'", 7, 6),
    // Row 8: digits 6-0 + hyphen
    ch("6", 8, 1),
    ch("7", 8, 2),
    ch("8", 8, 3),
    ch("9", 8, 4),
    ch("0", 8, 5),
    ch("-", 8, 6),
];

// Build a (row, col) -> Key index occupancy matrix once. Each cell
// inside a key's span (BACK, SPACE) maps back to the same key index
// so navigation can reject "same key" steps cheaply.
const OCCUPANCY: number[][] = (() => {
    const grid: number[][] = [];
    for (let r = 0; r < ROWS; r++) {
        grid.push(new Array(COLS).fill(-1));
    }
    KEYS.forEach((k, idx) => {
        for (let r = k.row; r < k.row + k.rowSpan; r++) {
            for (let c = k.col; c < k.col + k.colSpan; c++) {
                grid[r - 1][c - 1] = idx;
            }
        }
    });
    return grid;
})();

// Held-Backspace repeat: 150ms throttle, time-since-last-event based
// (matches the seek-hold pattern from PlayerTransport.tsx). e.repeat
// is unreliable on this WebView - Android TV remotes sometimes emit
// streams of repeat=false keydowns instead of toggling repeat. The
// time-since-last-event gate is robust either way: a "real" hold
// produces back-to-back keydowns within ~50ms of each other; a tap
// burst that briefly looks like a hold is bounded by the throttle.
const REPEAT_THROTTLE_MS = 150;
const REPEAT_GAP_MS = 250;

// ----- Color theme (t15) -----
//
// White panel + dark colorful letters. Each cell is tinted by a
// position-interpolated color; on focus the cell fills with that color
// and the letter flips to white. The palette is randomized at open
// time so consecutive keyboard opens look distinct.

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
    const h = hex.replace("#", "");
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

function rgbToCss(rgb: RGB, alpha = 1): string {
    const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))));
    return alpha === 1
        ? `rgb(${r}, ${g}, ${b})`
        : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Three-color palettes pulled from the kid-friendly visual language
// already used elsewhere in the app (rainbow page bg, browse hero
// gradients). t19 picks anchors with MORE hue separation (e.g. blue
// paired with red instead of blue paired with purple) so the cascade
// across the 6x8 grid reads as a clear corner-to-corner shift, not a
// subtle blend. Saturation is bumped on the anchors so the cells pop
// against the white panel. Yellow is intentionally absent - low
// contrast on white.
const PALETTES: [string, string, string][] = [
    ["#0066ff", "#ff1a4d", "#00c853"], // blue / red / green
    ["#00b86b", "#0048d6", "#e60053"], // green / deep-blue / magenta
    ["#ff5722", "#aa00ff", "#00b3ff"], // orange / violet / cyan
    ["#d10031", "#ff8a00", "#00875a"], // red / orange / forest
    ["#3a00d6", "#00b896", "#ff4a1f"], // indigo / teal / red-orange
    ["#c300ff", "#0073ff", "#00d65a"], // magenta / blue / lime
    ["#ff006a", "#3300cc", "#00a86b"], // hot-pink / deep-purple / green
    ["#0099ff", "#ff2a5b", "#7a00e6"], // cyan-blue / coral-red / violet
];

// Theme captured at open-time. We pick a palette + assign each color
// to one of the three "anchor" corners (top-left, top-right, bottom).
// Each cell's color is computed via barycentric interpolation across
// (col, row), so the kid sees a smooth diagonal gradient across the
// 6x8 grid.
type Theme = {
    cTL: RGB;
    cTR: RGB;
    cB: RGB;
};

function pickTheme(): Theme {
    const palette = PALETTES[Math.floor(Math.random() * PALETTES.length)];
    // Shuffle the three colors into TL / TR / Bottom slots. Six
    // permutations; pick one uniformly.
    const perm = [...palette];
    for (let i = perm.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    return {
        cTL: hexToRgb(perm[0]),
        cTR: hexToRgb(perm[1]),
        cB: hexToRgb(perm[2]),
    };
}

// Compute a cell's color via barycentric interpolation across the
// three corner anchors:
//   TL = (col=0, row=0)
//   TR = (col=COLS-1, row=0)
//   B  = (col=(COLS-1)/2, row=ROWS-1)
// t19: a gamma curve (exponent < 1) is applied to each barycentric
// weight before normalization. This pushes cells closer to a corner
// further into that corner's color rather than spending most of the
// grid in the muddy mid-blend. Visually: a clear shift from one
// corner to the next instead of "everything looks slightly purple."
// Weights are then re-normalized so they sum to 1 and the output
// stays inside the anchor triangle.
const CASCADE_GAMMA = 0.55;
function cellColor(theme: Theme, row: number, col: number): RGB {
    const u = (COLS - 1) === 0 ? 0 : col / (COLS - 1); // 0..1 across cols
    const v = (ROWS - 1) === 0 ? 0 : row / (ROWS - 1); // 0..1 down rows
    // Raw barycentric weights: bottom corner pulls in proportional to
    // v; top corners share the remainder weighted by u.
    let wTL = (1 - v) * (1 - u);
    let wTR = (1 - v) * u;
    let wB = v;
    // Push each weight via gamma < 1 so values near 1 stay near 1 but
    // mid-range values get amplified toward 1. The dominant corner
    // becomes more dominant after re-normalization.
    wTL = Math.pow(wTL, CASCADE_GAMMA);
    wTR = Math.pow(wTR, CASCADE_GAMMA);
    wB = Math.pow(wB, CASCADE_GAMMA);
    const wSum = wTL + wTR + wB || 1;
    wTL /= wSum;
    wTR /= wSum;
    wB /= wSum;
    const r = theme.cTL[0] * wTL + theme.cTR[0] * wTR + theme.cB[0] * wB;
    const g = theme.cTL[1] * wTL + theme.cTR[1] * wTR + theme.cB[1] * wB;
    const b = theme.cTL[2] * wTL + theme.cTR[2] * wTR + theme.cB[2] * wB;
    return [r, g, b];
}

type Props = {
    value: string;
    onChange: (next: string) => void;
    onSubmit: (final: string) => void;
    onClose: () => void;
    /** When false, the keyboard's window keydown listener stops
     *  intercepting nav / activation keys (the page or TileGrid owns
     *  them). The keyboard still renders + shows its current cursor
     *  position so the kid sees where they'll return to on
     *  ArrowLeft from the leftmost grid column. */
    focused: boolean;
    /** Fired on ArrowRight from the rightmost column (col 6). The
     *  parent typically hands focus to the leftmost grid tile. */
    onExitRight: () => void;
    /** Fired on ArrowUp from the top row (row 1). The parent typically
     *  hands focus to the search input above. The keyboard itself
     *  stays open. */
    onExitUp: () => void;
};

export default function Keyboard({
    value,
    onChange,
    onSubmit,
    onClose,
    focused,
    onExitRight,
    onExitUp,
}: Props) {
    // Default focus: row 1 col 1 = "A". Track by key index for cheap
    // refs; `pos` is the (row, col) we use for navigation math.
    const [pos, setPos] = useState<{ row: number; col: number }>({
        row: 1,
        col: 1,
    });
    const posRef = useRef(pos);
    posRef.current = pos;
    const valueRef = useRef(value);
    valueRef.current = value;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const onExitRightRef = useRef(onExitRight);
    onExitRightRef.current = onExitRight;
    const onExitUpRef = useRef(onExitUp);
    onExitUpRef.current = onExitUp;
    const focusedRef = useRef(focused);
    focusedRef.current = focused;

    // Theme is captured once per keyboard open via useRef so it stays
    // stable through re-renders. New random pick on next open (when
    // the component mounts again).
    const themeRef = useRef<Theme | null>(null);
    if (themeRef.current === null) {
        themeRef.current = pickTheme();
    }
    const theme = themeRef.current;

    // Held-Backspace state. lastEventAt tracks the most recent
    // keydown so we can tell tap-bursts from a real hold; lastFireAt
    // gates how often we actually commit.
    const backspaceHoldRef = useRef<{
        lastEventAt: number;
        lastFireAt: number;
    } | null>(null);

    // Resolve the key currently focused at (row, col). For span keys
    // (BACK, SPACE) every covered cell maps to the same key index.
    const focusedKeyIdx = OCCUPANCY[pos.row - 1][pos.col - 1];
    const focusedKey = KEYS[focusedKeyIdx];

    // Move within the grid. dRow/dCol are the desired step; we walk
    // the occupancy matrix until we leave the current key's footprint
    // (so ArrowDown from BACK skips its row-2 cell and lands on
    // CLEAR). On edge: ArrowRight off col 6 hands off to onExitRight,
    // ArrowUp off row 1 hands off to onExitUp, and the rest clamp
    // (ArrowLeft / ArrowDown stay inside the keyboard - there's
    // nothing on those sides of the panel). The (row, col) tracked
    // here is the kid's logical cursor: preserving col across span
    // keys (SPACE covers all 6 cols of row 6) means ArrowDown from
    // "W" lands on SPACE then on "3", not on "1". The focused-cell
    // render still highlights the entire span.
    const move = useCallback((dRow: number, dCol: number) => {
        const cur = posRef.current;
        const curIdx = OCCUPANCY[cur.row - 1][cur.col - 1];
        let r = cur.row;
        let c = cur.col;
        while (true) {
            r += dRow;
            c += dCol;
            if (r < 1 || r > ROWS || c < 1 || c > COLS) {
                // Edge. Hand off to the parent on right + up; clamp
                // on left + down.
                if (dCol > 0) {
                    onExitRightRef.current();
                } else if (dRow < 0) {
                    onExitUpRef.current();
                }
                return;
            }
            const idx = OCCUPANCY[r - 1][c - 1];
            if (idx !== curIdx) {
                setPos({ row: r, col: c });
                return;
            }
        }
    }, []);

    const commitChar = useCallback((s: string) => {
        onChangeRef.current(valueRef.current + s);
    }, []);

    const commitBackspace = useCallback(() => {
        const v = valueRef.current;
        if (v.length === 0) return;
        onChangeRef.current(v.slice(0, -1));
    }, []);

    const commitClear = useCallback(() => {
        if (valueRef.current.length === 0) return;
        onChangeRef.current("");
    }, []);

    const commitDone = useCallback(() => {
        onSubmitRef.current(valueRef.current);
    }, []);

    const activate = useCallback(() => {
        const k = KEYS[OCCUPANCY[posRef.current.row - 1][posRef.current.col - 1]];
        switch (k.kind.kind) {
            case "char":
                commitChar(k.kind.value);
                return;
            case "space":
                commitChar(" ");
                return;
            case "backspace":
                commitBackspace();
                return;
            case "clear":
                commitClear();
                return;
            case "done":
                commitDone();
                return;
        }
    }, [commitChar, commitBackspace, commitClear, commitDone]);

    // Window-level capture-phase listener. Handles every navigation +
    // activation key. preventDefault + stopPropagation across the
    // board so the underlying read-only <input> can't see anything.
    //
    // Gated on `focused`: when the kid has arrowed out of the keyboard
    // (right into the grid, or up into the search input), this
    // listener becomes a no-op so Library / TileGrid own the keys.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Idle when not focused. The keyboard still renders and
            // shows its current cursor, but doesn't intercept keys -
            // grid / chrome handlers run instead.
            if (!focusedRef.current) return;
            const k = e.key;
            // Escape closes the keyboard (desktop testing path).
            // Hardware Back is wired through useProgressiveBack below.
            if (k === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (
                k !== "ArrowLeft" &&
                k !== "ArrowRight" &&
                k !== "ArrowUp" &&
                k !== "ArrowDown" &&
                k !== "Enter" &&
                k !== " "
            ) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            switch (k) {
                case "ArrowLeft":
                    if (e.repeat) return;
                    move(0, -1);
                    return;
                case "ArrowRight":
                    if (e.repeat) return;
                    move(0, 1);
                    return;
                case "ArrowUp":
                    if (e.repeat) return;
                    move(-1, 0);
                    return;
                case "ArrowDown":
                    if (e.repeat) return;
                    move(1, 0);
                    return;
                case "Enter":
                case " ": {
                    const cur = posRef.current;
                    const fk = KEYS[OCCUPANCY[cur.row - 1][cur.col - 1]];
                    // Held Enter on Backspace MAY repeat (intentional -
                    // kids hold Backspace to clear quickly). Use the
                    // PlayerTransport time-since-last-event pattern so
                    // we don't depend on e.repeat.
                    if (fk.kind.kind === "backspace") {
                        const now =
                            typeof performance !== "undefined"
                                ? performance.now()
                                : Date.now();
                        let hold = backspaceHoldRef.current;
                        const isContinuingHold =
                            hold !== null &&
                            now - hold.lastEventAt < REPEAT_GAP_MS;
                        if (!isContinuingHold) {
                            // First press in a fresh tap or hold:
                            // always commit, then start the hold.
                            hold = {
                                lastEventAt: now,
                                lastFireAt: now,
                            };
                            backspaceHoldRef.current = hold;
                            commitBackspace();
                            return;
                        }
                        hold!.lastEventAt = now;
                        if (now - hold!.lastFireAt < REPEAT_THROTTLE_MS) {
                            return;
                        }
                        hold!.lastFireAt = now;
                        commitBackspace();
                        return;
                    }
                    // All other keys: held Enter must NOT re-fire. The
                    // only way Enter can fire again is on a fresh tap
                    // (e.repeat=false). Match the OverrideModal /
                    // useLongPressEnter convention.
                    if (e.repeat) return;
                    activate();
                    return;
                }
            }
        };
        // Track keyup to clear the backspace hold so the next tap
        // starts a fresh hold session.
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
                backspaceHoldRef.current = null;
            }
        };
        window.addEventListener("keydown", onKey, { capture: true });
        window.addEventListener("keyup", onKeyUp, { capture: true });
        return () => {
            window.removeEventListener("keydown", onKey, { capture: true });
            window.removeEventListener("keyup", onKeyUp, { capture: true });
        };
    }, [move, activate, commitBackspace]);

    // Route hardware Back through onClose, but only when the kid is
    // focused on the keyboard. When focus has moved into the grid
    // (keyboard still open, sitting as a sibling pane), Library's back
    // handler should fire instead - it returns focus to the search
    // input rather than closing the keyboard.
    useProgressiveBack(
        useCallback(() => {
            if (!focusedRef.current) return false;
            onCloseRef.current();
            return true;
        }, []),
    );

    // Suppress lint for unused `value` (we keep it as a controlled
    // prop so the parent owns truth; the keyboard reads it via
    // valueRef inside the listener).
    void value;

    // Pre-compute each key's color once per render. Cheap (44 keys)
    // and lets KeyboardKey stay memoized on simple props.
    const keyStyles = useMemo(() => {
        return KEYS.map((k) => {
            const rgb = cellColor(theme, k.row - 1, k.col - 1);
            return {
                color: rgbToCss(rgb, 1),
                colorMuted: rgbToCss(rgb, 0.55),
            };
        });
    }, [theme]);

    // Render inline (no portal). The keyboard is now a real layout
    // child of Library: it sits in its own column and pushes the grid
    // to the right rather than overlaying it. The parent positions
    // the wrap; we just render the card + cells.
    const wrapClass =
        "kids-keyboard-wrap" + (focused ? " kids-keyboard-focused" : "");
    return (
        <div className={wrapClass} role="dialog" aria-label="Keyboard">
            <div className="kids-keyboard-card">
                <div className="kids-keyboard-grid">
                    {KEYS.map((k, idx) => {
                        const focusedCell = focusedKey.id === k.id;
                        const style = keyStyles[idx];
                        return (
                            <KeyboardKey
                                key={k.id}
                                kind={k.kind.kind}
                                label={labelFor(k.kind)}
                                row={k.row}
                                col={k.col}
                                rowSpan={k.rowSpan}
                                colSpan={k.colSpan}
                                color={style.color}
                                colorMuted={style.colorMuted}
                                focused={focusedCell}
                            />
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

function labelFor(k: KeyKind): string {
    switch (k.kind) {
        case "char":
            return k.label;
        case "space":
            return "Space";
        case "backspace":
            return "Backspace";
        case "clear":
            return "Clear";
        case "done":
            return "Done";
    }
}

type KeyProps = {
    kind: KeyKind["kind"];
    label: string;
    row: number;
    col: number;
    rowSpan: number;
    colSpan: number;
    color: string;
    colorMuted: string;
    focused: boolean;
};

// Each key is React.memo'd on the small set of value-typed props
// above. With ~44 keys this gates re-render cost to only the two
// keys whose focus state flipped on each arrow press, which matters
// on the slow Skyworth WebView.
const KeyboardKey = memo(
    function KeyboardKey({
        kind,
        label,
        row,
        col,
        rowSpan,
        colSpan,
        color,
        colorMuted,
        focused,
    }: KeyProps) {
        const cls =
            "kids-keyboard-key " +
            `kids-keyboard-key-${kind}` +
            (focused ? " focused" : "");
        // Inline grid placement + per-cell color. The CSS picks up
        // --kb-color (and --kb-color-muted) for letter color, border,
        // and the focused fill. Inline style is the cheapest way to
        // pass a per-instance color into shared CSS rules without
        // generating a unique class per key.
        const style: React.CSSProperties = {
            gridRow: `${row} / span ${rowSpan}`,
            gridColumn: `${col} / span ${colSpan}`,
            ["--kb-color" as string]: color,
            ["--kb-color-muted" as string]: colorMuted,
        };
        return (
            <span
                className={cls}
                style={style}
                aria-label={label}
                aria-selected={focused}
            >
                {renderKeyContent(kind, label)}
            </span>
        );
    },
    (prev, next) =>
        prev.kind === next.kind &&
        prev.label === next.label &&
        prev.row === next.row &&
        prev.col === next.col &&
        prev.rowSpan === next.rowSpan &&
        prev.colSpan === next.colSpan &&
        prev.color === next.color &&
        prev.colorMuted === next.colorMuted &&
        prev.focused === next.focused,
);

// Render the visible content of a key. Char cells show the label;
// action keys show a Phosphor icon. Space is a special case: a
// horizontal bracket-bar shape drawn in CSS with the word "SPACE"
// centered inside the plate, mimicking a spacebar at TV scale.
function renderKeyContent(kind: KeyKind["kind"], label: string) {
    switch (kind) {
        case "char":
            return label;
        case "space":
            // Label first, bar second: with the parent flex column
            // these stack as SPACE on top, bracket below. The plate
            // mimics a keycap with its legend above the spacebar.
            return (
                <span className="kids-keyboard-space-glyph" aria-hidden>
                    <span className="kids-keyboard-space-label">SPACE</span>
                    <span className="kids-keyboard-space-bar" />
                </span>
            );
        case "backspace":
            return (
                <BackspaceIcon
                    weight="bold"
                    size="1.9em"
                    aria-hidden
                />
            );
        case "clear":
            return <Eraser weight="bold" size="1.9em" aria-hidden />;
        case "done":
            return (
                <CheckCircle weight="fill" size="1.9em" aria-hidden />
            );
    }
}
