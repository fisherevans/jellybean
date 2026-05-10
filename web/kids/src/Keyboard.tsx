import {
    memo,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";
import { useProgressiveBack } from "./useProgressiveBack";

// Keyboard is a D-pad-driven on-screen keyboard for the kids app.
// The Skyworth Android TV's native IME is slow and visually intrusive,
// so search input on Library uses this instead. The component is
// stateless / controlled - the parent owns `value` and the keyboard
// only emits changes via the callbacks.
//
// Navigation:
//   - ArrowLeft / ArrowRight clamp horizontally within a row (no wrap).
//   - ArrowUp / ArrowDown clamp vertically between rows (no wrap). When
//     the target row is shorter than the source col, the col snaps to
//     the last valid position.
//   - Enter on a letter / digit appends to value (e.repeat suppressed).
//   - Enter on Space appends a single space.
//   - Enter on Backspace removes the last char; held Backspace repeats
//     at REPEAT_THROTTLE_MS via the time-since-last-event pattern from
//     PlayerTransport.tsx (NOT e.repeat - WebView remote behavior is
//     unreliable there).
//   - Enter on Clear empties value.
//   - Enter on Done calls onSubmit(value).
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

type Row = KeyKind[];

const ROWS: Row[] = [
    "QWERTYUIOP".split("").map((c) => ({ kind: "char", label: c, value: c })),
    "ASDFGHJKL".split("").map((c) => ({ kind: "char", label: c, value: c })),
    "ZXCVBNM".split("").map((c) => ({ kind: "char", label: c, value: c })),
    "0123456789".split("").map((c) => ({ kind: "char", label: c, value: c })),
    [
        { kind: "space" },
        { kind: "backspace" },
        { kind: "clear" },
        { kind: "done" },
    ],
];

// Held-Backspace repeat: 150ms throttle, time-since-last-event based
// (matches the seek-hold pattern from PlayerTransport.tsx:171). e.repeat
// is unreliable on this WebView - Android TV remotes sometimes emit
// streams of repeat=false keydowns instead of toggling repeat. The
// time-since-last-event gate is robust either way: a "real" hold
// produces back-to-back keydowns within ~50ms of each other; a tap
// burst that briefly looks like a hold is bounded by the throttle.
const REPEAT_THROTTLE_MS = 150;
const REPEAT_GAP_MS = 250;

type Props = {
    value: string;
    onChange: (next: string) => void;
    onSubmit: (final: string) => void;
    onClose: () => void;
};

export default function Keyboard({
    value,
    onChange,
    onSubmit,
    onClose,
}: Props) {
    // Default focus on the first letter of the first row. The row+col
    // pair lives in component state so re-renders keep the focused key
    // in sync; the refs below mirror it for the keydown listener so
    // the listener doesn't re-bind on every key press.
    const [pos, setPos] = useState<{ row: number; col: number }>({
        row: 0,
        col: 0,
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

    // Held-Backspace state. lastBackspaceAt tracks the most recent
    // commit; lastEventAt tracks the most recent keydown so we can
    // tell tap-bursts from a real hold.
    const backspaceHoldRef = useRef<{
        lastEventAt: number;
        lastFireAt: number;
    } | null>(null);

    const move = useCallback((dRow: number, dCol: number) => {
        const cur = posRef.current;
        let row = cur.row + dRow;
        // Clamp vertical (no wrap).
        if (row < 0) row = 0;
        if (row >= ROWS.length) row = ROWS.length - 1;
        let col = cur.col + dCol;
        const targetRow = ROWS[row];
        // When stepping vertically, the source col may be past the
        // target row's length (e.g. col 9 jumping from "QWERTYUIOP"
        // into the 4-key controls row). Snap to last valid col.
        if (dRow !== 0) {
            col = cur.col;
            if (col >= targetRow.length) col = targetRow.length - 1;
        }
        // Clamp horizontal (no wrap). Same rule for both directions.
        if (col < 0) col = 0;
        if (col >= targetRow.length) col = targetRow.length - 1;
        setPos({ row, col });
    }, []);

    const commitChar = useCallback((ch: string) => {
        onChangeRef.current(valueRef.current + ch);
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
        const cur = posRef.current;
        const k = ROWS[cur.row][cur.col];
        switch (k.kind) {
            case "char":
                commitChar(k.value);
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
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            // Back closes the keyboard. Don't preventDefault here - if
            // the page has nothing else to consume the back, the
            // useProgressiveBack hook will route it through the bridge.
            // We just intercept Escape (desktop testing) directly.
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
                    const focusedKey = ROWS[cur.row][cur.col];
                    // Held Enter on Backspace MAY repeat (intentional -
                    // kids hold Backspace to clear quickly). Use the
                    // PlayerTransport time-since-last-event pattern so
                    // we don't depend on e.repeat.
                    if (focusedKey.kind === "backspace") {
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

    // Route hardware Back through onClose. The Library's own back
    // handler runs after this one returns false, so the page falls
    // through to its existing back ladder once we've consumed the
    // keyboard close.
    useProgressiveBack(
        useCallback(() => {
            onCloseRef.current();
            return true;
        }, []),
    );

    return createPortal(
        <div className="kids-keyboard-wrap" role="dialog" aria-label="Keyboard">
            <div className="kids-keyboard-card">
                <div className="kids-keyboard-preview" aria-live="polite">
                    {value.length === 0 ? (
                        <span className="kids-keyboard-preview-placeholder">
                            Type to search
                        </span>
                    ) : (
                        value
                    )}
                </div>
                <div className="kids-keyboard-rows">
                    {ROWS.map((row, rIdx) => (
                        <div key={rIdx} className="kids-keyboard-row">
                            {row.map((k, cIdx) => {
                                const focused =
                                    pos.row === rIdx && pos.col === cIdx;
                                return (
                                    <KeyboardKey
                                        key={keyId(k, cIdx)}
                                        kind={k.kind}
                                        label={labelFor(k)}
                                        focused={focused}
                                    />
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </div>,
        document.body,
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

function keyId(k: KeyKind, col: number): string {
    switch (k.kind) {
        case "char":
            return `c:${k.value}`;
        case "space":
            return "ctrl:space";
        case "backspace":
            return "ctrl:bs";
        case "clear":
            return "ctrl:clr";
        case "done":
            return "ctrl:done";
        default:
            return `pos:${col}`;
    }
}

type KeyProps = {
    kind: KeyKind["kind"];
    label: string;
    focused: boolean;
};

// Each key is React.memo'd on (kind, label, focused). Callback
// identity is intentionally absent from the props - clicks go
// nowhere (D-pad only) and all activation flows through the window
// keydown handler. With ~50 keys this gates re-render cost to only
// the two keys whose focus state flipped on each arrow press, which
// matters on the slow Skyworth WebView.
const KeyboardKey = memo(
    function KeyboardKey({ kind, label, focused }: KeyProps) {
        const cls =
            "filter-pill kids-keyboard-key " +
            `kids-keyboard-key-${kind}` +
            (focused ? " focused" : "");
        return (
            <span className={cls} aria-label={label} aria-selected={focused}>
                {label}
            </span>
        );
    },
    (prev, next) =>
        prev.kind === next.kind &&
        prev.label === next.label &&
        prev.focused === next.focused,
);
