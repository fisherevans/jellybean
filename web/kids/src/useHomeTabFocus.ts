import { useCallback, useEffect, useRef, useState } from "react";

// useHomeTabFocus codifies the "back-then-down" focus contract that
// every kid home tab (Browse / Library / Tags) used to inline by
// hand. Pulling it into a single hook prevents one page's reset
// from drifting out of sync with the others, and makes the test
// contract in `kids_back_focus.spec.ts` apply automatically to any
// future home tab.
//
// What the hook owns:
//
//   1. `focus` state machine, generic on the page's Focus union.
//      The hook just provides storage + setter; pages still own
//      transitions (D-pad keydown, mouse onFocus, etc.).
//
//   2. Optional `tabNav` integration with KidsHome. When provided,
//      the hook installs the standard "tabFocused → true" effect:
//      snap scroll to top + blur DOM focus so the previously-focused
//      tile doesn't keep its `:focus` pseudo-class. Pages outside
//      KidsHome (e.g. TagDetail) omit `tabNav` and skip this effect.
//
//   3. `handleBack`: a helper that pages call inside their own
//      `useProgressiveBack` callback after the modal / open-popup
//      ladder has run. It does the load-bearing reset:
//          - setTabFocused(true)
//          - setFocus(getFirstContentSlot())
//          - onTabReset?()  (wipes per-page row/column memory)
//      All in a single render so the focus DOM-management effect
//      doesn't see stale focus state and re-focus the previous tile
//      before the reset commits.  See web/kids/CLAUDE.md
//      ("Back-then-Down focus contract") for why this has to happen
//      together rather than across separate effects.
//
// Pages outside KidsHome (TagDetail) can use the hook for `focus` /
// `setFocus` storage only - `tabFocused` is hardcoded to false,
// `setTabFocused` is a no-op, and `handleBack` skips the tab handoff.

export type UseHomeTabFocusOptions<F> = {
    /** Initial focus value used by `useState`. */
    initialFocus: F;
    /**
     * Returns the "first content slot" for this page - the focus
     * value the hook should reset to on Back. For Library that's
     * `{kind: "search"}`; for Browse `{kind: "tile", row: 0, col: 0}`;
     * for Tags `0` (Tags uses a flat index, not a discriminated
     * union).
     */
    getFirstContentSlot: () => F;
    /**
     * Optional reset callback the back handler runs to wipe per-page
     * focus memory (e.g. `rowColMemoryRef.current.clear()`,
     * `prevFocusRowRef.current = null`). Runs synchronously inside
     * `handleBack` before it returns true.
     */
    onTabReset?: () => void;
    /**
     * Optional "scroll to top" routine called when `tabFocused` flips
     * from false to true. Browse passes `(snap = true) => setStackY(0,
     * snap)`; Library/Tags pass `() => stack.setStackY(0, true)`.
     */
    scrollToTop?: () => void;
    /**
     * KidsHome integration. Pass the values from `useKidsHome()` when
     * this page is rendered inside the KidsHome layout. Omit for
     * pages outside KidsHome (e.g. TagDetail) - the hook then skips
     * the tabFocused effect and `handleBack` just resets focus
     * without touching tab nav.
     */
    tabNav?: {
        tabFocused: boolean;
        setTabFocused: (b: boolean) => void;
    };
};

export type UseHomeTabFocusResult<F> = {
    focus: F;
    setFocus: React.Dispatch<React.SetStateAction<F>>;
    /** Always false when `tabNav` is omitted. */
    tabFocused: boolean;
    /** No-op when `tabNav` is omitted. */
    setTabFocused: (b: boolean) => void;
    /**
     * Back-press handler for the standard "fall through to tab nav"
     * step. Pages call this inside their `useProgressiveBack`
     * callback AFTER any modal / open-popup checks have run. Returns
     * true if Back was consumed (always when `tabNav` is provided
     * and the kid was inside content; never when on tab nav so the
     * caller falls through to history.back()).
     */
    handleBack: () => boolean;
};

export function useHomeTabFocus<F>(
    opts: UseHomeTabFocusOptions<F>,
): UseHomeTabFocusResult<F> {
    const {
        initialFocus,
        getFirstContentSlot,
        onTabReset,
        scrollToTop,
        tabNav,
    } = opts;

    const [focus, setFocus] = useState<F>(initialFocus);

    // Stash the latest callbacks in refs so the hook's effects + the
    // returned handleBack don't need to re-bind every time the page
    // closes over fresh values. Pages typically pass fresh closures
    // for `getFirstContentSlot` / `onTabReset` / `scrollToTop`; if
    // we depended on their identity, every render would tear down
    // and reinstall the tabFocused effect.
    const getFirstContentSlotRef = useRef(getFirstContentSlot);
    getFirstContentSlotRef.current = getFirstContentSlot;
    const onTabResetRef = useRef(onTabReset);
    onTabResetRef.current = onTabReset;
    const scrollToTopRef = useRef(scrollToTop);
    scrollToTopRef.current = scrollToTop;

    const tabFocused = tabNav?.tabFocused ?? false;
    const setTabFocused = tabNav?.setTabFocused ?? noop;
    const setTabFocusedRef = useRef(setTabFocused);
    setTabFocusedRef.current = setTabFocused;

    // tabFocused → true effect: snap scroll to top + blur whatever
    // tile/button still has DOM focus so its `:focus` pseudo clears.
    // Skipped when tabNav is omitted (page outside KidsHome).
    //
    // hasTabNav is captured as a primitive boolean so a fresh tabNav
    // object on every render doesn't re-fire the effect; the page
    // either always has a tab nav or always doesn't.
    const hasTabNav = !!tabNav;
    useEffect(() => {
        if (!hasTabNav) return;
        if (!tabFocused) return;
        scrollToTopRef.current?.();
        if (
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body
        ) {
            document.activeElement.blur();
        }
    }, [tabFocused, hasTabNav]);

    // Stash the live `tabFocused` in a ref so handleBack can read
    // the current value without taking it as a useCallback dep -
    // tabNav is a fresh object every render, and we don't want
    // handleBack's identity to thrash (callers pass it into
    // useProgressiveBack which re-installs its effect on identity
    // change).
    const tabFocusedRef = useRef(tabFocused);
    tabFocusedRef.current = tabFocused;

    const handleBack = useCallback((): boolean => {
        if (hasTabNav) {
            if (tabFocusedRef.current) return false;
            setTabFocusedRef.current(true);
            setFocus(getFirstContentSlotRef.current());
            onTabResetRef.current?.();
            return true;
        }
        // Page outside KidsHome (TagDetail). Caller's progressive-
        // back ladder handles modals; if it asks the hook, we just
        // reset focus to the first content slot. TagDetail navigates
        // away in its own back path before reaching this branch, so
        // this is mostly a no-op safety net.
        setFocus(getFirstContentSlotRef.current());
        onTabResetRef.current?.();
        return true;
    }, [hasTabNav]);

    return {
        focus,
        setFocus,
        tabFocused,
        setTabFocused,
        handleBack,
    };
}

function noop() {}
