import { useEffect } from "react";

// useProgressiveBack lets a page register a back handler that's
// called from the Android Kotlin bridge BEFORE any WebView history
// pop. The Kotlin onKeyDown override evaluates
// `window.__jellybeanBack()` and only falls through to its default
// behavior (webView.goBack / Activity.finish) when the JS handler
// returns false.
//
// Why not history.pushState sentinels (the old approach)?  WebView
// history can be ambiguous on cheap Android TV builds - sentinels
// pile up across navigation, popstate ordering races with React
// Router's URL transitions, and a single back press can pop past
// where we expected. The bridge-driven approach is deterministic:
// JS handles or it doesn't. The browser's history doesn't move
// unless we explicitly nav.
//
// Browser fallback: when there's no Kotlin shell (running in a
// regular browser, e.g. admin preview), we install a popstate
// listener with a sentinel as a best-effort mimic. The shell
// path is the supported one.

type BackHandler = () => boolean;

declare global {
    interface Window {
        __jellybeanBack?: BackHandler;
    }
}

const stack: BackHandler[] = [];

function topHandler(): BackHandler | null {
    return stack.length > 0 ? stack[stack.length - 1] : null;
}

function bridgeHandler(): boolean {
    const handler = topHandler();
    if (!handler) return false;
    try {
        return handler();
    } catch {
        return false;
    }
}

if (typeof window !== "undefined" && !window.__jellybeanBack) {
    window.__jellybeanBack = bridgeHandler;
}

export function useProgressiveBack(handler: BackHandler): void {
    useEffect(() => {
        stack.push(handler);
        return () => {
            const idx = stack.lastIndexOf(handler);
            if (idx >= 0) stack.splice(idx, 1);
        };
    }, [handler]);

    // Browser fallback: when the Kotlin bridge isn't present,
    // pushState a sentinel so popstate fires on the user's back
    // press. Detect bridge presence by JellybeanShell's existence.
    useEffect(() => {
        const hasShell =
            typeof window !== "undefined" &&
            typeof (window as unknown as {
                JellybeanShell?: unknown;
            }).JellybeanShell !== "undefined";
        if (hasShell) return;
        try {
            window.history.pushState({ __jellybeanSentinel: true }, "");
        } catch {
            return;
        }
        const onPop = () => {
            const consumed = handler();
            if (consumed) {
                try {
                    window.history.pushState({ __jellybeanSentinel: true }, "");
                } catch {
                    /* ignore */
                }
            }
        };
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, [handler]);
}
