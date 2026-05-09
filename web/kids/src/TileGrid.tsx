import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";

// TileGrid is the shared sectioned-grid composable for Library and
// TagDetail. Both pages render the same layout shape:
//
//   <header chrome>            (page-owned)
//   <section title?>           (per section)
//     <grid> tile, tile, ... </grid>
//   ...repeat per section...
//   <footer slot>              (page-owned, e.g. Library load-more)
//
// What TileGrid owns:
//   - Section + grid DOM + tile refs (keyed by sectionIdx:itemIdx).
//   - useGridColumns: reads `grid-template-columns` from computed style
//     to derive the real track count (handles the "Added today: 1
//     item" case where children-sharing-offsetTop would falsely report
//     1 column).
//   - Window keydown listener that handles Up/Down/Left/Right between
//     cells, with section transitions on row 0 / last row. Gated on
//     `enabled`.
//   - Imperative `refs[s][i].focus()` after focus changes, with
//     scroll-to-top for the first row of section 0 and
//     scroll-to-center elsewhere.
//
// What TileGrid does NOT own:
//   - Enter activation (handled by `useLongPressEnter` at the page).
//   - The page's chrome (search wrap, filter / sort dropdowns, back
//     button) and how Up off section 0 row 0 hands off to chrome -
//     that's the `onExitTop` callback.
//   - Load-more fetch logic. The page can render its sentinel via
//     the `footer` slot.
//
// Browse is intentionally NOT a consumer here - it's row-virtualized
// with a transform-driven horizontal animator per row, which is a
// different beast.

export type GridFocus = { sectionIdx: number; itemIdx: number };

export type GridSection<T> = {
    /** Stable section id. Used as a React key prefix. */
    id: string;
    /** Optional section title rendered above the grid. Library's
     *  flat A-Z mode passes a single section with no label. */
    label?: string;
    items: T[];
};

export type TileGridProps<T> = {
    /** Items in iteration order. Used when `sections` is omitted to
     *  render a flat grid; ignored when `sections` is provided. */
    items: T[];
    /** Section breakdown when the grid is sectioned (alphabetical or
     *  date-bucket sections). When omitted, renders as a flat grid
     *  derived from `items`. */
    sections?: GridSection<T>[];
    /** Cell renderer: gets the item + focus state + a ref callback
     *  to attach to the focusable element. The returned element must
     *  carry a stable React `key` (TileGrid iterates without wrapping
     *  the cell in an extra node). */
    renderCell: (
        item: T,
        focused: boolean,
        refCallback: (el: HTMLElement | null) => void,
        ctx: { sectionIdx: number; itemIdx: number },
    ) => ReactNode;
    /** Page-side focus: pages own their focus union; when the kid is
     *  on a chrome control (search / filter / etc.), pass null. */
    focus: GridFocus | null;
    onFocusChange: (f: GridFocus) => void;
    /** Fired when the kid presses ArrowUp on section 0 row 0. Pages
     *  use this to hand focus back to chrome (search wrap on Library,
     *  back button on TagDetail). */
    onExitTop: () => void;
    /** Window keydown listener gating. Pages should pass false while
     *  modals are open. When false, TileGrid still renders + scrolls
     *  but doesn't intercept keys. (TileGrid additionally idles its
     *  listener whenever `focus` is null, so chrome focus suppresses
     *  it automatically.) */
    enabled: boolean;
    /** Scroll callbacks. TileGrid calls scrollToTop when focus lands
     *  on the first row of section 0 and scrollToCenter on the
     *  focused cell otherwise; pages provide these from
     *  useStackScroll. */
    scrollToTop: () => void;
    scrollToCenter: (el: HTMLElement) => void;
    /** Optional CSS class applied to each `.grid` element. TagDetail
     *  uses this to add `kids-tag-detail-grid` for its margin tweaks. */
    gridClassName?: string;
    /** Optional content rendered after the last section. Library uses
     *  this for the IntersectionObserver sentinel + "Loading more..."
     *  state. */
    footer?: ReactNode;
};

