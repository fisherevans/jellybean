import { useEffect } from "react";

// Cross-component "an item just got hidden by the parent" signal.
// Emitted by OverrideModal's HideConfirmView on a successful
// /api/kids/override/items/{id}/hide. Pages subscribe via
// `useItemHiddenEvent(callback)` and prune the item from their
// in-memory state + any local caches that would otherwise show a
// ghost on next mount.
//
// Why an event instead of a callback prop: the override modal
// can be opened from Library / Browse / TagDetail / Watch /
// Tags, and the active page is independent of where the modal
// was opened from. A window-level event lets every page that
// happens to be mounted react without prop plumbing.

const EVENT_NAME = "jellybean:item-hidden";

type Detail = { itemId: string };

export function useItemHiddenEvent(handler: (itemId: string) => void): void {
    useEffect(() => {
        const listener = (e: Event) => {
            const detail = (e as CustomEvent<Detail>).detail;
            if (detail?.itemId) handler(detail.itemId);
        };
        window.addEventListener(EVENT_NAME, listener);
        return () => window.removeEventListener(EVENT_NAME, listener);
        // Caller passes a stable function (most consumers use a
        // useCallback or a module-level reference).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}
