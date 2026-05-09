import { useEffect, useRef, useState } from "react";
import { useKidModalArmed } from "./KidModalShell";

// useDpadCursor encapsulates the "vertical (or list-of-buttons)
// cursor" pattern used by every kid-modal that renders a stack of
// activatable items. Owns:
//
//   - integer cursor state with capped Up/Down navigation
//     (no wrap; wrap surprised kids in playtest)
//   - a ref array sized to the option list, indexed by position
//   - imperative DOM-focus on the cursored ref once the modal's
//     KidModalShell flips `armed` true (gates the held-Enter that
//     opened the modal)
//   - a window-level capture-phase keydown listener that handles
//     ArrowUp / ArrowDown / Enter / Space and stopImmediatePropa-
//     gation on each. Escape / Backspace / repeat-Enter are owned
//     by KidModalShell; this hook intentionally doesn't touch them.
//
// AlphaPickerModal is the exception: it has 2-D grid math, so it
// uses this hook only for `register` / focus-on-armed and installs
// its own listener. That's why the listener can be disabled via
// `enabled: false`.
//
// Usage (vertical list):
//
//   const dpad = useDpadCursor({
//       count: options.length,
//       initial: idxOfCurrent,
//       onActivate: (i) => onSelect(options[i].id),
//   });
//   ...
//   <button
//       ref={dpad.register(i)}
//       tabIndex={dpad.cursor === i ? 0 : -1}
//       onFocus={() => dpad.setCursor(i)}
//   >...</button>

type Options = {
    /** Total number of focusable items in the list. */
    count: number;
    /** Starting cursor position. Clamped to [0, count-1]. */
    initial?: number;
    /** Called when the user presses Enter or Space on a cursor
     *  position. */
    onActivate: (index: number) => void;
    /** When false, skip installing the window keydown listener.
     *  Used by AlphaPickerModal which manages its own grid math
     *  but still wants the cursor / refs / focus-on-armed plumbing. */
    enabled?: boolean;
};

export type DpadCursor = {
    cursor: number;
    setCursor: React.Dispatch<React.SetStateAction<number>>;
    register: (i: number) => (el: HTMLElement | null) => void;
    /** Direct ref array - escape hatch for when you need to call
     *  focus() yourself (rarely). */
    refs: React.MutableRefObject<Array<HTMLElement | null>>;
};

export function useDpadCursor({
    count,
    initial = 0,
    onActivate,
    enabled = true,
}: Options): DpadCursor {
    const clampedInitial = Math.max(
        0,
        Math.min(initial, Math.max(0, count - 1)),
    );
    const [cursor, setCursor] = useState(clampedInitial);
    const refs = useRef<Array<HTMLElement | null>>([]);

    const armed = useKidModalArmed();

    const cursorRef = useRef(cursor);
    cursorRef.current = cursor;
    const countRef = useRef(count);
    countRef.current = count;
    const onActivateRef = useRef(onActivate);
    onActivateRef.current = onActivate;

    // Push DOM focus to match the cursor once the modal arms. Pre-
    // arm we leave the cursored button unfocused so a held Enter
    // can't synthesize a click on it.
    useEffect(() => {
        if (!armed) return;
        refs.current[cursor]?.focus({ preventScroll: true });
    }, [cursor, armed]);

    useEffect(() => {
        if (!enabled) return;
        const onKey = (e: KeyboardEvent) => {
            const k = e.key;
            if (
                k !== "ArrowUp" &&
                k !== "ArrowDown" &&
                k !== "Enter" &&
                k !== " " &&
                k !== "ArrowLeft" &&
                k !== "ArrowRight"
            ) {
                return;
            }
            // Pre-arm: KidModalShell already swallows Enter / Space
            // before us, but be defensive in case shell ordering
            // ever changes.
            if ((k === "Enter" || k === " ") && !armed) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            switch (k) {
                case "ArrowUp":
                    setCursor((c) => Math.max(0, c - 1));
                    return;
                case "ArrowDown":
                    setCursor((c) =>
                        Math.min(Math.max(0, countRef.current - 1), c + 1),
                    );
                    return;
                case "ArrowLeft":
                case "ArrowRight":
                    // Vertical list: swallow horizontal navigation
                    // so it can't reach the underlying page /
                    // tab-pill while the modal is open.
                    return;
                case "Enter":
                case " ": {
                    onActivateRef.current(cursorRef.current);
                    return;
                }
            }
        };
        // Re-bind on `armed` change so the listener closes over
        // the latest value without needing a ref. Cheap - this
        // flips exactly once per modal lifetime.
        window.addEventListener("keydown", onKey, { capture: true });
        return () =>
            window.removeEventListener("keydown", onKey, { capture: true });
    }, [enabled, armed]);

    function register(i: number) {
        return (el: HTMLElement | null) => {
            refs.current[i] = el;
        };
    }

    return { cursor, setCursor, register, refs };
}