export default function TileGrid<T>({
    items,
    sections,
    renderCell,
    focus,
    onFocusChange,
    onExitTop,
    enabled,
    scrollToTop,
    scrollToCenter,
    gridClassName,
    footer,
}: TileGridProps<T>) {
    const refs = useRef<Record<string, HTMLElement | null>>({});
    const sectionGridRefs = useRef<(HTMLDivElement | null)[]>([]);
    // Synthesize a single unlabeled section from `items` when the
    // page hasn't sectioned the data.
    const effectiveSections = useMemo<GridSection<T>[]>(() => {
        if (sections) return sections;
        if (items.length === 0) return [];
        return [{ id: "all", items }];
    }, [sections, items]);
    const columns = useGridColumns(sectionGridRefs, effectiveSections);

    // Imperative focus + scroll on focus change.
    useEffect(() => {
        if (!focus) return;
        const key = focusKey(focus);
        const el = refs.current[key];
        if (!el) return;
        el.focus({ preventScroll: true });
        const onFirstRow =
            focus.sectionIdx === 0 && focus.itemIdx < Math.max(1, columns);
        if (onFirstRow) {
            scrollToTop();
        } else {
            scrollToCenter(el);
        }
    }, [focus, columns, scrollToTop, scrollToCenter]);

    // Window keydown for inner grid nav. Gated on `enabled` and a
    // non-null grid focus. Pages keep their own listener for chrome
    // controls; the two listeners coexist because they target disjoint
    // active-focus regions (chrome vs. grid).
    const lastMoveRef = useRef(0);
    const REPEAT_MIN_MS = 90;
    useEffect(() => {
        if (!enabled || !focus) return;
        const handler = (e: KeyboardEvent) => {
            const k = e.key;
            if (
                k !== "ArrowLeft" &&
                k !== "ArrowRight" &&
                k !== "ArrowUp" &&
                k !== "ArrowDown"
            ) {
                return;
            }
            // Don't fight an active text input. Library's search box
            // is chrome-side, but defensively bail if focus somehow
            // lands on an input while grid focus is active.
            const target = e.target as HTMLElement | null;
            if (target?.tagName === "INPUT") return;
            e.preventDefault();
            if (e.repeat) {
                const now = performance.now();
                if (now - lastMoveRef.current < REPEAT_MIN_MS) return;
                lastMoveRef.current = now;
            } else {
                lastMoveRef.current = performance.now();
            }
            const next = moveGrid(focus, k, effectiveSections, columns);
            if (next === "exitTop") {
                onExitTop();
                return;
            }
            if (
                next.sectionIdx !== focus.sectionIdx ||
                next.itemIdx !== focus.itemIdx
            ) {
                onFocusChange(next);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [enabled, focus, effectiveSections, columns, onExitTop, onFocusChange]);

    return (
        <>
            {effectiveSections.map((s, sIdx) => (
                <section
                    key={s.id}
                    className="kids-section"
                    aria-label={s.label ?? "Items"}
                >
                    {s.label && (
                        <h2 className="kids-section-title">{s.label}</h2>
                    )}
                    <div
                        className={`grid${gridClassName ? ` ${gridClassName}` : ""}`}
                        ref={(el) => (sectionGridRefs.current[sIdx] = el)}
                    >
                        {s.items.map((it, i) => {
                            const key = `${sIdx}:${i}`;
                            const isFoc =
                                !!focus &&
                                focus.sectionIdx === sIdx &&
                                focus.itemIdx === i;
                            const refCallback = (el: HTMLElement | null) => {
                                refs.current[key] = el;
                            };
                            return renderCell(it, isFoc, refCallback, {
                                sectionIdx: sIdx,
                                itemIdx: i,
                            });
                        })}
                    </div>
                </section>
            ))}
            {footer}
        </>
    );
}

function focusKey(f: GridFocus): string {
    return `${f.sectionIdx}:${f.itemIdx}`;
}

// moveGrid handles arrow nav within the sectioned grid. Returns
// "exitTop" when ArrowUp at section 0 row 0 wants to hand off to
// chrome above; the page wires that up via `onExitTop`.
function moveGrid<T>(
    f: GridFocus,
    key: string,
    sections: GridSection<T>[],
    columns: number,
): GridFocus | "exitTop" {
    const cols = Math.max(1, columns);
    const sec = sections[f.sectionIdx];
    if (!sec) return f;
    const len = sec.items.length;
    const i = f.itemIdx;
    const col = i % cols;
    const rowInSec = Math.floor(i / cols);
    if (key === "ArrowLeft") {
        if (col === 0) return f;
        return { sectionIdx: f.sectionIdx, itemIdx: i - 1 };
    }
    if (key === "ArrowRight") {
        if (col + 1 >= cols || i + 1 >= len) return f;
        return { sectionIdx: f.sectionIdx, itemIdx: i + 1 };
    }
    if (key === "ArrowDown") {
        // Within section: advance to the next row even if it's the
        // partial tail. Clamp the column to the last item in that row.
        const nextRowStart = (rowInSec + 1) * cols;
        if (nextRowStart < len) {
            const nextRowItems = Math.min(cols, len - nextRowStart);
            const target = Math.min(col, nextRowItems - 1);
            return {
                sectionIdx: f.sectionIdx,
                itemIdx: nextRowStart + target,
            };
        }
        // No next row in this section: hop to first row of next
        // section, clamped to that row's width.
        const nextSec = sections[f.sectionIdx + 1];
        if (nextSec) {
            const firstRowItems = Math.min(cols, nextSec.items.length);
            const target = Math.min(col, firstRowItems - 1);
            return {
                sectionIdx: f.sectionIdx + 1,
                itemIdx: Math.max(0, target),
            };
        }
        return f;
    }
    if (key === "ArrowUp") {
        if (rowInSec > 0) {
            const prevRowStart = (rowInSec - 1) * cols;
            return {
                sectionIdx: f.sectionIdx,
                itemIdx: prevRowStart + col,
            };
        }
        // First row of section: hop to last row of previous section,
        // clamped to that row's width.
        if (f.sectionIdx > 0) {
            const prev = sections[f.sectionIdx - 1];
            const prevLen = prev.items.length;
            const lastRowStart = Math.floor((prevLen - 1) / cols) * cols;
            const lastRowItems = prevLen - lastRowStart;
            const target = Math.min(col, lastRowItems - 1);
            return {
                sectionIdx: f.sectionIdx - 1,
                itemIdx: lastRowStart + Math.max(0, target),
            };
        }
        // First row of first section: hand off upward to chrome.
        return "exitTop";
    }
    return f;
}

// useGridColumns reports the grid track count shared across all
// section grids. Same CSS template = same count.
//
// Reading `getComputedStyle(grid).gridTemplateColumns` is the
// authoritative source: with `grid-template-columns: repeat(auto-fill,
// minmax(170px, 1fr))`, the computed value resolves to a list of
// real px tracks (e.g. "186.4px 186.4px ..."). Counting whitespace-
// separated tokens gives the actual column count regardless of how
// many items the first row has.
//
// The previous implementation counted children sharing offsetTop on
// the first non-empty grid, which broke when sections like "Added
// today" had only one item: that section's first row had 1 child, so
// columns was reported as 1 and Down navigation collapsed to "next
// item" instead of "next row".
function useGridColumns<T>(
    refs: React.MutableRefObject<(HTMLDivElement | null)[]>,
    sections: GridSection<T>[],
): number {
    const [cols, setCols] = useState(4);
    // Depend on a section signature, not identity, so we don't re-run
    // the layout read on every render.
    const sectionsSig = useMemo(
        () => sections.map((s) => s.items.length).join(","),
        [sections],
    );
    useEffect(() => {
        const update = () => {
            const grid = refs.current.find((g) => g && g.children.length > 0);
            if (!grid) return;
            const tpl = window
                .getComputedStyle(grid)
                .gridTemplateColumns.trim();
            if (tpl && tpl !== "none") {
                const tracks = tpl.split(/\s+/).filter(Boolean).length;
                if (tracks > 0) {
                    setCols(tracks);
                    return;
                }
            }
            // Fallback: count children sharing the first child's
            // offsetTop on the largest grid (most likely full first row).
            let best: HTMLDivElement | null = null;
            let bestLen = 0;
            for (const g of refs.current) {
                if (g && g.children.length > bestLen) {
                    best = g;
                    bestLen = g.children.length;
                }
            }
            if (!best) return;
            const first = best.children[0] as HTMLElement;
            const firstTop = first.offsetTop;
            let count = 0;
            for (let i = 0; i < best.children.length; i++) {
                const c = best.children[i] as HTMLElement;
                if (Math.abs(c.offsetTop - firstTop) > 1) break;
                count++;
            }
            if (count > 0) setCols(count);
        };
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, [refs, sectionsSig]);
    return cols;
}
