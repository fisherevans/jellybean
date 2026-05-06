import { useMemo } from "react";

// AlphaBar is the vertical A-Z jumpscroll strip that pins to the
// right of the Library grid. The library page owns focus state -
// AlphaBar just renders the focusable letters and lets the parent
// register refs for imperative focus.
//
// Letters that have at least one item in the visible library are
// rendered as focusable buttons; letters with no items render
// dimmed and unfocusable so the kid never lands on a dead letter.

type Props = {
    items: { Name: string }[];
    // Index into this letters[] array of the currently-focused letter
    // (when the parent's focus model has parked here). null means
    // focus is elsewhere; no letter receives tabIndex=0.
    focusedIndex: number | null;
    onLetterClick: (letter: string, itemIndex: number) => void;
    letterRef: (i: number, el: HTMLButtonElement | null) => void;
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// firstIndexByLetter returns, for each letter, the index in items[]
// of the first item starting with that letter (case-insensitive,
// strips leading articles "The "/"A "/"An "). null when the letter
// has no items.
export function firstIndexByLetter(
    items: { Name: string }[],
): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < items.length; i++) {
        const raw = items[i].Name ?? "";
        const stripped = raw.replace(/^(the|a|an)\s+/i, "");
        const ch = stripped.charAt(0).toUpperCase();
        if (!/[A-Z]/.test(ch)) continue;
        if (out[ch] === undefined) out[ch] = i;
    }
    return out;
}

export default function AlphaBar({
    items,
    focusedIndex,
    onLetterClick,
    letterRef,
}: Props) {
    const indexMap = useMemo(() => firstIndexByLetter(items), [items]);
    return (
        <nav className="library-alpha-bar" aria-label="Jump to letter">
            {ALPHABET.map((letter, i) => {
                const itemIdx = indexMap[letter];
                const enabled = itemIdx !== undefined;
                const focused = focusedIndex === i;
                return (
                    <button
                        key={letter}
                        ref={(el) => letterRef(i, el)}
                        type="button"
                        className={`library-alpha-letter ${enabled ? "" : "disabled"} ${focused ? "focused" : ""}`}
                        disabled={!enabled}
                        tabIndex={focused ? 0 : -1}
                        onClick={() => {
                            if (itemIdx !== undefined) {
                                onLetterClick(letter, itemIdx);
                            }
                        }}
                        aria-label={`Jump to ${letter}`}
                    >
                        {letter}
                    </button>
                );
            })}
        </nav>
    );
}
