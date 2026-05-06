import { useMemo, useRef, useLayoutEffect } from "react";

// AlphaBar is the vertical A-Z jumpscroll strip pinned to the right
// of the Library grid. Selected letter stays at the vertical center
// of the bar - the strip slides via translateY so the kid's eye-line
// stays anchored as they D-pad up and down. Letters with no library
// items render dimmed and unfocusable.
//
// Parent owns focus state; AlphaBar renders focusable buttons and
// receives refs for imperative .focus() calls.

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
    const trackRef = useRef<HTMLDivElement | null>(null);
    const letterEls = useRef<(HTMLButtonElement | null)[]>([]);

    // Slide the inner track so the focused letter is at the visual
    // center of the bar's viewport. Run synchronously after layout
    // (useLayoutEffect) so the kid never sees a flash at the wrong
    // position between focus change and slide.
    useLayoutEffect(() => {
        if (focusedIndex === null) return;
        const track = trackRef.current;
        const target = letterEls.current[focusedIndex];
        if (!track || !target) return;
        const wrap = track.parentElement;
        if (!wrap) return;
        // Center the focused button inside the viewport.
        const wrapH = wrap.clientHeight;
        const targetCenter = target.offsetTop + target.offsetHeight / 2;
        const offset = wrapH / 2 - targetCenter;
        track.style.transform = `translateY(${offset}px)`;
    }, [focusedIndex]);

    return (
        <div className="library-alpha-bar-wrap" aria-hidden={focusedIndex === null}>
            <nav
                ref={trackRef}
                className="library-alpha-bar"
                aria-label="Jump to letter"
            >
                {ALPHABET.map((letter, i) => {
                    const itemIdx = indexMap[letter];
                    const enabled = itemIdx !== undefined;
                    const focused = focusedIndex === i;
                    return (
                        <button
                            key={letter}
                            ref={(el) => {
                                letterEls.current[i] = el;
                                letterRef(i, el);
                            }}
                            type="button"
                            className={`library-alpha-letter ${enabled ? "" : "disabled"} ${focused ? "focused" : ""}`}
                            // Don't use the disabled attribute - imperative
                            // .focus() is a no-op on disabled buttons, which
                            // breaks D-pad navigation. We gate clicks via
                            // the indexMap check instead.
                            tabIndex={focused ? 0 : -1}
                            onClick={() => {
                                if (itemIdx !== undefined) {
                                    onLetterClick(letter, itemIdx);
                                }
                            }}
                            aria-label={`Jump to ${letter}`}
                            aria-disabled={!enabled}
                        >
                            {letter}
                        </button>
                    );
                })}
            </nav>
        </div>
    );
}
