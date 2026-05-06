import { useEffect } from "react";

// useProgressiveBack lets a page consume the Android TV Back press to
// reset focus before the next press actually backs out of the page.
//
// On mount the hook pushes a "sentinel" history entry with the same
// URL as the current page. The Android Back button maps to
// history.back() in the WebView, which pops the sentinel and fires
// popstate. The page-level handler decides whether the back is
// "consumed" (e.g. focus moves to the first tile, modal closes) and
// re-pushes the sentinel to keep the absorption alive, OR returns
// false to let the browser actually back out of the page.
//
// Limitations: in the rare nested-popstate case (rapid backs across
// route boundaries) the handler may miss one press. The simplest
// fallback is "the user presses back twice." Good enough for the
// Skyworth's input pace.

type BackHandler = () => boolean;

const SENTINEL = { __jellybeanSentinel: true };

export function useProgressiveBack(handler: BackHandler): void {
    useEffect(() => {
        // Push the sentinel so the next browser-back lands here and
        // fires popstate without leaving the page.
        try {
            window.history.pushState(SENTINEL, "");
        } catch {
            return;
        }
        const onPop = () => {
            const consumed = handler();
            if (consumed) {
                // Re-arm: another sentinel so the next back also pops
                // here. Without this the URL is at "origin" and the
                // next back exits the WebView.
                try {
                    window.history.pushState(SENTINEL, "");
                } catch {
                    /* ignore */
                }
            }
            // If !consumed, popstate has already happened. The page is
            // at its top-level escape state; the next back press will
            // run the browser's default behavior (Activity.finish on
            // the kid TV when the history stack is empty).
        };
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, [handler]);
}
